import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {canonicalQuery,signedHeaders,verifyWebhook,PaymentClient} from '../scripts/sdk.mjs';

test('canonical query sorts repeated keys and percent encodes spaces',()=>{
  assert.equal(canonicalQuery('b=z&a=hello+world&a=alpha&b=a'),'a=alpha&a=hello%20world&b=a&b=z');
});
test('Dujiao six line canonical signing is deterministic',()=>{
  const input={keyId:'fixture',secret:'fixture-secret',method:'get',path:'/v1/whoami',timestamp:1750000000,nonce:'fixture-nonce'};
  const material='GET\n/v1/whoami\n\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1750000000\nfixture-nonce';
  assert.equal(signedHeaders(input)['DJP-Signature'],createHmac('sha256',input.secret).update(material).digest('hex'));
});
test('webhook signature verifies original bytes and rejects stale or altered content',()=>{
  const now=1750000000,secret='fixture-secret',rawBody=Buffer.from('{ "event_type": "order.paid" }');
  const headers={'djp-webhook-timestamp':String(now),'djp-webhook-signature':createHmac('sha256',secret).update(`${now}.`).update(rawBody).digest('hex')};
  assert.equal(verifyWebhook({secret,headers,rawBody,now}),true);
  assert.equal(verifyWebhook({secret,headers,rawBody:Buffer.from('{}'),now}),false);
  assert.equal(verifyWebhook({secret,headers,rawBody,now:now+301}),false);
  assert.equal(verifyWebhook({secret,headers:{...headers,'djp-webhook-signature':'xx'},rawBody,now}),false);
});
test('SDK never follows redirects with signed authorization',async()=>{
  let observed;
  const client=new PaymentClient({baseUrl:'https://merchant.example.com',keyId:'fixture',secret:'fixture-secret',fetchImpl:async(url,options)=>{observed={url,options};return {ok:true,json:async()=>({order_id:'fixture'})};}});
  await client.createOrder({fiat_amount:'1.00',fiat_currency:'USD'},'fixture-order');
  assert.equal(observed.options.redirect,'error');
  assert.equal(observed.options.headers['Idempotency-Key'],'fixture-order');
  assert.equal(observed.url.pathname,'/v1/orders');
});
