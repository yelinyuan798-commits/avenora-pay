import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp, validateWebhookUrl, safeWebhookPost } from '../server/net.mjs';

test('webhooks reject loopback, metadata, private, mapped IPv6, and reserved IPs',()=>{
  for(const ip of ['127.0.0.1','10.0.0.4','172.16.1.2','192.168.9.9','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicIp(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicIp(ip),true,ip);
});
test('URL validation blocks alternate IP encodings and credentials',()=>{
  for(const url of ['http://example.com','https://127.1','https://2130706433','https://0x7f000001','https://[::1]','https://user:password@example.com','https://example.com:8443','https://localhost','https://x.local']) assert.throws(()=>validateWebhookUrl(url),url);
  assert.equal(validateWebhookUrl('https://shop.example.com/pay/callback').pathname,'/pay/callback');
});
test('DNS private or mixed resolution is rejected before connecting',async()=>{
  for(const answers of [[{address:'127.0.0.1',family:4}],[{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}]]) {
    await assert.rejects(safeWebhookPost('https://shop.example.com/hook',{body:'{}',resolver:async()=>answers}),/非公网/);
  }
});
test('DNS failures and timeouts are bounded and surfaced',async()=>{
  await assert.rejects(safeWebhookPost('https://shop.example.com/hook',{timeoutMs:20,resolver:()=>new Promise(()=>{})}),/超时/);
});
