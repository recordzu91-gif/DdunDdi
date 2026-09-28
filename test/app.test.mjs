import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp,SupabaseStore} from '../server.mjs';
import {credentials,verify,project,mergeEdit,validate} from '../domain.mjs';

class MemoryStore {
  data={members:[],records:[],periods:[],revision:0};
  async ping() {}
  async load(){return structuredClone(this.data);}
  async save(d,rev){if(rev!==this.data.revision)throw Object.assign(Error('conflict'),{status:409});this.data=structuredClone({...d,revision:rev+1});return this.load();}
}
test('server permissions, storage, sessions and recovery',async t=>{
  const store=new MemoryStore(),origin='http://localhost';
  const server=createApp({store,origin,secret:'test-secret-32-characters-or-longer'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const teacher={cookie:''},alice={cookie:''},bob={cookie:''};
  async function call(client,path,payload,method=payload===undefined?'GET':'POST',extra={}) {
    const r=await fetch(base+path,{method,headers:{origin,'Content-Type':'application/json',cookie:client.cookie||'',...extra},body:payload===undefined?undefined:JSON.stringify(payload)});
    const cookie=r.headers.get('set-cookie');if(cookie)client.cookie=cookie.split(';')[0];
    return {status:r.status,body:await r.json(),headers:r.headers};
  }
  const reg=username=>({username,name:username,className:'2-3',password:'my-password-123',participation:'both'});
  let tid,aid,bid;
  await t.test('unconfigured bootstrap, denied anonymous access, CSRF and first teacher signup without a code',async()=>{
    assert.equal((await call({},'/api/bootstrap')).body.setup,true);
    assert.equal((await call({},'/api/state')).status,401);
    assert.equal((await call(teacher,'/api/register',reg('teacher'),'POST',{origin:'https://evil.invalid'})).status,403);
    const r=await call(teacher,'/api/register',reg('teacher'));
    assert.equal(r.status,200);assert.equal(r.body.member.role,'teacher');tid=r.body.member.id;
    assert.equal(JSON.stringify(r.body).includes('"auth"'),false);assert.match(r.headers.get('set-cookie'),/HttpOnly/);
  });
  await t.test('open signup without a code and server-assigned student role',async()=>{
    let r=await call(alice,'/api/register',reg('alice'));assert.equal(r.status,200);aid=r.body.member.id;assert.equal(r.body.member.role,'student');
    r=await call(bob,'/api/register',{...reg('bobby'),role:'teacher'});assert.equal(r.status,200);bid=r.body.member.id;
    assert.equal((await call({},'/api/login',{username:'alice',password:'wrong'})).status,401);
  });
  const record=(id,visibility='private')=>({id,memberId:aid,kind:'target',date:'2026-09-29',minutes:90,image:null,images:[],memo:'private memo',visibility,updatedAt:new Date().toISOString(),comments:[],reactions:{}});
  await t.test('server persistence, private record filtering and no credentials leaked',async()=>{
    const d=(await call(alice,'/api/state')).body;d.records.push(record('private-one'));
    const r=await call(alice,'/api/state',d,'PUT');assert.equal(r.status,200);
    assert.equal((await call(bob,'/api/state')).body.records.length,0);
    assert.equal((await call(teacher,'/api/state')).body.records.length,1);
    assert.equal(store.data.records[0].memo,'private memo');assert.equal(JSON.stringify(r.body).includes('"hash"'),false);
  });
  await t.test('reject role escalation, settings edits, guessed private IDs and stale writes',async()=>{
    let d=(await call(bob,'/api/state')).body;d.members.find(x=>x.id===bid).role='teacher';assert.equal((await call(bob,'/api/state',d,'PUT')).status,403);
    d=(await call(bob,'/api/state')).body;d.schoolYear=2040;assert.equal((await call(bob,'/api/state',d,'PUT')).status,403);
    d=(await call(bob,'/api/state')).body;d.records.push({...record('private-one'),memberId:bid});assert.equal((await call(bob,'/api/state',d,'PUT')).status,403);
    const stale=(await call(alice,'/api/state')).body;
    d=(await call(bob,'/api/state')).body;d.members.find(x=>x.id===bid).participation='planner';assert.equal((await call(bob,'/api/state',d,'PUT')).status,200);
    assert.equal((await call(alice,'/api/state',stale,'PUT')).status,409);
    assert.equal(store.data.records.length,1);
  });
  await t.test('public records, own comments and reaction ownership',async()=>{
    let d=(await call(alice,'/api/state')).body;d.records[0].visibility='group';assert.equal((await call(alice,'/api/state',d,'PUT')).status,200);
    d=(await call(bob,'/api/state')).body;d.records[0].minutes=999;assert.equal((await call(bob,'/api/state',d,'PUT')).status,403);
    d=(await call(bob,'/api/state')).body;d.records[0].comments.push({id:'comment-one',memberId:bid,text:'응원합니다',createdAt:new Date().toISOString()});d.records[0].reactions['👏']=[bid];assert.equal((await call(bob,'/api/state',d,'PUT')).status,200);
    d=(await call(alice,'/api/state')).body;d.records[0].comments=[];assert.equal((await call(alice,'/api/state',d,'PUT')).status,403);
    d=(await call(alice,'/api/state')).body;d.records[0].reactions['👏']=[];assert.equal((await call(alice,'/api/state',d,'PUT')).status,403);
  });
  await t.test('concurrent compare-and-swap admits exactly one write',async()=>{
    const d=(await call(teacher,'/api/state')).body;
    const results=await Promise.all([call(teacher,'/api/state',{...d,schoolYear:2026},'PUT'),call(teacher,'/api/state',{...d,schoolYear:2027},'PUT')]);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  });
  await t.test('photo upload persists and invalid image schemes are rejected',async()=>{
    let d=(await call(alice,'/api/state')).body;
    const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    d.records.push({...record('photo-one'),kind:'study',minutes:60,images:[photo],image:photo});
    assert.equal((await call(alice,'/api/state',d,'PUT')).status,200);
    assert.equal((await call(teacher,'/api/state')).body.records.find(r=>r.id==='photo-one').image,photo);
    d=(await call(alice,'/api/state')).body;d.records.find(r=>r.id==='photo-one').image='javascript:alert(1)';assert.equal((await call(alice,'/api/state',d,'PUT')).status,400);
  });
  await t.test('private Storage proxy blocks other students and stolen photo references',async()=>{
    const photoPath='/api/photos/12345678-1234-1234-1234-123456789abc';
    const record=store.data.records.find(r=>r.id==='photo-one');record.images=[photoPath];record.image=photoPath;
    store.readPhoto=async()=>({type:'image/png',bytes:Buffer.from('fake-image')});
    const r=await fetch(base+photoPath,{headers:{cookie:alice.cookie}});assert.equal(r.status,200);
    assert.equal((await call(bob,photoPath)).status,404);
    let d=(await call(bob,'/api/state')).body;d.records.push({...record,id:'stolen-photo',memberId:bid});assert.equal((await call(bob,'/api/state',d,'PUT')).status,403);
    d=(await call(alice,'/api/state')).body;d.records.find(r=>r.id==='photo-one').memo='updated';assert.equal((await call(alice,'/api/state',d,'PUT')).status,200);
    assert.equal((await call(bob,'/api/state')).body.studyTotals[0].minutes,60);
  });
  await t.test('teacher reset invalidates student sessions and forces password change',async()=>{
    assert.equal((await call(bob,'/api/reset-student',{id:aid,password:'my-password-123'})).status,403);
    assert.equal((await call(teacher,'/api/reset-student',{id:aid,password:'wrong'})).status,403);
    const r=await call(teacher,'/api/reset-student',{id:aid,password:'my-password-123'});assert.equal(r.status,200);
    assert.equal((await call(alice,'/api/state')).status,401);
    const login=await call(alice,'/api/login',{username:'alice',password:r.body.temp});assert.equal(login.body.member.mustReset,true);assert.equal(login.body.data,null);
    assert.equal((await call(alice,'/api/state')).status,403);
    assert.equal((await call(alice,'/api/password',{password:'brand-new-password'})).status,200);
    assert.equal((await call(alice,'/api/state')).status,200);
  });
  let backup;
  await t.test('teacher-only full backup; delete cleans comments and reactions',async()=>{
    assert.equal((await call(bob,'/api/backup')).status,403);
    backup=(await call(teacher,'/api/backup')).body;assert.ok(backup.data.members.find(m=>m.id===tid).auth.hash);
    const r=await call(teacher,'/api/delete-student',{id:bid,password:'my-password-123'});assert.equal(r.status,200);assert.equal(r.body.data.records[0].comments.length,0);assert.deepEqual(r.body.data.records[0].reactions['👏'],[]);
    assert.equal((await call(bob,'/api/state')).status,401);
  });
  await t.test('backup restore revokes every session and restores data',async()=>{
    assert.equal((await call(teacher,'/api/restore',{backup,password:'wrong'})).status,403);
    assert.equal((await call(teacher,'/api/restore',{backup,password:'my-password-123'})).status,200);
    assert.equal((await call(alice,'/api/state')).status,401);
    assert.equal((await call(teacher,'/api/login',{username:'teacher',password:'my-password-123'})).status,200);
    assert.equal((await call(teacher,'/api/state')).body.members.length,3);
    assert.equal((await call(teacher,'/api/state')).body.records[0].comments.length,1);
  });
  await t.test('logout invalidates copied cookies, health and static routes',async()=>{
    const copied={cookie:teacher.cookie};assert.equal((await call(teacher,'/api/logout',{})).status,200);assert.equal((await call(copied,'/api/state')).status,401);
    assert.equal((await call({},'/health')).status,200);
    const html=await fetch(base+'/');assert.equal(html.status,200);assert.match(await html.text(),/\/app.js/);
    assert.equal((await fetch(base+'/.env')).status,404);
  });
});

test('password hashing and legacy browser PBKDF2 compatibility',async()=>{
  const auth=await credentials('password-123');assert.equal(await verify({auth},'password-123'),true);assert.equal(await verify({auth},'wrong'),false);
  const {pbkdf2Sync}=await import('node:crypto'),salt='0123456789abcdef0123456789abcdef';
  const legacy={salt,hash:pbkdf2Sync('old-password',salt,210000,32,'sha256').toString('hex')};
  assert.equal(await verify({auth:legacy},'old-password'),true);
});
test('Supabase REST adapter reads revision and performs RPC compare-and-swap',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let seen;
  globalThis.fetch=async(url,opts)=>{seen={url,opts};return new Response(JSON.stringify(url.includes('/rpc/')?8:[{revision:7,payload:{members:[],records:[],periods:[]}}]),{status:200});};
  const store=new SupabaseStore('https://example.supabase.co','sb_secret_test');
  const d=await store.load();assert.equal(d.revision,7);
  assert.equal((await store.save(d,7)).revision,8);assert.equal(JSON.parse(seen.opts.body).expected_revision,7);assert.equal(seen.opts.headers.apikey,'sb_secret_test');assert.equal(seen.opts.headers.Authorization,undefined);
  globalThis.fetch=async()=>new Response('REVISION_CONFLICT',{status:400});await assert.rejects(store.save(d,7),{status:409});
});
test('Supabase adapter uploads photos to private Storage before saving references',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=[];
  globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify(url.includes('/storage/')?{Key:'photo'}:3),{status:200});};
  const img='data:image/png;base64,aGVsbG8=';
  const store=new SupabaseStore('https://example.supabase.co','sb_secret_test');
  const result=await store.save({revision:2,members:[],periods:[],records:[{images:[img],image:img}]},2);
  assert.equal(calls.length,2);assert.match(calls[0].url,/\/storage\/v1\/object\/study-photos\//);assert.equal(calls[0].opts.headers['Content-Type'],'image/png');
  assert.match(result.records[0].image,/^\/api\/photos\//);assert.equal(JSON.stringify(JSON.parse(calls[1].opts.body).next_payload).includes('base64'),false);
});
