import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHmac, randomUUID, randomBytes} from 'node:crypto';
import {check, fail, safeEqual, credentials, verify, passwordValid, publicMember, project, validate, mergeEdit, canSee} from './domain.mjs';

export class SupabaseStore {
  constructor(url,key) {this.url=url.replace(/\/$/,'');this.key=key;}
  async request(path,options={}) {
    const headers={apikey:this.key,'Content-Type':'application/json'};
    // Legacy JWT service_role keys need Authorization; sb_secret keys use apikey.
    if(!this.key.startsWith('sb_secret_'))headers.Authorization='Bearer '+this.key;
    const response=await fetch(this.url+'/rest/v1/'+path,{...options,headers,signal:AbortSignal.timeout(25000)});
    if(!response.ok) {
      const body=await response.text();
      if(body.includes('REVISION_CONFLICT'))fail('다른 사용자가 먼저 저장했습니다. 입력 내용을 복사하고 최신 데이터를 다시 불러와주세요.',409);
      if(body.includes('BOARD_TOO_LARGE'))fail('데이터 저장 한도를 초과했습니다.',413);
      console.error('Supabase request failed',response.status); // Never log keys, photos, passwords or SQL response bodies.
      fail('서버 저장소 연결에 실패했습니다. Supabase 설정과 SQL 실행 여부를 확인해주세요.',503);
    }
    return response.json();
  }
  async ping() {const rows=await this.request('study_board?id=eq.1&select=revision');check(rows.length===1,'저장소 초기 설정이 필요합니다.',503);}
  async load() {const rows=await this.request('study_board?id=eq.1&select=payload,revision');check(rows.length===1,'저장소 초기 설정이 필요합니다.',503);return {...rows[0].payload,revision:Number(rows[0].revision)};}
  async storage(path,options={}) {
    const headers={apikey:this.key,...options.headers};
    if(!this.key.startsWith('sb_secret_'))headers.Authorization='Bearer '+this.key;
    const res=await fetch(this.url+'/storage/v1/'+path,{...options,headers,signal:AbortSignal.timeout(25000)});
    check(res.ok,'사진 저장소에 연결하지 못했습니다. Storage 설정을 확인해주세요.',503);return res;
  }
  async readPhoto(id) {
    check(/^[a-f0-9-]{36}$/.test(id));
    const res=await this.storage('object/study-photos/'+id);
    const type=(res.headers.get('content-type')||'').split(';')[0];
    check(['image/jpeg','image/png','image/webp'].includes(type),'지원하지 않는 사진입니다.');
    return {type,bytes:Buffer.from(await res.arrayBuffer())};
  }
  async save(d,expected) {
    const {revision,...payload}=structuredClone(d), uploaded=new Map();
    // Objects are uploaded before the atomic metadata commit. A conflict leaves
    // an unreferenced object, never a record referring to a missing upload.
    for(const record of payload.records) {
      const photos=[];
      for(const image of record.images) {
        if(!image.startsWith('data:')){photos.push(image);continue;}
        if(!uploaded.has(image)) {
          const match=image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
          check(match,'지원하지 않는 사진입니다.');
          const id=randomUUID();await this.storage('object/study-photos/'+id,{method:'POST',headers:{'Content-Type':match[1],'x-upsert':'false'},body:Buffer.from(match[2],'base64')});
          uploaded.set(image,'/api/photos/'+id);
        }
        photos.push(uploaded.get(image));
      }
      record.images=photos;record.image=photos[0]||null;
    }
    const rev=await this.request('rpc/save_study_board',{method:'POST',body:JSON.stringify({expected_revision:expected,next_payload:payload})});return {...payload,revision:Number(rev)};
  }
}
const cookieName='study_session';
const sign=(value,secret)=>createHmac('sha256',secret).update(value).digest('base64url');
function issue(m,d,secret) {const value=Buffer.from(JSON.stringify({id:m.id,v:m.sessionVersion||0,e:d.epoch||'',exp:Date.now()+12*3600000})).toString('base64url');return value+'.'+sign(value,secret);}
function memberFrom(req,d,secret) {
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(!cookie||cookie.length>2048)return null;
  const [value,mac,...extra]=cookie.split('.');
  if(extra.length||!safeEqual(mac,sign(value,secret)))return null;
  try {const s=JSON.parse(Buffer.from(value,'base64url').toString());return s.exp>Date.now()&&s.e===(d.epoch||'')?d.members.find(m=>m.id===s.id&&(m.sessionVersion||0)===s.v):null;}catch{return null;}
}
async function body(req) {
  check((req.headers['content-type']||'').split(';')[0]==='application/json','JSON 요청이 필요합니다.',415);
  const chunks=[];let length=0;
  for await(const chunk of req) {length+=chunk.length;check(length<=46*1024*1024,'요청 데이터가 너무 큽니다.',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('JSON 형식을 확인해주세요.');}
}
export function createApp({store,secret,setupKey,joinCode,origin,production=false}) {
  const rate=new Map();
  function throttle(key,max) {
    const now=Date.now();for(const [k,v] of rate)if(v.until<now)rate.delete(k);
    const item=rate.get(key)||{count:0,until:now+15*60000};item.count++;rate.set(key,item);
    check(item.count<=max,'요청이 너무 많습니다. 15분 뒤 다시 시도해주세요.',429);
  }
  const setCookie=(res,value,clear=false)=>res.setHeader('Set-Cookie',`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:43200}${production?'; Secure':''}`);
  const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&['/','/index.html','/app.js','/style.css'].includes(path)) {
        const file=path==='/'?'index.html':path.slice(1), content=await readFile(new URL('./public/'+file,import.meta.url));
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(content);return;
      }
      if(req.method==='GET'&&path==='/health'){await store.ping();return json(res,{ok:true});}
      check(path.startsWith('/api/'),'찾을 수 없는 페이지입니다.',404);
      check(['GET','POST','PUT'].includes(req.method),'허용되지 않는 요청입니다.',405);
      if(req.method!=='GET')check(req.headers.origin===origin,'요청 출처를 확인할 수 없습니다.',403);
      const d=await store.load(), m=memberFrom(req,d,secret);
      if(req.method==='GET'&&path==='/api/bootstrap')return json(res,{setup:!d.members.some(x=>x.role==='teacher'),member:m?publicMember(m):null,data:m&&!m.mustReset?project(d,m):null});
      if(req.method==='POST'&&['/api/login','/api/register'].includes(path)) {
        throttle('auth-total',600);
        const b=await body(req),username=String(b.username||'').trim().toLowerCase();
        check(/^[a-z0-9_]{4,24}$/.test(username),'아이디는 영문·숫자·밑줄 4~24자입니다.');
        throttle('auth:'+username,20);
        if(path==='/api/login') {
          const member=d.members.find(x=>x.username===username);
          check(await verify(member,b.password),'아이디 또는 비밀번호를 확인해주세요.',401);
          setCookie(res,issue(member,d,secret));return json(res,{member:publicMember(member),data:member.mustReset?null:project(d,member)});
        }
        const setup=!d.members.some(x=>x.role==='teacher');
        check(setup?safeEqual(b.code,setupKey):(m?.role==='teacher'&&!m.mustReset)||safeEqual(b.code,joinCode),setup?'교사 초기 설정 코드를 확인해주세요.':'학생 초대 코드를 확인해주세요.',403);
        check(!d.members.some(x=>x.username===username),'이미 사용 중인 아이디입니다.');
        passwordValid(b.password);
        const member={id:randomUUID(),username,name:b.name,className:b.className||'',participation:b.participation||'both',role:setup?'teacher':'student',mustReset:false,sessionVersion:0,auth:await credentials(b.password)};
        d.members.push(member);validate(d);const saved=await store.save(d,d.revision);
        const current=m&&!m.mustReset?m:member;
        setCookie(res,issue(current,saved,secret));return json(res,{member:publicMember(current),data:project(saved,current)});
      }
      check(m,'로그인이 필요합니다.',401);
      if(req.method==='POST'&&path==='/api/logout') {
        m.sessionVersion=(m.sessionVersion||0)+1;await store.save(d,d.revision);setCookie(res,'',true);return json(res,{ok:true});
      }
      if(req.method==='POST'&&path==='/api/password') {
        throttle('password:'+m.id,20);const b=await body(req);passwordValid(b.password);
        check(m.mustReset,'임시 비밀번호 로그인 후 이용해주세요.',403);
        check(!await verify(m,b.password),'임시 비밀번호와 다른 비밀번호를 설정해주세요.');
        m.auth=await credentials(b.password);m.mustReset=false;m.sessionVersion=(m.sessionVersion||0)+1;
        const saved=await store.save(d,d.revision);setCookie(res,issue(m,saved,secret));return json(res,{member:publicMember(m),data:project(saved,m)});
      }
      check(!m.mustReset,'새 비밀번호를 먼저 설정해주세요.',403);
      if(req.method==='GET'&&/^\/api\/photos\/[a-f0-9-]{36}$/.test(path)) {
        check(d.records.some(r=>canSee(m,r)&&r.images.includes(path)),'이 사진에 접근할 수 없습니다.',404);
        const photo=await store.readPhoto(path.split('/').pop());
        res.writeHead(200,{'Content-Type':photo.type,'Content-Length':photo.bytes.length});res.end(photo.bytes);return;
      }
      if(req.method==='GET'&&path==='/api/state')return json(res,project(d,m));
      if(req.method==='GET'&&path==='/api/version')return json(res,{revision:d.revision});
      if(req.method==='PUT'&&path==='/api/state') {
        const edited=mergeEdit(d,await body(req),m);const saved=await store.save(edited,d.revision);return json(res,project(saved,m));
      }
      check(m.role==='teacher','교사만 이용할 수 있습니다.',403);
      if(req.method==='GET'&&path==='/api/backup')return json(res,{format:'study-board-server-backup',version:1,exportedAt:new Date().toISOString(),data:d});
      if(req.method==='POST'&&['/api/reset-student','/api/delete-student','/api/restore'].includes(path)) {
        throttle('teacher:'+m.id,20);const b=await body(req);
        check(await verify(m,b.password),'교사 비밀번호가 일치하지 않습니다.',403);
        if(path==='/api/restore') {
          check(['study-board-server-backup','study-board-backup'].includes(b.backup?.format)&&b.backup.version===1,'지원하지 않는 백업입니다.');
          const next=b.backup.data;validate(next);check(next.members.some(x=>x.role==='teacher'),'교사 계정이 없는 백업입니다.');
          next.epoch=randomUUID();await store.save(next,d.revision);setCookie(res,'',true);return json(res,{ok:true});
        }
        const target=d.members.find(x=>x.id===b.id&&x.role==='student');check(target,'학생을 찾을 수 없습니다.',404);
        if(path==='/api/reset-student') {
          const temp='ST-'+randomBytes(9).toString('base64url');target.auth=await credentials(temp);target.mustReset=true;target.sessionVersion=(target.sessionVersion||0)+1;
          const saved=await store.save(d,d.revision);return json(res,{temp,member:publicMember(target),data:project(saved,m)});
        }
        d.members=d.members.filter(x=>x.id!==target.id);d.records=d.records.filter(r=>r.memberId!==target.id);
        for(const r of d.records){r.comments=r.comments.filter(c=>c.memberId!==target.id);for(const k of Object.keys(r.reactions))r.reactions[k]=r.reactions[k].filter(x=>x!==target.id);}
        const saved=await store.save(d,d.revision);return json(res,{name:target.name,data:project(saved,m)});
      }
      fail('찾을 수 없는 API입니다.',404);
    } catch(error) {
      const status=error.status||500;
      if(!error.status)console.error('Request failed:',error.name);
      if(!res.headersSent)json(res,{error:status===500?'서버 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.':error.message},status);else res.end();
    }
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const env=process.env;
  for(const key of ['SUPABASE_URL','SUPABASE_SECRET_KEY','SESSION_SECRET','SETUP_KEY','JOIN_CODE'])if(!env[key])throw Error('Missing environment variable: '+key);
  check(env.SESSION_SECRET.length>=32,'SESSION_SECRET must be at least 32 characters');
  check(env.SETUP_KEY.length>=12&&env.JOIN_CODE.length>=8,'SETUP_KEY needs 12+ characters; JOIN_CODE needs 8+');
  check(new URL(env.SUPABASE_URL).protocol==='https:','SUPABASE_URL must use HTTPS');
  const origin=env.APP_ORIGIN||env.RENDER_EXTERNAL_URL;
  check(origin&&new URL(origin).origin===origin,'APP_ORIGIN must be an exact origin, without trailing slash');
  const app=createApp({store:new SupabaseStore(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY),secret:env.SESSION_SECRET,setupKey:env.SETUP_KEY,joinCode:env.JOIN_CODE,origin,production:env.NODE_ENV==='production'});
  app.requestTimeout=60000;
  app.listen(Number(env.PORT)||3000,'0.0.0.0',()=>console.log('Study Together server ready'));
}
