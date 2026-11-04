import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, decimalAtomic, hash } from '../server/core.mjs';
import { decodeReferenceTransfer } from '../server/payment-reference.mjs';

const address='0x'+'1'.repeat(40), contract='0x'+'2'.repeat(40);
const registry=[
  {id:'bsc',family:'evm',chainId:56,confirmations:15,tokens:[{id:'bsc-usdt',kind:'token',symbol:'USDT',decimals:18},{id:'bsc-usdc',kind:'token',symbol:'USDC',decimals:18}]},
  {id:'ethereum',family:'evm',chainId:1,confirmations:20,tokens:[{id:'ethereum-usdc',kind:'token',symbol:'USDC',decimals:6}]},
];
const configuredTokens=(_chain,config)=>config.enabled===false?[]:config.tokens;
function options(filename=':memory:') {
  const config={payments:{allowFingerprintUnderpayment:true},pricing:{stablePolicy:'parity'}};
  for(const c of registry) config[c.id]={enabled:true,startBlock:0,rpcUrl:'https://fixture.invalid',tokens:c.tokens.map(t=>({...t,contract,paymentReference:true}))};
  return {filename,masterKey:Buffer.alloc(32,7),registry,config,configuredTokens};
}
function fixture({mode='live',paymentMode='reference',filename=':memory:'}={}) {
  const opts=options(filename),s=new Store(opts);
  const m=s.register({email:'reference@example.test',password:'fixture-password-123'},mode);
  const p=s.createProject(m,{name:'Reference checkout'});
  for(const c of registry) s.addAddress(m,{project_id:p.id,chain:c.id,address:mode==='demo'?'demo:'+c.id:address});
  s.setPaymentPolicy(m,p.id,{payment_mode:paymentMode});
  const product=s.createProduct(m,{project_id:p.id,name:'License',price:'1.00',currency:'USD'});
  s.importInventory(m,product.id,['LICENSE-A','LICENSE-B','LICENSE-C','LICENSE-D','LICENSE-E']);
  return {s,m,p,product,opts};
}
function order(f,extra={}) {return f.s.createOrder(f.m,{project_id:f.p.id,fiat_amount:'1.00',fiat_currency:'USD',chain:'bsc',token_id:'bsc-usdt',...extra});}
const raw=(f,o)=>f.s.ownedOrder(f.m,o.order_id);
const txId=tx=>hash([tx.chain,tx.tx_hash,tx.event_index].join(':'));
const txRow=(f,t)=>f.s.get('SELECT * FROM transfers WHERE id=?',txId(t));
function transfer(f,o,extra={}) {
  return {chain:o.chain,token_id:o.token_id,to_address:o.pay_address,from_address:'0x'+'3'.repeat(40),
    tx_hash:'tx-'+o.order_id,event_index:0,amount_atomic:decimalAtomic(o.payable_amount,f.s.tokenSpec(o.chain,o.token_id).token.decimals).toString(),
    block_height:100,block_hash:'fixture-block',block_time:new Date(Date.now()+2000).toISOString(),
    confirmations:o.required_confirmations,confirmed:true,removed:false,payment_reference:raw(f,o).payment_reference,...extra};
}
const ingest=(f,t)=>f.s.ingest(t,{mode:f.m.mode});
function historical(f,o,{status='expired',late=false}={}) {
  const start=new Date(Date.now()-120000).toISOString(),end=new Date(Date.now()-60000).toISOString();
  f.s.run('UPDATE amount_reservations SET created_at=? WHERE order_id=?',start,o.order_id);
  f.s.run('UPDATE orders SET payment_started_at=?,expires_at=?,status=? WHERE order_id=?',start,end,status,o.order_id);
  return transfer(f,o,{block_time:new Date(Date.now()-(late?30000:90000)).toISOString()});
}

test('same address and base amount supports multiple orders settled only by their own references exactly once',()=>{
  const f=fixture();
  try {
    const orders=Array.from({length:5},()=>order(f,{product_id:f.product.id}));
    assert.equal(new Set(orders.map(o=>o.pay_address)).size,1);
    assert.equal(new Set(orders.map(o=>raw(f,o).payment_reference)).size,5);
    for(const o of orders.reverse()) {
      assert.equal(o.payment_mode,'reference'); assert.equal(o.payable_amount,'1.0'); assert.equal(o.payment_tolerance,null);
      assert.deepEqual(decodeReferenceTransfer(o.wallet_payment.data),{recipient:address,amount_atomic:'1000000000000000000',reference:raw(f,o).payment_reference});
      assert.equal(o.wallet_payment.chain_id,'0x38'); assert.equal(o.wallet_payment.to,contract);
      assert.equal(o.wallet_payment.value,'0x0'); assert.equal(o.wallet_payment.token_decimals,18);
      const tx=transfer(f,o),paid=ingest(f,tx).order;
      assert.equal(paid.status,'paid'); assert.equal(paid.received_amount,'1.0'); assert.equal(paid.paid_source,'chain');
      ingest(f,tx); ingest(f,tx);
      assert.equal(f.s.orderUsdAtomic(raw(f,o)),decimalAtomic('1',18));
    }
    assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,5);
    assert.equal(f.s.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n,5);
  } finally {f.s.close();}
});

test('missing, unknown or invalid references never fall back to legacy amount matching',()=>{
  const f=fixture({paymentMode:'amount'});
  try {
    const legacy=order(f,{fiat_amount:'2.00'});
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'reference'});
    const a=order(f);
    for(const [name,extra] of [
      ['missing',{payment_reference:null}],['unknown',{payment_reference:'0x'+'a'.repeat(64)}],
      ['malformed',{payment_reference:'not-a-reference'}],['scanner-invalid',{payment_reference:null,payment_reference_invalid:true}],
      ['zero-reference',{payment_reference:'0x'+'0'.repeat(64)}],
    ]) {
      const tx=transfer(f,a,{...extra,tx_hash:name});
      assert.equal(ingest(f,tx).matched,false,name);
      assert.equal(txRow(f,tx).order_id,null);
      if(extra.payment_reference_invalid) assert.equal(ingest(f,{...tx,payment_reference_invalid:false}).matched,false);
    }
    for(const extra of [{payment_reference:'0x'+'b'.repeat(64)},{payment_reference:null,payment_reference_invalid:true},{payment_reference:raw(f,a).payment_reference}]) {
      const tx=transfer(f,legacy,{...extra,tx_hash:'legacy-'+JSON.stringify(extra)});
      assert.equal(ingest(f,tx).matched,false);
      assert.equal(raw(f,legacy).status,'pending');
    }
    assert.equal(raw(f,a).status,'pending');
    assert.equal(ingest(f,transfer(f,legacy)).order.status,'paid');
  } finally {f.s.close();}
});

test('deferred checkouts retain their original mode capabilities across both project policy changes',()=>{
  const f=fixture({paymentMode:'amount'});
  try {
    f.s.config.ethereum.tokens[0].paymentReference=false;
    const a=order(f,{chain:undefined,token_id:undefined});
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'reference'});
    assert.equal(f.s.availableMethods(f.m,f.p.id,{payment_mode:a.payment_mode}).some(x=>x.chain==='ethereum'),true);
    assert.equal(f.s.selectMethod(raw(f,a),'ethereum','ethereum-usdc').payment_mode,'amount');
    const b=order(f,{chain:undefined,token_id:undefined});
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'amount'});
    assert.equal(f.s.availableMethods(f.m,f.p.id,{payment_mode:b.payment_mode}).some(x=>x.chain==='ethereum'),false);
    assert.throws(()=>f.s.selectMethod(raw(f,b),'ethereum','ethereum-usdc'),e=>e.code==='REFERENCE_UNSUPPORTED');
    assert.equal(f.s.selectMethod(raw(f,b),'bsc','bsc-usdt').payment_mode,'reference');
  } finally {f.s.close();}
});

test('reference and principal are immutable; shortfalls including merchant fees are never tolerated',()=>{
  for(const [chain,token_id,decimals] of [['bsc','bsc-usdt',18],['ethereum','ethereum-usdc',6]]) {
    const f=fixture();
    try {
      f.s.updateProjectSettings(f.m,f.p.id,{fee_enabled:true,fee_percent:'1.00'});
      const o=order(f,{chain,token_id});
      assert.equal(o.payable_amount,'1.01'); assert.equal(o.payment_tolerance,null);
      for(const amount of ['1.0','1.02']) {
        const tx=transfer(f,o,{amount_atomic:decimalAtomic(amount,decimals).toString(),tx_hash:amount});
        assert.equal(ingest(f,tx).matched,false);
        assert.equal(txRow(f,tx).reason,'payment_reference_mismatch');
      }
      const tx=transfer(f,o);
      assert.equal(ingest(f,tx).order.status,'paid');
      for(const change of [{payment_reference:null},{payment_reference:'0x'+'c'.repeat(64)},{payment_reference_invalid:true}])
        assert.throws(()=>ingest(f,{...tx,...change}),e=>e.code==='TRANSFER_CONFLICT');
      assert.equal(f.s.orderUsdAtomic(raw(f,o)),decimalAtomic('1.01',18));
    } finally {f.s.close();}
  }
});

test('reference lookup verifies chain token address project tenant and mode before matching',()=>{
  const f=fixture();
  try {
    const a=order(f),p2=f.s.createProject(f.m,{name:'Other project'});
    f.s.addAddress(f.m,{project_id:p2.id,chain:'bsc',address:'0x'+'4'.repeat(40)});
    const other=f.s.register({email:'other@example.test',password:'fixture-password-123'},'live');
    const otherP=f.s.createProject(other,{name:'Other merchant'});
    f.s.addAddress(other,{project_id:otherP.id,chain:'bsc',address:'0x'+'5'.repeat(40)});
    for(const [name,extra] of [
      ['chain',{chain:'ethereum',token_id:'ethereum-usdc'}],['token',{token_id:'bsc-usdc'}],
      ['project',{to_address:'0x'+'4'.repeat(40)}],['tenant',{to_address:'0x'+'5'.repeat(40)}],
    ]) {
      const tx=transfer(f,a,{...extra,tx_hash:name});
      assert.equal(ingest(f,tx).matched,false);
      assert.equal(txRow(f,tx).reason,'payment_reference_mismatch');
    }
    assert.equal(f.s.ingest(transfer(f,a),{mode:'demo'}).ignored,true);
    assert.equal(raw(f,a).status,'pending');
    assert.equal(f.s.get('SELECT COUNT(*) n FROM transfers WHERE order_id IS NOT NULL').n,0);
  } finally {f.s.close();}
});

test('one reference cannot fulfill twice and a bound transaction cannot be moved to a second order',()=>{
  const f=fixture();
  try {
    const a=order(f,{product_id:f.product.id}),b=order(f,{product_id:f.product.id});
    const tx=transfer(f,a);
    assert.equal(ingest(f,tx).order.status,'paid');
    const repeat={...tx,tx_hash:'second-transfer-same-ref'};
    assert.equal(ingest(f,repeat).matched,false);
    assert.equal(txRow(f,repeat).reason,'duplicate_payment');
    assert.throws(()=>ingest(f,{...tx,payment_reference:raw(f,b).payment_reference}),e=>e.code==='TRANSFER_CONFLICT');
    assert.equal(raw(f,b).status,'pending');
    assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,1);
    assert.throws(()=>f.s.claim(f.m,txId(repeat),b.order_id),e=>e.code==='CLAIM_REJECTED');
  } finally {f.s.close();}
});

test('a validated reference may upgrade an unbound old scan but cannot change a bound legacy transfer',()=>{
  const f=fixture();
  try {
    const a=order(f),tx=transfer(f,a);
    assert.equal(ingest(f,{...tx,payment_reference:null}).matched,false);
    assert.equal(txRow(f,tx).order_id,null);
    assert.equal(ingest(f,tx).order.status,'paid');
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'amount'});
    const legacy=order(f),legacyTx=transfer(f,legacy);
    ingest(f,legacyTx);
    assert.throws(()=>ingest(f,{...legacyTx,payment_reference:raw(f,a).payment_reference}),e=>e.code==='TRANSFER_CONFLICT');
  } finally {f.s.close();}
});

test('a first canonical reference resolves only an unbound legacy ambiguity; no-reference replays stay ambiguous',()=>{
  const f=fixture({paymentMode:'amount'});
  try {
    const legacyA=order(f),legacyB=order(f);
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'reference'});
    const referenced=order(f,{product_id:f.product.id}),tx=transfer(f,referenced);
    assert.equal(ingest(f,{...tx,payment_reference:null}).matched,false);
    assert.equal(txRow(f,tx).reason,'ambiguous_amount');
    assert.equal(txRow(f,tx).order_id,null);
    assert.equal(ingest(f,{...tx,payment_reference:null}).matched,false);
    assert.equal(txRow(f,tx).reason,'ambiguous_amount');
    assert.equal(ingest(f,tx).order.status,'paid');
    assert.equal(txRow(f,tx).order_id,referenced.order_id);
    assert.equal(raw(f,legacyA).status,'pending'); assert.equal(raw(f,legacyB).status,'pending');
    ingest(f,tx);
    assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,1);
    assert.equal(f.s.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n,1);
  } finally {f.s.close();}
});

test('project policy only affects new orders and untrusted create input cannot choose a mode',()=>{
  const f=fixture({paymentMode:'amount'});
  try {
    const allowed_methods=[{chain:'bsc',token_id:'bsc-usdt'},{chain:'bsc',token_id:'bsc-usdc'}];
    const a=order(f,{payment_mode:'reference',metadata:{payment_mode:'reference'},allowed_methods});
    assert.equal(a.payment_mode,'amount'); assert.equal(a.wallet_payment,null);
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'reference'});
    const b=order(f,{payment_mode:'amount',allowed_methods});
    assert.equal(b.payment_mode,'reference');
    f.s.config.bsc.tokens[1].paymentReference=false;
    assert.equal(f.s.availableMethods(f.m,f.p.id,{payment_mode:a.payment_mode}).some(x=>x.token_id==='bsc-usdc'),true);
    assert.equal(f.s.availableMethods(f.m,f.p.id,{payment_mode:b.payment_mode}).some(x=>x.token_id==='bsc-usdc'),false);
    assert.equal(f.s.selectMethod(raw(f,a),'bsc','bsc-usdc').payment_mode,'amount');
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'amount'});
    assert.throws(()=>f.s.selectMethod(raw(f,b),'bsc','bsc-usdc'),e=>e.code==='REFERENCE_UNSUPPORTED');
    assert.equal(f.s.orderView(raw(f,b)).payment_mode,'reference');
    assert.equal(f.s.orderView(raw(f,a)).payment_mode,'amount');
    assert.throws(()=>f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'guess'}),e=>e.code==='INVALID_PAYMENT_MODE');
    const other=f.s.register({email:'unauthorized@example.test',password:'fixture-password-123'},'live');
    assert.throws(()=>f.s.paymentPolicy(other,f.p.id),e=>e.code==='NOT_FOUND');
    assert.throws(()=>f.s.setPaymentPolicy(other,f.p.id,{payment_mode:'reference'}),e=>e.code==='NOT_FOUND');
  } finally {f.s.close();}
});

test('reference support is opt-in and quote-limit failure rolls back orders and references',()=>{
  const f=fixture();
  try {
    f.s.enforceQuoteLimit=()=>{throw Error('fixture quota');};
    assert.throws(()=>order(f),/fixture quota/);
    assert.equal(f.s.get('SELECT COUNT(*) n FROM orders').n,0);
    assert.equal(f.s.get('SELECT COUNT(*) n FROM amount_reservations').n,0);
    delete f.s.enforceQuoteLimit;
    f.s.config.bsc.tokens[0].paymentReference=false;
    assert.throws(()=>order(f),e=>e.code==='REFERENCE_UNSUPPORTED');
    assert.equal(f.s.availableMethods(f.m,f.p.id).some(x=>x.token_id==='bsc-usdt'),false);
    f.s.config.bsc.tokens[0].paymentReference=true;
    const a=order(f,{merchant_order_id:'idempotent'}),repeat=order(f,{merchant_order_id:'idempotent'});
    assert.equal(a.wallet_payment.reference,repeat.wallet_payment.reference);
    assert.equal(f.s.get('SELECT COUNT(*) n FROM amount_reservations').n,1);
  } finally {f.s.close();}
});

test('method switches allocate distinct references; returning restores the original price and quote window',()=>{
  const f=fixture();
  try {
    const a=order(f,{allowed_methods:[{chain:'bsc',token_id:'bsc-usdt'},{chain:'bsc',token_id:'bsc-usdc'}]});
    const quote=f.s.orderQuote(raw(f,a)),originalTx=transfer(f,a);
    const b=f.s.selectMethod(raw(f,a),'bsc','bsc-usdc');
    assert.notEqual(b.wallet_payment.reference,a.wallet_payment.reference);
    assert.equal(ingest(f,originalTx).matched,false);
    assert.equal(txRow(f,originalTx).reason,'superseded_payment_method');
    const expiry=b.expires_at;
    f.s.config.pricing.enabled=false;
    f.s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'amount'});
    const restored=f.s.selectMethod(raw(f,a),'bsc','bsc-usdt');
    assert.equal(restored.payment_mode,'reference');
    assert.equal(restored.wallet_payment.reference,a.wallet_payment.reference);
    assert.equal(restored.expires_at,expiry);
    assert.deepEqual(f.s.orderQuote(raw(f,a)),quote);
    assert.equal(ingest(f,originalTx).order.status,'paid');
  } finally {f.s.close();}
});

test('reference payment made in the original window automatically recovers an expired order and waits for confirmations',()=>{
  const f=fixture();
  try {
    const a=order(f,{product_id:f.product.id}),tx=historical(f,a),before=f.s.orderQuote(raw(f,a)),expires=raw(f,a).expires_at;
    assert.equal(ingest(f,{...tx,confirmed:false,confirmations:1}).order.status,'confirming');
    assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,0);
    assert.equal(ingest(f,tx).order.status,'paid');
    assert.equal(raw(f,a).paid_source,'chain');
    assert.equal(raw(f,a).expires_at,expires);
    assert.deepEqual(f.s.orderQuote(raw(f,a)),before);
    ingest(f,tx);
    assert.equal(f.s.get("SELECT COUNT(*) n FROM audit WHERE action='auto_reconcile' AND subject=?",a.order_id).n,1);
    assert.equal(f.s.get("SELECT COUNT(*) n FROM audit WHERE action='merchant_claim'").n,0);
  } finally {f.s.close();}
});

test('late early canceled and legacy expired orders remain closed; manual claim cannot bypass reference identity',()=>{
  for(const scenario of ['late','early','canceled','legacy']) {
    const f=fixture({paymentMode:scenario==='legacy'?'amount':'reference'});
    try {
      const a=order(f),tx=historical(f,a,{status:scenario==='canceled'?'canceled':'expired',late:scenario==='late'});
      if(scenario==='early') tx.block_time=new Date(Date.now()-180000).toISOString();
      assert.equal(ingest(f,tx).matched,false,scenario);
      assert.equal(raw(f,a).status,scenario==='canceled'?'canceled':'expired');
      assert.equal(f.s.get("SELECT COUNT(*) n FROM audit WHERE action='auto_reconcile'").n,0);
    } finally {f.s.close();}
  }
  const f=fixture();
  try {
    const a=order(f),tx=transfer(f,a,{payment_reference:null});
    ingest(f,tx);
    assert.throws(()=>f.s.claim(f.m,txId(tx),a.order_id),e=>e.code==='CLAIM_REJECTED');
  } finally {f.s.close();}
});

test('reference binding survives reorg without rebinding or repeat fulfillment',()=>{
  const f=fixture();
  try {
    const a=order(f,{product_id:f.product.id}),b=order(f),tx=transfer(f,a);
    assert.equal(ingest(f,{...tx,confirmed:false,confirmations:1}).order.status,'confirming');
    ingest(f,{...tx,removed:true,confirmed:false,confirmations:0});
    assert.equal(txRow(f,tx).order_id,a.order_id); assert.equal(raw(f,a).status,'pending');
    assert.equal(ingest(f,tx).order.status,'paid');
    assert.equal(raw(f,b).status,'pending');
    ingest(f,{...tx,removed:true,confirmed:false,confirmations:0});
    assert.equal(txRow(f,tx).reason,'reorg_after_payment');
    ingest(f,tx);
    assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,1);
  } finally {f.s.close();}
});

test('stock shortages advertise waiting_stock and fresh replay delivers once after restock',()=>{
  const f=fixture();
  try {
    f.s.run('DELETE FROM inventory'); f.s.importInventory(f.m,f.product.id,['LAST']);
    const a=order(f,{product_id:f.product.id}),b=order(f,{product_id:f.product.id});
    ingest(f,transfer(f,a));
    const tx=historical(f,b);
    assert.equal(ingest(f,tx).order.fulfillment_status,'waiting_stock');
    assert.equal(raw(f,b).status,'review');
    f.s.importInventory(f.m,f.product.id,['RESTOCKED']);
    const paid=ingest(f,tx).order;
    assert.equal(paid.status,'paid'); assert.equal(paid.delivery,'RESTOCKED'); assert.equal(paid.paid_source,'chain');
    ingest(f,tx);
    assert.equal(f.s.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n,2);
  } finally {f.s.close();}
});

test('demo references remain isolated and never expose a broadcastable live wallet payload',()=>{
  const f=fixture({mode:'demo'});
  try {
    const a=order(f),b=order(f);
    assert.equal(a.payable_amount,'1.0'); assert.equal(a.wallet_payment,null);
    assert.equal(f.s.orderView(raw(f,a),{publicView:true}).wallet_payment,null);
    assert.notEqual(raw(f,a).payment_reference,raw(f,b).payment_reference);
    assert.equal(f.s.simulate(f.m,b.order_id).status,'paid');
    assert.equal(f.s.simulate(f.m,a.order_id).status,'paid');
    assert.equal(f.s.ingest(transfer(f,a),{mode:'live'}).ignored,true);
  } finally {f.s.close();}
});

test('legacy schema migration and restart preserve all rows, extension columns, indexes and old quote uniqueness',()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'avenora-reference-migration-')),filename=path.join(directory,'test.db');
  let f=fixture({filename,paymentMode:'amount'}),s=f.s;
  try {
    const a=order(f,{product_id:f.product.id}),b=order(f);
    ingest(f,transfer(f,a)); f.s.cancel(f.m,b.order_id);
    f.s.db.exec("ALTER TABLE orders ADD COLUMN extension_note TEXT DEFAULT 'retained'; CREATE INDEX legacy_extension_index ON orders(extension_note)");
    const oldOrders=f.s.all('SELECT * FROM orders ORDER BY order_id').map(({payment_mode,payment_reference,...o})=>({...o}));
    const oldQuotes=f.s.all('SELECT * FROM amount_reservations ORDER BY order_id').map(({payment_reference,...q})=>({...q}));
    const oldTransfers=f.s.all('SELECT * FROM transfers');
    s.close();s=null;
    const db=new DatabaseSync(filename);
    db.exec(`PRAGMA foreign_keys=OFF;
      DROP INDEX orders_amount_identity; DROP INDEX orders_payment_reference;
      DROP INDEX reservations_amount_identity; DROP INDEX reservations_payment_reference;
      ALTER TABLE orders DROP COLUMN payment_mode; ALTER TABLE orders DROP COLUMN payment_reference;
      ALTER TABLE amount_reservations DROP COLUMN payment_reference;`);
    for(const name of ['orders','amount_reservations']) {
      const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql;
      let body=sql.slice(sql.indexOf('('));
      if(name==='orders') body=body.slice(0,-1)+',UNIQUE(chain,token_id,pay_address,payable_atomic))';
      else body=body.replace('PRIMARY KEY(order_id,chain,token_id,pay_address,payable_atomic)','PRIMARY KEY(chain,token_id,pay_address,payable_atomic)');
      const indices=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type='index' AND sql IS NOT NULL").all(name);
      db.exec(`CREATE TABLE downgrade_${name} ${body}; INSERT INTO downgrade_${name} SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE downgrade_${name} RENAME TO ${name}`);
      for(const index of indices) db.exec(index.sql);
    }
    db.close();
    s=new Store(options(filename));f={...f,s};
    assert.deepEqual(s.all('SELECT * FROM orders ORDER BY order_id').map(({payment_mode,payment_reference,...o})=>({...o})),oldOrders);
    assert.deepEqual(s.all('SELECT * FROM amount_reservations ORDER BY order_id').map(({payment_reference,...q})=>({...q})),oldQuotes);
    assert.deepEqual(s.all('SELECT * FROM transfers'),oldTransfers);
    assert.ok(s.get("SELECT name FROM sqlite_master WHERE name='legacy_extension_index'"));
    assert.equal(s.all('SELECT DISTINCT payment_mode FROM orders')[0].payment_mode,'amount');
    assert.throws(()=>s.run('UPDATE orders SET payable_atomic=? WHERE order_id=?',raw(f,a).payable_atomic,b.order_id),/UNIQUE/);
    s.setPaymentPolicy(f.m,f.p.id,{payment_mode:'reference'});
    const c=order(f),d=order(f),quotes=s.all('SELECT * FROM amount_reservations ORDER BY order_id');
    assert.equal(c.payable_amount,d.payable_amount);
    const cQuote=s.orderQuote(raw(f,c));
    s.close();s=new Store(options(filename));f={...f,s};
    assert.deepEqual(s.all('SELECT * FROM amount_reservations ORDER BY order_id'),quotes);
    assert.deepEqual(s.orderQuote(raw(f,c)),cQuote);
    assert.equal(s.get('SELECT COUNT(*) n FROM amount_reservations WHERE payment_reference IS NULL').n,2);
    assert.equal(ingest(f,transfer(f,c)).order.status,'paid');
    assert.equal(raw(f,d).status,'pending');
  } finally {s?.close();rmSync(directory,{recursive:true,force:true});}
});
