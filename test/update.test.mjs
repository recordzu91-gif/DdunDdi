import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp,SupabaseStore} from '../server.mjs';
import {credentials} from '../domain.mjs';

test('existing deployment survives update; monthly PDF permissions and editing',async t=>{
  const auth=await credentials('existing-password');
  const member=(id,role)=>({id,role,name:id,username:id,className:'2-3',participation:'both',mustReset:false,sessionVersion:0,auth});
  const oldPhoto='/api/photos/11111111-1111-1111-1111-111111111111';
  const oldRecord={id:'existing',memberId:'alice',kind:'study',date:'2026-09-29',minutes:120,image:oldPhoto,images:[oldPhoto],memo:'기존 기록',visibility:'private',updatedAt:'2026-09-29T00:00:00Z',comments:[],reactions:{}};
  const original={revision:42,members:[member('teacher','teacher'),member('alice','student'),member('bobby','student')],records:[oldRecord],periods:[],schoolYear:2026};
  const store={data:structuredClone(original),async ping(){},async load(){return structuredClone(this.data)},async save(d,r){assert.equal(r,this.data.revision);this.data=structuredClone({...d,revision:r+1});return this.load()},async readPdf(){return {bytes:Buffer.from('%PDF-1.4\n%%EOF')}}};
  const origin='http://localhost',app=createApp({store,origin,secret:'unchanged-session-secret-1234567890'});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
  const base='http://127.0.0.1:'+app.address().port;
  const client={};
  async function request(who,path,payload,method=payload===undefined?'GET':'POST'){
    const res=await fetch(base+path,{method,headers:{origin,'Content-Type':'application/json',cookie:client[who]||''},body:payload===undefined?undefined:JSON.stringify(payload)});
    if(res.headers.has('set-cookie'))client[who]=res.headers.get('set-cookie').split(';')[0];
    return {status:res.status,body:await res.json()};
  }
  for(const name of ['teacher','alice','bobby'])assert.equal((await request(name,'/api/login',{username:name,password:'existing-password'})).status,200);
  const state=(await request('alice','/api/state')).body;
  assert.deepEqual(store.data,original,'login and read must not migrate/reset old data');
  assert.deepEqual(state.records[0],oldRecord);
  const pdf={name:'월간 계획.pdf',data:'data:application/pdf;base64,'+Buffer.from('%PDF-1.4\n%%EOF').toString('base64')};
  state.records.push({...oldRecord,id:'monthly',kind:'monthly',date:'2026-09-01',minutes:0,image:null,images:[],pdfs:[pdf]});
  assert.equal((await request('alice','/api/state',state,'PUT')).status,200);
  assert.deepEqual(store.data.records[0],oldRecord,'PDF save must preserve pre-update photo records');
  assert.equal((await request('bobby','/api/state')).body.records.length,0);
  assert.equal((await request('teacher','/api/state')).body.records.length,2);
  const path='/api/pdfs/22222222-2222-2222-2222-222222222222';store.data.records[1].pdfs[0].data=path;
  for(const name of ['alice','teacher']){
    const res=await fetch(base+path,{headers:{cookie:client[name]}});assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'application/pdf');assert.match(res.headers.get('content-disposition'),/^inline/);
  }
  const download=await fetch(base+path+'?download=1',{headers:{cookie:client.alice}});assert.match(download.headers.get('content-disposition'),/^attachment/);
  assert.equal((await request('bobby',path)).status,404);
  let s=(await request('bobby','/api/state')).body;s.records.push({...store.data.records[1],id:'stolen',memberId:'bobby'});assert.equal((await request('bobby','/api/state',s,'PUT')).status,403);
  s=(await request('alice','/api/state')).body;s.records[1].memo='수정한 계획';assert.equal((await request('alice','/api/state',s,'PUT')).status,200);
  s=(await request('alice','/api/state')).body;s.records[1].pdfs[0].data='data:application/pdf;base64,aGVsbG8=';assert.equal((await request('alice','/api/state',s,'PUT')).status,400);
  s=(await request('alice','/api/state')).body;s.records[0].pdfs=[pdf];assert.equal((await request('alice','/api/state',s,'PUT')).status,400);
});

test('Supabase uploads PDF separately and preserves existing photo references',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('/storage/')?{}:44));};
  const store=new SupabaseStore('https://example.supabase.co','sb_secret_test');
  const image='/api/photos/11111111-1111-1111-1111-111111111111';
  const d={revision:43,records:[{images:[image],image,pdfs:[{name:'plan.pdf',data:'data:application/pdf;base64,JVBERi0xLjQKJSVFT0Y='}]}]};
  const saved=await store.save(d,43);
  assert.equal(saved.records[0].image,image);assert.match(saved.records[0].pdfs[0].data,/^\/api\/pdfs\//);
  assert.match(calls[0].url,/\/storage\/v1\/object\/study-pdfs\//);assert.equal(calls[0].options.headers['Content-Type'],'application/pdf');
  assert.equal(JSON.parse(calls[1].options.body).expected_revision,43);
});
