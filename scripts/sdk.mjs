import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export function canonicalQuery(query='') {
  const entries=[...new URLSearchParams(query).entries()];
  entries.sort(([ka,va],[kb,vb])=>ka<kb?-1:ka>kb?1:va<vb?-1:va>vb?1:0);
  return entries.map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

export function signedHeaders({keyId,secret,method,path,query='',body='',timestamp=Math.floor(Date.now()/1000),nonce=randomUUID()}) {
  const digest=createHash('sha256').update(body).digest('hex');
  const material=[method.toUpperCase(),path,canonicalQuery(query),digest,String(timestamp),nonce].join('\n');
  return {'DJP-Key-ID':keyId,'DJP-Timestamp':String(timestamp),'DJP-Nonce':nonce,'DJP-Signature':createHmac('sha256',secret).update(material).digest('hex')};
}

export function verifyWebhook({secret,headers,rawBody,now=Math.floor(Date.now()/1000),tolerance=300}) {
  const get=name=>typeof headers.get==='function'?headers.get(name):headers[name]??headers[Object.keys(headers).find(k=>k.toLowerCase()===name)];
  const timestamp=get('djp-webhook-timestamp');
  const signature=get('djp-webhook-signature');
  if(!/^\d{10,}$/.test(String(timestamp)) || Math.abs(Number(timestamp)-now)>tolerance || !/^[0-9a-f]{64}$/.test(signature??'')) return false;
  const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}

export class PaymentClient {
  constructor({baseUrl,keyId,secret,fetchImpl=fetch}) {
    this.baseUrl=new URL(baseUrl);
    if(this.baseUrl.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(this.baseUrl.hostname)) throw new Error('Payment API requires HTTPS');
    if(this.baseUrl.username||this.baseUrl.password)throw new Error('Do not place credentials in the API URL');
    this.keyId=keyId;this.secret=secret;this.fetchImpl=fetchImpl;
  }
  async request(method,path,{data,query='',idempotencyKey}={}) {
    const body=data===undefined?'':JSON.stringify(data);
    const headers=signedHeaders({keyId:this.keyId,secret:this.secret,method,path,query,body});
    if(body)headers['Content-Type']='application/json';
    if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
    const url=new URL(path+(query?`?${query}`:''),this.baseUrl);
    const response=await this.fetchImpl(url,{method,headers,body:body||undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok){const error=new Error(result.error?.message??`Payment API HTTP ${response.status}`);error.code=result.error?.code;error.status=response.status;throw error;}
    return result;
  }
  createOrder(data,idempotencyKey){return this.request('POST','/v1/orders',{data,idempotencyKey});}
  getOrder(id){return this.request('GET',`/v1/orders/${encodeURIComponent(id)}`);}
  listOrders(filters={}){return this.request('GET','/v1/orders',{query:new URLSearchParams(filters).toString()});}
  cancelOrder(id){return this.request('POST',`/v1/orders/${encodeURIComponent(id)}/cancel`);}
  whoami(){return this.request('GET','/v1/whoami');}
}
