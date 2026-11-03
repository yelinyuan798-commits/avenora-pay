import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
if(!existsSync(new URL('../node_modules/',import.meta.url))) {
  const install=spawnSync('npm',['ci','--no-audit','--no-fund'],{cwd,stdio:'inherit'});
  if(install.status!==0)process.exit(install.status||1);
}
const build=spawnSync('npm',['run','build'],{cwd,stdio:'inherit'});
if(build.status!==0)process.exit(build.status||1);
const child=spawn(process.execPath,['server/index.mjs'],{cwd,env:{...process.env,NODE_ENV:'development',APP_MODE:'demo',HOST:'127.0.0.1'},stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code||0));
