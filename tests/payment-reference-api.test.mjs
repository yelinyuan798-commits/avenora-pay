import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core.mjs';
import { createApp } from '../server/app.mjs';
import { registry, configuredTokens, validateAddress, scanChain } from '../server/chains.mjs';

const receiver='0x'+'1'.repeat(40),payer='0x'+'2'.repeat(40),contract='0x'+'3'.repeat(40);
async function fixture(t,{mode='demo',appMode=mode}={}) {
  const config={pricing:{stablePolicy:'parity'},bsc:{enabled:true,chainId:56,startBlock:1,rpcUrl:'https://fixture.invalid',tokens:[{id:'bsc-usdt',contract,decimals:18,paymentReference:true}]}};
  const store=new Store({registry,configuredTokens,validateAddress,config});
  const merchant=store.register({email:'api-reference@example.test',password:'fixture-password-123'},mode);
  const other=store.register({email:'other-reference@example.test',password:'fixture-password-123'},mode);
  const project=store.createProject(merchant,{name:'Same price'});
  store.addAddress(merchant,{project_id:project.id,chain:'bsc',address:mode==='demo'?'demo:shared':receiver});
  const product=store.createProduct(merchant,{project_id:project.id,name:'Same price product',price:'1.00',currency:'USD'});
  store.importInventory(merchant,product.id,['DEMO-ONE','DEMO-TWO','DEMO-THREE']);
  const app=createApp({store,mode:appMode});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const cookie='djp_session='+store.session(merchant),otherCookie='djp_session='+store.session(other);
  t.after(()=>{server.close();store.close();});
  async function req(path,{method='GET',body,headers={}}={}) {
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  return {store,merchant,project,product,config,req,base,cookie,otherCookie,
    headers:{Cookie:cookie,Origin:base},
    order:()=>store.createOrder(merchant,{project_id:project.id,product_id:product.id,chain:'bsc',token_id:'bsc-usdt'})};
}

test('payment policy is authenticated, tenant scoped, CSRF protected and frozen per order',async t=>{
  const f=await fixture(t),path=`/api/projects/${f.project.id}/payment-policy`;
  assert.equal((await f.req('/api/payment-policies')).status,401);
  assert.equal((await f.req(path,{method:'PUT',headers:{Cookie:f.cookie},body:{payment_mode:'reference'}})).status,403);
  assert.equal((await f.req(path,{method:'PUT',headers:{Cookie:f.otherCookie,Origin:f.base},body:{payment_mode:'reference'}})).status,404);
  const old=f.order();assert.equal(old.payment_mode,'amount');
  const updated=await f.req(path,{method:'PUT',headers:f.headers,body:{payment_mode:'reference'}});
  assert.deepEqual(updated.body,{project_id:f.project.id,payment_mode:'reference'});
  assert.equal((await f.req('/api/payment-policies',{headers:f.headers})).body.policies[0].payment_mode,'reference');
  const next=f.order();assert.equal(next.payment_mode,'reference');assert.equal(next.payable_amount,'1.0');
  const oldState=(await f.req(`/checkout/${old.checkout_token}/state`)).body;
  assert.equal(oldState.payment_mode,'amount');assert.equal(oldState.payable_amount,old.payable_amount);
  const methods=(await f.req(`/checkout/${next.checkout_token}/methods`)).body.methods;
  assert.deepEqual(methods,[{chain:'bsc',token_id:'bsc-usdt'}]);
});

test('same-price checkout demo pays two orders in reverse order and never exposes broadcastable data',async t=>{
  const f=await fixture(t);f.store.setPaymentPolicy(f.merchant,f.project.id,{payment_mode:'reference'});
  const a=f.order(),b=f.order();
  assert.equal(a.pay_address,b.pay_address);assert.equal(a.payable_amount,b.payable_amount);
  for(const o of [b,a]) {
    const state=(await f.req(`/checkout/${o.checkout_token}/state`)).body;
    assert.equal(state.wallet_payment,null);assert.equal(state.checkout_token,undefined);assert.equal(state.delivery,null);
    const result=await f.req(`/checkout/${o.checkout_token}/demo-pay`,{method:'POST',body:{amount:'999',payment_reference:'fake',confirmations:0}});
    assert.equal(result.status,200);assert.equal(result.body.status,'paid');assert.match(result.body.delivery,/DEMO-/);
    assert.equal(result.body.received_amount,'1.0');assert.equal(result.body.checkout_token,undefined);
    await f.req(`/checkout/${o.checkout_token}/demo-pay`,{method:'POST',body:{}});
  }
  assert.equal(f.store.get('SELECT COUNT(*) n FROM inventory WHERE order_id IS NOT NULL').n,2);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n,2);
  const canceled=f.order();f.store.cancel(f.merchant,canceled.order_id);
  assert.equal((await f.req(`/checkout/${canceled.checkout_token}/demo-pay`,{method:'POST',body:{}})).status,409);
});

test('public simulation cannot settle live orders or demo orders on a live instance',async t=>{
  for(const options of [{mode:'live',appMode:'demo'},{mode:'live'},{mode:'demo',appMode:'live'}]) {
    const f=await fixture(t,options);f.store.setPaymentPolicy(f.merchant,f.project.id,{payment_mode:'reference'});
    const o=f.order();
    const response=await f.req(`/checkout/${o.checkout_token}/demo-pay`,{method:'POST',body:{}});
    assert.equal(response.status,403);assert.equal(f.store.ownedOrder(f.merchant,o.order_id).status,'pending');
    assert.equal(f.store.get('SELECT COUNT(*) n FROM transfers').n,0);
  }
});

test('canonical chain scan through public checkout settles identical prices by reference and delivers once',async t=>{
  const f=await fixture(t,{mode:'live'});f.store.setPaymentPolicy(f.merchant,f.project.id,{payment_mode:'reference'});
  const orders=[f.order(),f.order()];
  const blockHash='0x'+'a'.repeat(64),topic=a=>'0x'+a.slice(2).padStart(64,'0');
  // Move only fixture timestamps back to avoid whole-second block clock skew.
  const started=new Date(Date.now()-5000).toISOString();
  f.store.run('UPDATE orders SET payment_started_at=?',started);f.store.run('UPDATE amount_reservations SET created_at=?',started);
  const entries=orders.map((o,i)=>{
    const txHash='0x'+String(i+4).repeat(64);
    const log={address:contract,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(payer),topic(receiver)],data:'0x'+BigInt(o.wallet_payment.amount_atomic).toString(16).padStart(64,'0'),transactionHash:txHash,blockHash,blockNumber:'0x64',logIndex:'0x'+i,removed:false};
    return {log,tx:{hash:txHash,blockHash,blockNumber:'0x64',transactionIndex:'0x'+i,to:contract,from:payer,value:'0x0',input:o.wallet_payment.data},receipt:{status:'0x1',transactionHash:txHash,blockHash,blockNumber:'0x64',transactionIndex:'0x'+i,logs:[log]}};
  });
  const fetchImpl=async(_url,options)=>{
    const {method,params,id}=JSON.parse(options.body);let result;
    if(method==='eth_chainId')result='0x38';
    else if(method==='eth_blockNumber')result='0x80';
    else if(method==='eth_getBlockByNumber')result={number:'0x64',hash:blockHash,parentHash:'0x'+'b'.repeat(64),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]};
    else if(method==='eth_call')result='0x12';
    else if(method==='eth_getLogs')result=entries.map(e=>e.log).reverse();
    else if(method==='eth_getTransactionReceipt')result=entries.find(e=>e.tx.hash===params[0]).receipt;
    else if(method==='eth_getTransactionByHash')result=entries.find(e=>e.tx.hash===params[0]).tx;
    else throw Error(method);
    return {ok:true,text:async()=>JSON.stringify({jsonrpc:'2.0',id,result})};
  };
  const scan=await scanChain({chain:'bsc',addresses:[receiver],fromBlock:100,toBlock:100,config:f.config.bsc,fetchImpl});
  assert.equal(scan.transactions.length,2);
  for(const tx of scan.transactions){f.store.ingest(tx);f.store.ingest(tx);}
  const delivered=[];
  for(const o of orders){const state=(await f.req(`/checkout/${o.checkout_token}/state`)).body;assert.equal(state.status,'paid');assert.equal(state.paid_source,'chain');assert.equal(state.received_amount,'1.0');delivered.push(state.delivery);}
  assert.equal(new Set(delivered).size,2);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM deliveries WHERE event_type='order.paid'").n,2);
});
