import test from 'node:test';
import assert from 'node:assert/strict';
import { scanChain } from '../server/chains.mjs';
import { encodeReferenceTransfer, decodeReferenceTransfer, PAYMENT_REFERENCE_MAGIC } from '../server/payment-reference.mjs';

const receiver='0x'+'1'.repeat(40),payer='0x'+'2'.repeat(40),contract='0x'+'3'.repeat(40);
const txHash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),reference='0x'+'c'.repeat(64);
const atomic='1000000000000000000';
const calldata=encodeReferenceTransfer({recipient:receiver,amountAtomic:atomic,reference});
const topic=a=>'0x'+a.slice(2).padStart(64,'0');
function fixture(change=()=>{}) {
  const log={address:contract,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(payer),topic(receiver)],data:'0x'+BigInt(atomic).toString(16).padStart(64,'0'),transactionHash:txHash,blockHash,blockNumber:'0x64',logIndex:'0x2',removed:false};
  const block={number:'0x64',hash:blockHash,parentHash:'0x'+'d'.repeat(64),timestamp:'0x6553f100',transactions:[]};
  const receipt={status:'0x1',transactionHash:txHash,blockHash,blockNumber:'0x64',transactionIndex:'0x1',logs:[log]};
  const tx={hash:txHash,blockHash,blockNumber:'0x64',transactionIndex:'0x1',to:contract,from:payer,value:'0x0',input:calldata};
  const state={log,block,receipt,tx,enabled:true};change(state);
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body.method);
    const result={eth_chainId:'0x38',eth_blockNumber:'0x80',eth_getBlockByNumber:state.block,eth_call:'0x12',eth_getLogs:[state.log],eth_getTransactionReceipt:state.receipt,eth_getTransactionByHash:state.tx}[body.method];
    if(result===undefined)throw Error('Unexpected RPC '+body.method);
    return{ok:true,text:async()=>JSON.stringify({jsonrpc:'2.0',id:body.id,result})};
  };
  return {calls,scan:()=>scanChain({chain:'bsc',addresses:[receiver],fromBlock:100,toBlock:100,config:{enabled:true,chainId:56,startBlock:1,rpcUrl:'https://fixture.invalid',tokens:[{id:'bsc-usdt',contract,decimals:18,paymentReference:state.enabled}]},fetchImpl})};
}

test('reference transfer encoding is exact uint256 and rejects truncation, wrong selector and secret-like input',()=>{
  assert.equal(calldata.length,266);
  assert.deepEqual(decodeReferenceTransfer(calldata),{recipient:receiver,amount_atomic:atomic,reference});
  for(const input of [calldata.slice(0,-2),calldata+'00',calldata.replace('a9059cbb','095ea7b3'),calldata.replace(PAYMENT_REFERENCE_MAGIC,'0'.repeat(64)),calldata.slice(0,202)+'0'.repeat(64)])assert.equal(decodeReferenceTransfer(input),null);
  for(const amountAtomic of ['0','-1','1.0',String(2n**256n)])assert.throws(()=>encodeReferenceTransfer({recipient:receiver,amountAtomic,reference}));
});

test('scanner attaches an order reference only to its canonical successful direct token transfer',async()=>{
  const f=fixture(),result=await f.scan();
  assert.equal(result.transactions.length,1);
  assert.equal(result.transactions[0].payment_reference,reference);
  assert.equal(result.transactions[0].confirmed,true);
  assert.equal(result.transactions[0].amount_atomic,atomic);
  assert.equal(f.calls.filter(x=>x==='eth_getTransactionByHash').length,1);
});

test('legacy standard transfers and disabled reference tokens do not invent payment references',async()=>{
  for(const change of [s=>{s.tx.input=calldata.slice(0,138);},s=>{s.enabled=false;}]){
    const f=fixture(change),result=await f.scan();
    assert.equal(result.transactions[0].payment_reference,undefined);
    assert.equal(result.transactions[0].payment_reference_invalid,undefined);
    if(!f.calls.includes('eth_getTransactionByHash'))assert.equal(f.calls.filter(x=>x==='eth_getLogs').length,1);
  }
});

test('reference evidence cannot be borrowed from another sender, destination, amount or wrapped call',async()=>{
  for(const change of [
    s=>{s.tx.from='0x'+'4'.repeat(40);},s=>{s.tx.to='0x'+'5'.repeat(40);},s=>{s.tx.value='0x1';},
    s=>{s.tx.input=encodeReferenceTransfer({recipient:payer,amountAtomic:atomic,reference});},
    s=>{s.tx.input=encodeReferenceTransfer({recipient:receiver,amountAtomic:'2',reference});},
    s=>{s.tx.input=calldata.replace('a9059cbb','095ea7b3');},
  ]){
    const {transactions}=await fixture(change).scan();
    assert.equal(transactions[0].payment_reference,undefined);
    assert.equal(transactions[0].payment_reference_invalid,true);
  }
});

test('missing or noncanonical transaction input stops scanning rather than advancing with unverified attribution',async()=>{
  for(const change of [s=>{s.tx=null;},s=>{delete s.tx.input;},s=>{s.tx.input='0x123';},s=>{s.tx.hash='0x'+'f'.repeat(64);},s=>{s.tx.blockHash='0x'+'f'.repeat(64);},s=>{s.tx.transactionIndex='0x2';}])
    await assert.rejects(fixture(change).scan(),/reference_transaction_unavailable/);
  const failed=await fixture(s=>{s.receipt.status='0x0';}).scan();
  assert.equal(failed.transactions.length,0);
});
