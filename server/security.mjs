import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail, hash, nowISO, passwordHash, passwordValid } from './core.mjs';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode32(value){let bits=0,n=0;const out=[];for(const c of value){const index=alphabet.indexOf(c);if(index<0)throw new Error('Invalid TOTP secret');n=(n<<5)|index;bits+=5;if(bits>=8){out.push((n>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totpAt(secret,counter){const buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(counter));const digest=createHmac('sha1',decode32(secret)).update(buf).digest();const offset=digest.at(-1)&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
const equal=(a,b)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);

export function registerSecurity(app,{store,clock=()=>Date.now()}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS account_security(
    merchant_id TEXT PRIMARY KEY,secret TEXT,pending_secret TEXT,pending_expires INTEGER,
    enabled INTEGER NOT NULL DEFAULT 0,last_counter INTEGER NOT NULL DEFAULT -1,
    recovery_hashes TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL
  );`);
  const state=m=>store.get('SELECT * FROM account_security WHERE merchant_id=?',m.id);
  const merchant=req=>req.merchant||fail('UNAUTHORIZED','请先登录',401);
  const password=(m,value)=>{if(!passwordValid(value,m.password))fail('INVALID_CREDENTIALS','当前密码不正确',401);};
  function counterFor(secret,code,last=-1){if(!/^\d{6}$/.test(String(code??'')))return null;const now=Math.floor(clock()/30000);for(const counter of [now,now-1,now+1])if(counter>last&&equal(totpAt(secret,counter),String(code)))return counter;return null;}
  function verify(m,code){const initial=state(m);if(!initial?.enabled)return;if(!code)fail('TOTP_REQUIRED','请输入两步验证码或恢复码',401);return store.transaction(()=>{const row=state(m);const counter=counterFor(store.decrypt(row.secret),code,row.last_counter);if(counter!==null){store.run('UPDATE account_security SET last_counter=?,updated_at=? WHERE merchant_id=?',counter,nowISO(),m.id);return;}
      const recovery=String(code).replaceAll('-','').toUpperCase();
      if(/^[A-F0-9]{20}$/.test(recovery)){const hashes=JSON.parse(row.recovery_hashes);const index=hashes.indexOf(hash(recovery));if(index!==-1){hashes.splice(index,1);store.run('UPDATE account_security SET recovery_hashes=?,updated_at=? WHERE merchant_id=?',JSON.stringify(hashes),nowISO(),m.id);store.audit(m.id,'security.recovery_code_used',m.id);return;}}
      fail('INVALID_TOTP','验证码无效、已使用或已过期',401);
    });}
  store.verifySecondFactor=verify;
  app.get('/api/security',wrap((req,res)=>{const m=merchant(req),s=state(m);res.json({totp_enabled:!!s?.enabled,recovery_codes_remaining:s?.enabled?JSON.parse(s.recovery_hashes).length:0,email_change_enabled:false,telegram_enabled:false});}));
  app.post('/api/security/totp/start',wrap((req,res)=>{const m=merchant(req);password(m,req.body.current_password);if(state(m)?.enabled)fail('TOTP_ALREADY_ENABLED','两步验证已经启用',409);const secret=base32(randomBytes(20));store.run(`INSERT INTO account_security(merchant_id,pending_secret,pending_expires,updated_at) VALUES(?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET pending_secret=excluded.pending_secret,pending_expires=excluded.pending_expires,updated_at=excluded.updated_at`,m.id,store.encrypt(secret),clock()+600000,nowISO());res.json({secret,otpauth_url:`otpauth://totp/${encodeURIComponent('Avenora Pay:'+m.email)}?secret=${secret}&issuer=Avenora%20Pay&algorithm=SHA1&digits=6&period=30`});}));
  app.post('/api/security/totp/confirm',wrap((req,res)=>{const m=merchant(req);const codes=store.transaction(()=>{const row=state(m);if(!row?.pending_secret||row.pending_expires<clock()||row.enabled)fail('TOTP_SETUP_EXPIRED','请重新发起两步验证设置',409);const counter=counterFor(store.decrypt(row.pending_secret),req.body.otp);if(counter===null)fail('INVALID_TOTP','验证码不正确',400);const codes=Array.from({length:8},()=>randomBytes(10).toString('hex').toUpperCase());store.run('UPDATE account_security SET secret=pending_secret,pending_secret=NULL,pending_expires=NULL,enabled=1,last_counter=?,recovery_hashes=?,updated_at=? WHERE merchant_id=?',counter,JSON.stringify(codes.map(hash)),nowISO(),m.id);store.audit(m.id,'security.totp_enabled',m.id);return codes.map(c=>c.match(/.{1,5}/g).join('-'));});res.json({enabled:true,recovery_codes:codes});}));
  app.post('/api/security/totp/disable',wrap((req,res)=>{const m=merchant(req);password(m,req.body.current_password);if(!state(m)?.enabled)fail('TOTP_DISABLED','两步验证尚未启用',409);store.transaction(()=>{verify(m,req.body.otp);store.run('UPDATE account_security SET secret=NULL,pending_secret=NULL,pending_expires=NULL,enabled=0,last_counter=-1,recovery_hashes=\'[]\',updated_at=? WHERE merchant_id=?',nowISO(),m.id);store.run('DELETE FROM sessions WHERE merchant_id=?',m.id);store.audit(m.id,'security.totp_disabled',m.id);});res.json({enabled:false,relogin_required:true});}));
  app.post('/api/security/password',wrap((req,res)=>{const m=merchant(req);password(m,req.body.current_password);if(typeof req.body.new_password!=='string'||req.body.new_password.length<12)fail('WEAK_PASSWORD','新密码至少需要 12 个字符');if(req.body.new_password===req.body.current_password)fail('PASSWORD_UNCHANGED','新密码不能与原密码相同');const encoded=passwordHash(req.body.new_password);store.transaction(()=>{verify(m,req.body.otp);store.run('UPDATE merchants SET password=? WHERE id=?',encoded,m.id);store.run('DELETE FROM sessions WHERE merchant_id=?',m.id);store.audit(m.id,'security.password_changed',m.id);});res.json({ok:true,relogin_required:true});}));
  return {verify,counterFor};
}
