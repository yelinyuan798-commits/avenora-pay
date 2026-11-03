import { defineConfig } from 'vite';
export default defineConfig({root:'client',build:{outDir:'../dist',emptyOutDir:true},server:{host:'127.0.0.1',port:5177,proxy:{'/api':'http://127.0.0.1:8787','/v1':'http://127.0.0.1:8787','/checkout-api':'http://127.0.0.1:8787'}}});
