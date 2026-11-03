import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],
  ['224.0.0.0',4],['240.0.0.0',4],
]) blocked.addSubnet(ip, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::',3,'ipv6');
for (const [ip,prefix] of [['2001::',32],['2001:db8::',32],['2002::',16]]) blocked.addSubnet(ip,prefix,'ipv6');

export function isPublicIp(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address,'ipv4');
  if (family === 6) return global6.check(address,'ipv6') && !blocked.check(address,'ipv6');
  return false;
}

export function validateWebhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Webhook 地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Webhook 需要不含用户凭据的 HTTPS 公网地址，端口为 443');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      (isIP(hostname) && !isPublicIp(hostname))) throw new Error('Webhook 不可指向本机或私有网络');
  return url;
}

async function resolvePublic(hostname, resolver, timeoutMs) {
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  let timer;
  try {
    const answers = await Promise.race([
      resolver(hostname, {all:true,verbatim:true}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Webhook DNS 查询超时')),timeoutMs);}),
    ]);
    if (!answers.length || answers.some(a=>!isPublicIp(a.address))) throw new Error('Webhook DNS 返回了非公网地址');
    return answers[0];
  } finally {clearTimeout(timer);}
}

/** Resolves and pins a public IP for each attempt; never follows redirects. */
export async function safeWebhookPost(value, {body,headers={},timeoutMs=10000,resolver=lookup}={}) {
  const url = validateWebhookUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const started = Date.now();
  const resolved = await resolvePublic(host,resolver,timeoutMs);
  const payload = Buffer.isBuffer(body)?body:Buffer.from(body??'');
  if(payload.length>1024*1024) throw new Error('Webhook 数据超过限制');
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const request=https.request(url,{
      method:'POST',agent:false,servername:isIP(host)?undefined:host,
      lookup:(_hostname,options,callback)=> options?.all
        ? callback(null,[resolved]) : callback(null,resolved.address,resolved.family),
      headers:{...headers,'Content-Type':'application/json','Content-Length':String(payload.length)},
    },response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>65536){response.destroy();request.destroy();finish(new Error('Webhook 响应超过限制'));}else chunks.push(chunk);});
      response.on('end',()=>finish(null,{status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
      response.on('error',error=>finish(error));
    });
    const timer=setTimeout(()=>request.destroy(new Error('Webhook 请求超时')),Math.max(1,timeoutMs-(Date.now()-started)));
    request.on('error',error=>finish(error));
    request.end(payload);
  });
}
