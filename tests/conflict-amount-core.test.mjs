import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, decimalAtomic, hash } from '../server/core.mjs';

const receiver='0x'+'1'.repeat(40), contract='0x'+'2'.repeat(40);
const registry=[
  {id:'bsc',family:'evm',chainId:56,confirmations:15,tokens:[{id:'bsc-usdt',kind:'token',symbol:'USDT',decimals:18},{id:'bsc-usdc',kind:'token',symbol:'USDC',decimals:18}]},
  {id:'ethereum',family:'evm',chainId:1,confirmations:20,tokens:[{id:'ethereum-usdc',kind:'token',symbol:'USDC',decimals:6}]},
];
function options(filename=':memory:') {
  const config={payments:{amountAllocation:'conflict_only',conflictStep:'0.0000001',allowFingerprintUnderpayment:true},pricing:{stablePolicy:'parity'}};
  for(const chain of registry)config[chain.id]={enabled:true,startBlock:0,rpcUrl:'https://fixture.invalid',tokens:chain.tokens.map(token=>({...token,contract,paymentReference:true}))};
  return {filename,masterKey:Buffer.alloc(32,8),registry,config,configuredTokens:(_c,cfg)=>cfg.tokens};
}
function fixture({mode='live',filename=':memory:'}={}) {
  const opts=options(filename),s=new Store(opts);
  const m=s.register({email:'conflict@example.test',password:'fixture-password-123'},mode);
  const p=s.createProject(m,{name:'Conflict checkout'});
  for(const chain of registry)s.addAddress(m,{project_id:p.id,chain:chain.id,address:mode==='demo'?'demo:'+chain.id:receiver});
  const product=s.createProduct(m,{project_id:p.id,name:'License',price:'1.00',currency:'USD'});
  s.importInventory(m,product.id,Array.from({length:12},(_,i)=>'LICENSE-'+i));
  return {s,m,p,product,opts};
}
const order=(f,extra={})=>f.s.createOrder(f.m,{project_id:f.p.id,fiat_amount:'1.00',fiat_currency:'USD',chain:'bsc',token_id:'bsc-usdt',...extra});
const raw=(f,o)=>f.s.ownedOrder(f.m,o.order_id);
const txId=tx=>hash([tx.chain,tx.tx_hash,tx.event_index].join(':'));
function transfer(f,o,extra={}) {
  return {chain:o.chain,token_id:o.token_id,to_address:o.pay_address,from_address:'0x'+'3'.repeat(40),
    tx_hash:'tx-'+o.order_id,event_index:0,amount_atomic:decimalAtomic(o.payable_amount,f.s.tokenSpec(o.chain,o.token_id).token.decimals).toString(),
    block_height:100,block_hash:'fixture-block',block_time:new Date(Date.now()+2000).toISOString(),
    confirmations:o.required_confirmations,confirmed:true,removed:false,...extra};
}
const ingest=(f,tx)=>f.s.ingest(tx,{mode:f.m.mode});
function shiftWindow(f,o,{start=Date.now()-120000,end=Date.now()-60000,status='expired'}={}) {
  const created=new Date(start).toISOString(),expires=new Date(end).toISOString();
  f.s.run('UPDATE amount_reservations SET created_at=?,expires_at=? WHERE order_id=?',created,expires,o.order_id);
  f.s.run('UPDATE orders SET payment_started_at=?,expires_at=?,status=? WHERE order_id=?',created,expires,status,o.order_id);
  return {created,expires};
}

test('three same-address orders use base then token increments and reverse-order exact payments deliver once',()=>{
  const f=fixture();
  try{
    const orders=Array.from({length:3},()=>order(f,{product_id:f.product.id}));
    assert.deepEqual(orders.map(o=>o.payable_amount),['1.0','1.0000001','1.0000002']);
    assert.equal(new Set(orders.map(o=>o.pay_address)).size,1);
    for(const [i,o] of orders.entries()){
      assert.equal(o.payment_mode,'amount');assert.equal(o.wallet_payment,null);assert.equal(o.payment_tolerance,null);
      assert.deepEqual(o.amount_matching,{strategy:'conflict_only',base_amount:'1.0',increment:'0.0000001',adjustment:i?'0.000000'+i:'0.0',exact:true});
    }
    for(const o of [...orders].reverse()){
      const tx=transfer(f,o),paid=ingest(f,tx).order;
      assert.equal(paid.order_id,o.order_id);assert.equal(paid.status,'paid');assert.equal(paid.paid_source,'chain');
      assert.equal(paid.received_amount,o.payable_amount);assert.ok(paid.delivery);
      ingest(f,tx);ingest(f,tx);
    }
    assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,3);
    assert.equal(f.s.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n,3);
  }finally{f.s.close();}
});

test('new exact quote never accepts a waived or rounded increment even with global tolerance and force enabled',()=>{
  const f=fixture();
  try{
    const a=order(f),b=order(f),q=f.s.orderQuote(raw(f,b));
    assert.equal(f.s.paymentAmountMatches(raw(f,b),decimalAtomic('1',18).toString(),q,{force:true}),false);
    ingest(f,transfer(f,a));
    const short=transfer(f,b,{amount_atomic:decimalAtomic('1',18).toString(),tx_hash:'short'});
    assert.equal(ingest(f,short).matched,false);
    assert.equal(raw(f,b).status,'pending');
    const rounded=transfer(f,b,{amount_atomic:decimalAtomic('1.00000005',18).toString(),tx_hash:'rounded'});
    assert.equal(ingest(f,rounded).matched,false);
    assert.equal(ingest(f,transfer(f,b)).order.order_id,b.order_id);
  }finally{f.s.close();}
});

test('paid canceled and switched quotes occupy their whole original window',()=>{
  const f=fixture();
  try{
    const a=order(f);ingest(f,transfer(f,a));
    const b=order(f);assert.equal(b.payable_amount,'1.0000001');
    f.s.cancel(f.m,b.order_id);
    const c=order(f,{allowed_methods:[{chain:'bsc',token_id:'bsc-usdt'},{chain:'bsc',token_id:'bsc-usdc'}]});
    const q=f.s.orderQuote(raw(f,c));assert.equal(c.payable_amount,'1.0000002');
    f.s.selectMethod(raw(f,c),'bsc','bsc-usdc');
    const d=order(f);assert.equal(d.payable_amount,'1.0000003');
    const restored=f.s.selectMethod(raw(f,c),'bsc','bsc-usdt');
    assert.equal(restored.payable_amount,c.payable_amount);assert.equal(restored.expires_at,c.expires_at);
    assert.deepEqual(f.s.orderQuote(raw(f,c)),q);
    assert.equal(f.s.all("SELECT * FROM amount_reservations WHERE order_id=? AND token_id='bsc-usdt'",c.order_id).length,1);
  }finally{f.s.close();}
});

test('expired windows release base and historical delayed or repeated events keep their original order',()=>{
  const f=fixture();
  try{
    const old=order(f,{product_id:f.product.id}),window=shiftWindow(f,old);
    const fresh=order(f,{product_id:f.product.id});assert.equal(fresh.payable_amount,'1.0');
    const historical=transfer(f,old,{block_time:new Date(Date.parse(window.created)+2000).toISOString()});
    const paid=ingest(f,historical).order;assert.equal(paid.order_id,old.order_id);assert.equal(paid.status,'paid');
    assert.equal(raw(f,fresh).status,'pending');
    ingest(f,historical);assert.equal(raw(f,fresh).status,'pending');
    assert.equal(ingest(f,transfer(f,fresh)).order.order_id,fresh.order_id);
    assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,2);
  }finally{f.s.close();}
});

test('same-second old deadline stays reserved and unfinished confirmation or stock review retains amount',()=>{
  const f=fixture();
  try{
    const a=order(f),end=Math.floor(Date.now()/1000)*1000+999;
    shiftWindow(f,a,{end,status:'paid'});
    assert.equal(order(f).payable_amount,'1.0000001');
    shiftWindow(f,a,{status:'confirming'});
    assert.equal(order(f).payable_amount,'1.0000002');
    f.s.run("UPDATE orders SET status='review' WHERE order_id=?",a.order_id);
    assert.equal(order(f).payable_amount,'1.0000003');
    f.s.run("UPDATE orders SET status='paid' WHERE order_id=?",a.order_id);
    assert.equal(order(f).payable_amount,'1.0');
  }finally{f.s.close();}
});

test('legacy quotes remain unchanged and their underpayment ranges are excluded during new allocation',()=>{
  const f=fixture();
  try{
    delete f.s.config.payments.amountAllocation;
    const legacy=order(f);assert.equal(legacy.payable_amount,'1.000100000000000000');
    const oldQuote=f.s.orderQuote(raw(f,legacy));
    f.s.config.payments.amountAllocation='conflict_only';
    const next=order(f);assert.equal(next.payable_amount,'1.0001001');
    assert.deepEqual(f.s.orderQuote(raw(f,legacy)),oldQuote);
    assert.equal(ingest(f,transfer(f,next)).order.order_id,next.order_id);
    assert.equal(raw(f,legacy).status,'pending');
    f.s.config.payments.allowFingerprintUnderpayment=false;
    const base=order(f);assert.equal(base.payable_amount,'1.0');
    assert.equal(ingest(f,transfer(f,base)).order.order_id,base.order_id);
    assert.equal(ingest(f,transfer(f,legacy)).order.order_id,legacy.order_id);
  }finally{f.s.close();}
});

test('enabling legacy tolerance later cannot steal an ambiguous old payment for a new exact quote',()=>{
  const f=fixture();
  try{
    delete f.s.config.payments.amountAllocation;
    const legacy=order(f);
    f.s.config.payments.amountAllocation='conflict_only';f.s.config.payments.allowFingerprintUnderpayment=false;
    const fresh=order(f);assert.equal(fresh.payable_amount,'1.0');
    f.s.config.payments.allowFingerprintUnderpayment=true;
    const tx=transfer(f,fresh);
    assert.equal(ingest(f,tx).matched,false);
    assert.equal(f.s.get('SELECT reason FROM transfers WHERE id=?',txId(tx)).reason,'ambiguous_amount');
    assert.equal(raw(f,legacy).status,'pending');assert.equal(raw(f,fresh).status,'pending');
    f.s.config.payments.allowFingerprintUnderpayment=false;
    assert.equal(ingest(f,tx).matched,false);
  }finally{f.s.close();}
});

test('unsupported precision fails closed and assets outside configured list retain legacy behavior',()=>{
  const f=fixture();
  try{
    const usdc=order(f,{token_id:'bsc-usdc'});assert.equal(usdc.amount_matching,null);assert.equal(usdc.payable_amount,'1.000100000000000000');
    f.s.config.payments.conflictTokens=['ethereum-usdc'];
    assert.throws(()=>order(f,{chain:'ethereum',token_id:'ethereum-usdc'}),e=>e.code==='INVALID_PAYMENT_CONFIG');
    assert.equal(f.s.get('SELECT COUNT(*) n FROM orders').n,1);
    for(const step of ['0','1','0.00000001x',0.0000001]){
      f.s.config.payments.conflictTokens=['bsc-usdt'];f.s.config.payments.conflictStep=step;
      assert.throws(()=>order(f),e=>e.code==='INVALID_PAYMENT_CONFIG');
    }
  }finally{f.s.close();}
});

test('reorg and duplicate transaction identity cannot rebind to a later quote or redeliver',()=>{
  const f=fixture();
  try{
    const a=order(f,{product_id:f.product.id}),tx=transfer(f,a,{confirmations:1,confirmed:false});
    assert.equal(ingest(f,tx).order.status,'confirming');
    const b=order(f,{product_id:f.product.id});assert.equal(b.payable_amount,'1.0000001');
    ingest(f,{...tx,removed:true});assert.equal(raw(f,a).status,'pending');
    const valid={...tx,block_hash:'replacement',removed:false,confirmed:true,confirmations:a.required_confirmations};
    assert.equal(ingest(f,valid).order.order_id,a.order_id);
    assert.equal(f.s.get('SELECT order_id FROM transfers WHERE id=?',txId(tx)).order_id,a.order_id);
    assert.equal(raw(f,b).status,'pending');assert.equal(f.s.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,1);
    assert.throws(()=>ingest(f,{...valid,amount_atomic:decimalAtomic(b.payable_amount,18).toString()}),e=>e.code==='TRANSFER_CONFLICT');
  }finally{f.s.close();}
});

test('conflict snapshots preserve original price and strict amount when deployment config changes',()=>{
  const f=fixture();
  try{
    const a=order(f),b=order(f),quote=f.s.orderQuote(raw(f,b));
    delete f.s.config.payments.amountAllocation;f.s.config.payments.conflictStep='0.01';
    const same=f.s.selectMethod(raw(f,b),'bsc','bsc-usdt');
    assert.equal(same.payable_amount,'1.0000001');assert.equal(same.amount_matching.increment,'0.0000001');
    assert.equal(same.payment_tolerance,null);assert.deepEqual(f.s.orderQuote(raw(f,b)),quote);
  }finally{f.s.close();}
});

test('migration and repeated startup preserve legacy rows plus reusable new-window history',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'avenora-conflict-')),filename=path.join(dir,'payment.sqlite');
  let f=fixture({filename}),s=f.s;
  try{
    delete s.config.payments.amountAllocation;
    const legacy=order(f,{product_id:f.product.id});ingest(f,transfer(f,legacy));
    s.db.exec("ALTER TABLE orders ADD COLUMN extension_note TEXT DEFAULT 'retained';CREATE INDEX retained_note ON orders(extension_note)");
    const oldOrders=s.all('SELECT * FROM orders').map(({allocation_strategy,...row})=>({...row}));
    const oldQuotes=s.all('SELECT * FROM amount_reservations').map(({allocation_strategy,expires_at,...row})=>({...row}));
    s.close();s=null;
    const db=new DatabaseSync(filename);
    db.exec(`DROP INDEX orders_amount_identity;DROP INDEX reservations_amount_identity;DROP INDEX reservations_amount_windows;
      ALTER TABLE orders DROP COLUMN allocation_strategy;
      ALTER TABLE amount_reservations DROP COLUMN allocation_strategy;
      ALTER TABLE amount_reservations DROP COLUMN expires_at;
      CREATE UNIQUE INDEX orders_amount_identity ON orders(chain,token_id,pay_address,payable_atomic) WHERE payment_mode='amount';
      CREATE UNIQUE INDEX reservations_amount_identity ON amount_reservations(chain,token_id,pay_address,payable_atomic) WHERE payment_reference IS NULL;`);
    db.close();
    s=new Store(options(filename));f={...f,s};s.config.payments.allowFingerprintUnderpayment=false;
    assert.deepEqual(s.all('SELECT * FROM orders').map(({allocation_strategy,...row})=>({...row})),oldOrders);
    assert.deepEqual(s.all('SELECT * FROM amount_reservations').map(({allocation_strategy,expires_at,...row})=>({...row})),oldQuotes);
    const a=order(f),window=shiftWindow(f,a),b=order(f);assert.equal(a.payable_amount,b.payable_amount);
    const orders=s.all('SELECT * FROM orders ORDER BY order_id'),quotes=s.all('SELECT * FROM amount_reservations ORDER BY order_id');
    for(let i=0;i<2;i++){
      s.close();s=new Store(options(filename));f={...f,s};s.config.payments.allowFingerprintUnderpayment=false;
      assert.deepEqual(s.all('SELECT * FROM orders ORDER BY order_id'),orders);
      assert.deepEqual(s.all('SELECT * FROM amount_reservations ORDER BY order_id'),quotes);
      assert.equal(s.get('PRAGMA integrity_check').integrity_check,'ok');assert.ok(s.get("SELECT name FROM sqlite_master WHERE name='retained_note'"));
    }
    assert.equal(ingest(f,transfer(f,a,{block_time:new Date(Date.parse(window.created)+2000).toISOString()})).order.order_id,a.order_id);
    assert.equal(raw(f,b).status,'pending');
  }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
