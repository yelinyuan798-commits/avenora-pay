import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, decimalAtomic, formatAtomic, hash } from '../server/core.mjs';

const registry = [
  {id:'bsc', confirmations:15, tokens:[
    {id:'bsc-usdt',symbol:'USDT',decimals:18},
    {id:'bsc-usdc',symbol:'USDC',decimals:18},
    {id:'bsc-bnb',symbol:'BNB',decimals:18,kind:'native'},
  ]},
  {id:'ethereum', confirmations:20, tokens:[{id:'ethereum-usdc',symbol:'USDC',decimals:6}]},
  {id:'tron', confirmations:19, tokens:[{id:'tron-usdt',symbol:'USDT',decimals:6}]},
  {id:'polygon', confirmations:128, tokens:[{id:'polygon-usdt0',symbol:'USDT0',decimals:6}]},
];
function fixture({enabled=true, mode='live'}={}) {
  const config = {payments:{allowFingerprintUnderpayment:enabled},pricing:{stablePolicy:'parity'}};
  for (const c of registry) config[c.id] = {enabled:true,startBlock:0,rpcUrl:'https://fixture.invalid',tokens:c.tokens.map(t=>({...t,contract:'fixture-contract'}))};
  const s = new Store({registry,config});
  const m = s.register({email:'tolerance@example.test',password:'fixture-password-123'},mode);
  const p = s.createProject(m,{name:'Tolerance store'});
  for (const c of registry) s.addAddress(m,{project_id:p.id,chain:c.id,address:(mode==='demo'?'demo:':'fixture:')+c.id});
  s.priceBook.recordAsset('BNB','500');
  const product = s.createProduct(m,{project_id:p.id,name:'One license',price:'1.00',currency:'USD'});
  s.importInventory(m,product.id,['LICENSE-A','LICENSE-B','LICENSE-C']);
  return {s,m,p,product,close:()=>s.close()};
}
function order(f, extra={}) {
  return f.s.createOrder(f.m,{project_id:f.p.id,fiat_amount:'1.00',fiat_currency:'USD',chain:'bsc',token_id:'bsc-usdt',...extra});
}
function raw(f,o) { return f.s.ownedOrder(f.m,o.order_id); }
function transfer(f,o,amount='1.0',extra={}) {
  return {chain:o.chain,token_id:o.token_id,to_address:o.pay_address,from_address:'fixture:payer',
    tx_hash:'fixture-'+o.order_id,event_index:0,
    amount_atomic:decimalAtomic(amount,f.s.tokenSpec(o.chain,o.token_id).token.decimals).toString(),
    block_height:100,block_hash:'fixture-block-100',block_time:new Date(Date.now()+2000).toISOString(),
    confirmations:o.required_confirmations,confirmed:true,removed:false,...extra};
}
const txId = tx => hash([tx.chain,tx.tx_hash,tx.event_index].join(':'));
const row = (f,tx) => f.s.get('SELECT * FROM transfers WHERE id=?',txId(tx));
const ingest = (f,tx) => f.s.ingest(tx,{mode:f.m.mode});
function shiftQuote(f,o,created,expires) {
  f.s.run('UPDATE amount_reservations SET created_at=? WHERE order_id=?',created,o.order_id);
  f.s.run('UPDATE orders SET payment_started_at=?,expires_at=? WHERE order_id=?',created,expires,o.order_id);
}

test('stable 18/6 decimal transfers may waive only fingerprint, while quote and one-use delivery remain exact',()=>{
  for (const [chain,token_id] of [['bsc','bsc-usdt'],['ethereum','ethereum-usdc'],['tron','tron-usdt'],['polygon','polygon-usdt0']]) {
    const f=fixture();
    try {
      const o=order(f,{chain,token_id,product_id:f.product.id});
      assert.deepEqual(o.payment_tolerance,{enabled:true,kind:'fingerprint_only',minimum_amount:'1.0',maximum_amount:o.payable_amount,maximum_shortfall:'0.0001',requires_unique_order:true});
      assert.equal(o.received_amount,null);
      const before=f.s.orderQuote(raw(f,o));
      const tx=transfer(f,o);
      const paid=ingest(f,tx).order;
      assert.equal(paid.status,'paid');
      assert.equal(paid.paid_source,'chain');
      assert.equal(paid.received_amount,'1.0');
      assert.equal(paid.payable_amount,o.payable_amount);
      assert.equal(paid.delivery,'LICENSE-A');
      for(let n=0;n<3;n++) ingest(f,tx);
      assert.equal(f.s.get('SELECT COUNT(*) AS n FROM inventory WHERE order_id IS NOT NULL').n,1);
      assert.deepEqual(f.s.orderQuote(raw(f,o)),before);
      assert.equal(f.s.orderUsdAtomic(raw(f,o)),decimalAtomic('1',18));
      const events=f.s.all("SELECT payload FROM deliveries WHERE json_extract(payload,'$.event_type')='order.paid'");
      assert.equal(events.length,1);
      const payload=JSON.parse(events[0].payload).data;
      assert.equal(payload.received_amount,'1.0');
      assert.equal(payload.waived_fingerprint_amount,'0.0001');
    } finally {f.close();}
  }
});

test('legacy snapshots reconstruct a 1.0002 quote floor without changing its stored amount',()=>{
  const f=fixture();
  try {
    const o=order(f,{product_id:f.product.id});
    const q=f.s.orderQuote(raw(f,o));
    const snapshot=JSON.parse(q.pricing_json);
    delete snapshot.base_payable_atomic;
    snapshot.usd_atomic=decimalAtomic('1.0002',18).toString();
    snapshot.usd_value='1.000200000000000000';
    snapshot.fingerprint_usd='0.000200000000000000';
    f.s.run('UPDATE amount_reservations SET payable_atomic=?,pricing_json=? WHERE order_id=?',snapshot.usd_atomic,JSON.stringify(snapshot),o.order_id);
    f.s.run('UPDATE orders SET payable_atomic=?,payable_amount=? WHERE order_id=?',snapshot.usd_atomic,'1.000200000000000000',o.order_id);
    const current=f.s.orderView(raw(f,o));
    assert.equal(current.payment_tolerance.minimum_amount,'1.0');
    assert.equal(current.payment_tolerance.maximum_shortfall,'0.0002');
    assert.equal(ingest(f,transfer(f,current)).order.status,'paid');
    assert.equal(raw(f,o).payable_amount,'1.000200000000000000');
  } finally {f.close();}
});

test('opt-in is strict true and native coins remain exact-only',()=>{
  for (const enabled of [false,undefined,'true',1]) {
    const f=fixture({enabled});
    try {
      f.s.config.payments.allowFingerprintUnderpayment=enabled;
      const o=order(f);
      assert.equal(o.payment_tolerance,null);
      assert.equal(ingest(f,transfer(f,o)).matched,false);
      assert.equal(ingest(f,transfer(f,o,o.payable_amount,{tx_hash:'exact'})).order.status,'paid');
    } finally {f.close();}
  }
  const f=fixture();
  try {
    const o=order(f,{token_id:'bsc-bnb'});
    assert.equal(o.payment_tolerance,null);
    assert.equal(ingest(f,transfer(f,o,'0.002')).matched,false);
  } finally {f.close();}
});

test('principal, locked merchant fees and upper amount bound cannot be waived',()=>{
  const f=fixture();
  try {
    f.s.updateProjectSettings(f.m,f.p.id,{fee_enabled:true,fee_percent:'1.00'});
    const o=order(f);
    assert.equal(o.payment_tolerance.minimum_amount,'1.01');
    assert.equal(ingest(f,transfer(f,o,'1.0')).matched,false);
    assert.equal(ingest(f,transfer(f,o,'1.009999999999999999',{tx_hash:'below-floor'})).matched,false);
    assert.equal(ingest(f,transfer(f,o,'1.02',{tx_hash:'above-maximum'})).matched,false);
    f.s.updateProjectSettings(f.m,f.p.id,{fee_enabled:false,fee_percent:'0'});
    assert.equal(f.s.orderView(raw(f,o)).payment_tolerance.minimum_amount,'1.01');
    assert.equal(ingest(f,transfer(f,o,'1.01',{tx_hash:'full-principal-and-fee'})).order.status,'paid');
  } finally {f.close();}
});

test('same-base and exact-plus-tolerance ambiguity persists until explicit manual claim',()=>{
  for (const exact of [false,true]) {
    const f=fixture();
    try {
      const a=order(f,{product_id:f.product.id}),b=order(f,{product_id:f.product.id});
      const tx=transfer(f,a,exact?a.payable_amount:'1.0');
      assert.equal(ingest(f,tx).matched,false);
      assert.equal(row(f,tx).reason,'ambiguous_amount');
      assert.equal(row(f,tx).order_id,null);
      f.s.cancel(f.m,a.order_id);
      assert.equal(ingest(f,{...tx,removed:true,confirmed:false}).matched,false);
      assert.equal(row(f,tx).reason,'ambiguous_amount');
      f.s.config.payments.allowFingerprintUnderpayment=false;
      assert.equal(ingest(f,tx).matched,false);
      assert.equal(row(f,tx).reason,'ambiguous_amount');
      f.s.config.payments.allowFingerprintUnderpayment=true;
      const paid=f.s.claim(f.m,txId(tx),b.order_id);
      assert.equal(paid.status,'paid');
      assert.equal(paid.paid_source,'manual');
      assert.equal(paid.received_amount,exact?'1.0001':'1.0');
      assert.equal(f.s.get("SELECT COUNT(*) AS n FROM audit WHERE action='merchant_claim'").n,1);
      ingest(f,tx);
      assert.equal(f.s.get('SELECT COUNT(*) AS n FROM inventory WHERE order_id IS NOT NULL').n,1);
    } finally {f.close();}
  }
});

test('closed old quotes block late/repeated omitted fingerprints from paying new orders',()=>{
  for (const status of ['expired','canceled','paid']) {
    const f=fixture();
    try {
      const a=order(f);
      shiftQuote(f,a,new Date(Date.now()-600000).toISOString(),new Date(Date.now()-300000).toISOString());
      f.s.run('UPDATE orders SET status=? WHERE order_id=?',status,a.order_id);
      const b=order(f),tx=transfer(f,b);
      assert.equal(ingest(f,tx).matched,false);
      assert.equal(row(f,tx).reason,'ambiguous_amount');
      assert.equal(raw(f,b).status,'pending');
      const oldExact=transfer(f,b,a.payable_amount,{tx_hash:'late-old-exact'});
      assert.equal(ingest(f,oldExact).matched,false);
      assert.equal(row(f,oldExact).reason,'ambiguous_amount');
      assert.equal(ingest(f,transfer(f,b,b.payable_amount,{tx_hash:'unique-new-exact'})).order.status,'paid');
      assert.equal(ingest(f,tx).matched,false);
      assert.equal(row(f,tx).reason,'ambiguous_amount');
    } finally {f.close();}
  }
});

test('superseded payment method reservations participate in ambiguity on the original chain',()=>{
  const f=fixture();
  try {
    const a=order(f,{allowed_methods:[{chain:'bsc',token_id:'bsc-usdt'},{chain:'ethereum',token_id:'ethereum-usdc'}]});
    f.s.selectMethod(raw(f,a),'ethereum','ethereum-usdc');
    const tx=transfer(f,a);
    assert.equal(ingest(f,tx).matched,false);
    assert.equal(row(f,tx).reason,'superseded_payment_method');
    const b=order(f);
    assert.equal(ingest(f,{...tx,tx_hash:'old-or-new'}).matched,false);
    assert.equal(row(f,{...tx,tx_hash:'old-or-new'}).reason,'ambiguous_amount');
    assert.equal(raw(f,b).status,'pending');
  } finally {f.close();}
});

test('confirmed transfer binding survives later competing orders and reorg without rebinding',()=>{
  const f=fixture();
  try {
    const a=order(f,{product_id:f.product.id});
    const tx=transfer(f,a,'1.0',{confirmations:1,confirmed:false});
    assert.equal(ingest(f,tx).order.status,'confirming');
    assert.equal(f.s.orderUsdAtomic(raw(f,a)),decimalAtomic(a.payable_amount,18));
    const b=order(f,{product_id:f.product.id});
    ingest(f,{...tx,removed:true});
    assert.equal(raw(f,a).status,'pending');
    assert.equal(row(f,tx).order_id,a.order_id);
    assert.throws(()=>f.s.claim(f.m,txId(tx),b.order_id));
    const replacement={...tx,block_hash:'replacement-block',block_height:101,
      block_time:new Date(Date.now()+3000).toISOString(),confirmations:15,confirmed:true};
    const paid=ingest(f,replacement).order;
    assert.equal(paid.order_id,a.order_id);
    assert.equal(paid.status,'paid');
    assert.equal(row(f,tx).block_time,replacement.block_time);
    assert.equal(raw(f,b).status,'pending');
    ingest(f,replacement);
    assert.equal(f.s.get('SELECT COUNT(*) AS n FROM inventory WHERE order_id IS NOT NULL').n,1);
  } finally {f.close();}
});

test('missing, malformed and inconsistent snapshots fail closed for tolerance but still accept exact payment',()=>{
  for (const mutate of [
    ()=>null,()=>'{bad json',
    s=>{delete s.price_numerator;return JSON.stringify(s);},
    s=>{s.price_denominator='0';return JSON.stringify(s);},
    s=>{s.base_payable_atomic='1';return JSON.stringify(s);},
    s=>{s.token_decimals=6;return JSON.stringify(s);},
    s=>{s.usd_target_atomic='1';return JSON.stringify(s);},
  ]) {
    const f=fixture();
    try {
      const o=order(f),q=f.s.orderQuote(raw(f,o));
      f.s.run('UPDATE amount_reservations SET pricing_json=? WHERE order_id=?',mutate(JSON.parse(q.pricing_json)),o.order_id);
      assert.equal(f.s.orderView(raw(f,o)).payment_tolerance,null);
      assert.equal(ingest(f,transfer(f,o)).matched,false);
      assert.equal(ingest(f,transfer(f,o,o.payable_amount,{tx_hash:'exact'})).order.status,'paid');
    } finally {f.close();}
  }
});

test('same-second pre-quote underpayment cannot pay a new quote automatically; exact boundary remains unchanged',()=>{
  const f=fixture();
  try {
    const o=order(f),second=Math.floor(Date.now()/1000)*1000;
    shiftQuote(f,o,new Date(second+800).toISOString(),new Date(second+60000).toISOString());
    const tx=transfer(f,o,'1.0',{block_time:new Date(second).toISOString()});
    assert.equal(ingest(f,tx).matched,false);
    assert.equal(raw(f,o).status,'pending');
    assert.equal(ingest(f,transfer(f,o,o.payable_amount,{tx_hash:'exact-same-second',block_time:tx.block_time})).order.status,'paid');
  } finally {f.close();}
});

test('same-second uncertain underpayment blocks another order exact-match candidate',()=>{
  const f=fixture();
  try {
    const a=order(f),b=order(f),second=Math.floor(Date.now()/1000)*1000;
    shiftQuote(f,a,new Date(second+100).toISOString(),new Date(second+60000).toISOString());
    shiftQuote(f,b,new Date(second+200).toISOString(),new Date(second+60000).toISOString());
    const tx=transfer(f,a,a.payable_amount,{block_time:new Date(second).toISOString()});
    assert.equal(ingest(f,tx).matched,false);
    assert.equal(row(f,tx).reason,'ambiguous_amount');
    assert.equal(raw(f,a).status,'pending');
    assert.equal(raw(f,b).status,'pending');
  } finally {f.close();}
});

test('wrong chain/token/address/mode and outside-window amounts never satisfy the order',()=>{
  const f=fixture();
  try {
    const o=order(f);
    const variants=[{chain:'tron'},{token_id:'bsc-usdc'},{to_address:'fixture:unknown'},
      {block_time:new Date(Date.parse(o.payment_started_at)-2000).toISOString()},
      {block_time:new Date(Date.parse(o.expires_at)+1000).toISOString()}];
    for(let i=0;i<variants.length;i++) assert.notEqual(ingest(f,transfer(f,o,'1.0',{tx_hash:'wrong-'+i,...variants[i]})).matched,true);
    assert.equal(f.s.ingest(transfer(f,o),{mode:'demo'}).ignored,true);
    assert.equal(raw(f,o).status,'pending');
    const p=f.s.createProject(f.m,{name:'Other project'});
    f.s.addAddress(f.m,{project_id:p.id,chain:'bsc',address:'fixture:other-project'});
    const tx=transfer(f,o,'1.0',{to_address:'fixture:other-project',tx_hash:'other-project'});
    assert.equal(ingest(f,tx).matched,false);
    assert.throws(()=>f.s.claim(f.m,txId(tx),o.order_id),e=>e.code==='CLAIM_REJECTED');
    const other=f.s.register({email:'other@example.test',password:'fixture-password-123'});
    assert.throws(()=>f.s.claim(other,txId(tx),o.order_id),e=>e.code==='NOT_FOUND');
  } finally {f.close();}
});

test('expired order requires audited manual claim and paid GMV uses actual receipt at locked price',()=>{
  const f=fixture();
  try {
    const o=order(f,{product_id:f.product.id}),tx=transfer(f,o);
    f.s.run("UPDATE orders SET status='expired' WHERE order_id=?",o.order_id);
    assert.equal(ingest(f,tx).matched,false);
    assert.equal(row(f,tx).reason,'expired_order_requires_review');
    assert.equal(raw(f,o).status,'expired');
    f.s.priceBook.recordAsset('USDT','1.2');
    const paid=f.s.claim(f.m,txId(tx),o.order_id);
    assert.equal(paid.status,'paid');
    assert.equal(paid.paid_source,'manual');
    assert.equal(paid.received_amount,'1.0');
    assert.equal(f.s.orderUsdAtomic(raw(f,o)),decimalAtomic('1',18));
    assert.equal(f.s.get('SELECT COUNT(*) AS n FROM inventory WHERE order_id IS NOT NULL').n,1);
  } finally {f.close();}
});

test('original fingerprint USD and percentage ceilings are still required for tolerance',()=>{
  for(const price of ['1.00','0.01']) {
    const f=fixture();
    try {
      const o=order(f,{fiat_amount:price});
      const q=f.s.orderQuote(raw(f,o)),s=JSON.parse(q.pricing_json);
      const bad=decimalAtomic(price,18)+decimalAtomic('0.02',18);
      s.usd_atomic=bad.toString();
      f.s.run('UPDATE amount_reservations SET payable_atomic=?,pricing_json=? WHERE order_id=?',bad.toString(),JSON.stringify(s),o.order_id);
      f.s.run('UPDATE orders SET payable_atomic=?,payable_amount=? WHERE order_id=?',bad.toString(),formatAtomic(bad,18),o.order_id);
      assert.equal(f.s.orderView(raw(f,o)).payment_tolerance,null);
      assert.equal(ingest(f,transfer(f,o,price)).matched,false);
    } finally {f.close();}
  }
});

test('real market and FX snapshots protect the floor including fee and value actual receipts without repricing',()=>{
  const f=fixture();
  try {
    f.s.config.pricing.stablePolicy='market';
    f.s.priceBook.recordAsset('USDT','1.25');
    f.s.priceBook.recordFiatUsd('CNY','0.14');
    f.s.updateProjectSettings(f.m,f.p.id,{fee_enabled:true,fee_percent:'1.00'});
    const o=order(f,{fiat_amount:'7.00',fiat_currency:'CNY'});
    assert.equal(o.fiat_total,'7.07');
    assert.equal(o.payment_tolerance.minimum_amount,'0.79184');
    assert.equal(ingest(f,transfer(f,o,'0.784',{tx_hash:'missing-merchant-fee'})).matched,false);
    f.s.priceBook.recordAsset('USDT','2.0');
    f.s.priceBook.recordFiatUsd('CNY','0.5');
    const paid=ingest(f,transfer(f,o,'0.79184')).order;
    assert.equal(paid.received_amount,'0.79184');
    assert.equal(f.s.orderUsdAtomic(raw(f,o)),decimalAtomic('0.9898',18));
    f.s.run('UPDATE amount_reservations SET pricing_json=NULL WHERE order_id=?',o.order_id);
    assert.throws(()=>f.s.orderUsdAtomic(raw(f,o)),e=>e.code==='PRICE_SNAPSHOT_MISSING');
  } finally {f.close();}
});

test('demo confirmation control preserves the actual amount of an already bound underpayment',()=>{
  const f=fixture({mode:'demo'});
  try {
    const o=order(f),tx=transfer(f,o,'1.0',{confirmed:false,confirmations:1});
    assert.equal(ingest(f,tx).order.status,'confirming');
    const paid=f.s.simulate(f.m,o.order_id);
    assert.equal(paid.status,'paid');
    assert.equal(paid.received_amount,'1.0');
    assert.equal(row(f,tx).amount_atomic,decimalAtomic('1',18).toString());
  } finally {f.close();}
});

test('manual review for missing inventory preserves manual source and bound receipt on later delivery',()=>{
  const f=fixture();
  try {
    const o=order(f,{product_id:f.product.id}),tx=transfer(f,o);
    f.s.run('DELETE FROM inventory');
    f.s.run("UPDATE orders SET status='expired' WHERE order_id=?",o.order_id);
    ingest(f,tx);
    const review=f.s.claim(f.m,txId(tx),o.order_id);
    assert.equal(review.status,'review');
    assert.equal(review.paid_source,'manual');
    assert.equal(review.received_amount,'1.0');
    f.s.importInventory(f.m,f.product.id,['LATER-LICENSE']);
    f.s.config.payments.allowFingerprintUnderpayment=false;
    const paid=ingest(f,tx).order;
    assert.equal(paid.status,'paid');
    assert.equal(paid.paid_source,'manual');
    assert.equal(paid.delivery,'LATER-LICENSE');
    assert.equal(f.s.orderUsdAtomic(raw(f,o)),decimalAtomic('1',18));
  } finally {f.close();}
});
