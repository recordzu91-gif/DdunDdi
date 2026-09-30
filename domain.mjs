import {isDeepStrictEqual as equal} from 'node:util';
import {randomBytes, scrypt as scryptCallback, pbkdf2 as pbkdf2Callback, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt = promisify(scryptCallback), pbkdf2 = promisify(pbkdf2Callback);
export const fail = (message, status=400) => { throw Object.assign(new Error(message), {status}); };
export const check = (condition, message='올바르지 않은 요청입니다.', status=400) => {if (!condition) fail(message,status);};
export const safeEqual = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function passwordValid(p) {check(typeof p==='string' && p.length>=8 && p.length<=128,'비밀번호는 8~128자로 입력해주세요.');}
export async function credentials(p) {passwordValid(p); const salt=randomBytes(16).toString('hex'); return {algorithm:'scrypt',salt,hash:(await scrypt(p,salt,64)).toString('hex')};}
export async function verify(m,p) {
  if(typeof p!=='string'||p.length>128) return false;
  const a=m?.auth || {algorithm:'scrypt',salt:'0'.repeat(32),hash:'0'.repeat(128)};
  const bytes=a.algorithm==='scrypt'?await scrypt(p,a.salt,64):await pbkdf2(p,a.salt,210000,32,'sha256');
  return safeEqual(bytes.toString('hex'),a.hash);
}
export const publicMember = m => {const {auth, sessionVersion, ...rest}=m;return rest;};
export const canSee=(m,r)=>m.role==='teacher'||r.memberId===m.id||r.visibility==='group';
export function project(d,m) {
  return {revision:d.revision, members:d.members.map(publicMember), records:d.records.filter(r=>canSee(m,r)), periods:d.periods,
    studyTotals:d.records.filter(r=>r.kind==='study').map(r=>({kind:'study',memberId:r.memberId,date:r.date,minutes:r.minutes})),
    ...(d.schoolYear!==undefined?{schoolYear:d.schoolYear}:{}), ...(d.rankingWeekStart?{rankingWeekStart:d.rankingWeekStart}:{})};
}
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x);
const str=(x,n,min=0)=>typeof x==='string'&&x.length>=min&&x.length<=n;
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
const unique=rows=>Array.isArray(rows)&&rows.every(r=>r&&id(r.id))&&new Set(rows.map(r=>r.id)).size===rows.length;
const keys=(o,allowed)=>Object.keys(o).every(k=>allowed.includes(k));
const kinds=['plan','plan-night','target','study','monthly','monthly-night'];
const reactions=['👏','💪','❤️'];
export function validate(d) {
  check(d && unique(d.members)&&unique(d.records)&&unique(d.periods),'데이터 형식이 올바르지 않습니다.');
  check(d.members.length<=300 && d.records.length<=20000 && d.periods.length<=2000,'학급 보드의 데이터 한도를 초과했습니다.');
  check(keys(d,['members','records','periods','schoolYear','rankingWeekStart','revision','epoch']));
  check(new Set(d.members.map(m=>m.username)).size===d.members.length);
  const ids=new Set(d.members.map(m=>m.id));
  for(const m of d.members) {
    check(keys(m,['id','name','username','className','role','participation','auth','mustReset','sessionVersion']));
    check(str(m.name,20,1)&&str(m.className,30)&&/^[a-z0-9_]{4,24}$/.test(m.username)&&['teacher','student'].includes(m.role)&&['both','planner','time'].includes(m.participation));
    check(m.auth&&/^[a-f0-9]{32}$/.test(m.auth.salt)&& (m.auth.algorithm==='scrypt'?/^[a-f0-9]{128}$/.test(m.auth.hash):m.auth.algorithm===undefined&&/^[a-f0-9]{64}$/.test(m.auth.hash)));
    check(typeof m.mustReset==='boolean');
  }
  check(d.members.filter(m=>m.role==='teacher').length<=1);
  const recordKeys=new Set();
  for(const r of d.records) {
    check(keys(r,['id','memberId','kind','date','minutes','image','images','pdfs','memo','visibility','updatedAt','comments','reactions']));
    check(ids.has(r.memberId)&&d.members.find(m=>m.id===r.memberId).role==='student'&&kinds.includes(r.kind)&&date(r.date)&&['group','private'].includes(r.visibility));
    const key=[r.memberId,r.kind,r.date].join('|');check(!recordKeys.has(key),'같은 날짜와 단계의 기록은 하나만 저장할 수 있습니다.');recordKeys.add(key);
    check(Number.isInteger(r.minutes)&&r.minutes>=0&&r.minutes<=1440&&str(r.memo,200)&&str(r.updatedAt,40)&&Number.isFinite(Date.parse(r.updatedAt)));
    if(r.kind==='target')check(r.minutes>=1);
    if(!['study','target'].includes(r.kind))check(r.minutes===0);
    if(r.kind==='monthly')check(r.date.endsWith('-01'));
    check(Array.isArray(r.images)&&r.images.length<=8,'사진은 기록당 최대 8장입니다.');
    for(const img of r.images)check(str(img,3*1024*1024)&&(/^[\/]api\/photos\/[a-f0-9-]{36}$/.test(img)||/^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(img)),'사진 형식 또는 크기를 확인해주세요. 사진당 저장 크기는 최대 3MB입니다.');
    check(r.image===(r.images[0]||null));
    const pdfs=r.pdfs||[];
    check(Array.isArray(pdfs)&&pdfs.length<=2,'PDF는 기록당 최대 2개입니다.');
    check(r.kind==='monthly'||pdfs.length===0,'PDF는 월간 계획에만 첨부할 수 있습니다.');
    for(const pdf of pdfs) {
      check(pdf&&keys(pdf,['name','data'])&&str(pdf.name,255,1)&&typeof pdf.data==='string','PDF 정보를 확인해주세요.');
      if(!/^\/api\/pdfs\/[a-f0-9-]{36}$/.test(pdf.data)) {
        check(pdf.data.length<=16777260&&/^data:application\/pdf;base64,[A-Za-z0-9+/]+={0,2}$/.test(pdf.data),'PDF 형식을 확인해주세요.');
        const bytes=Buffer.from(pdf.data.split(',')[1],'base64');
        check(bytes.length<=12*1024*1024&&bytes.subarray(0,5).toString()==='%PDF-','PDF는 올바른 형식의 12MB 이하 파일이어야 합니다.');
      }
    }
    check(r.kind==='target'?r.images.length===0:r.images.length>0||(r.kind==='monthly'&&pdfs.length>0),'이 단계는 사진 또는 월간 계획 PDF가 필요합니다.');
    check(unique(r.comments)&&r.comments.length<=2000);
    for(const c of r.comments)check(keys(c,['id','memberId','text','createdAt'])&&ids.has(c.memberId)&&str(c.text,500,1)&&str(c.createdAt,40)&&Number.isFinite(Date.parse(c.createdAt)));
    check(r.reactions&&typeof r.reactions==='object'&&!Array.isArray(r.reactions)&&keys(r.reactions,reactions));
    for(const arr of Object.values(r.reactions))check(Array.isArray(arr)&&new Set(arr).size===arr.length&&arr.every(x=>ids.has(x)));
  }
  for(const p of d.periods)check(keys(p,['id','start','end','auto'])&&date(p.start)&&date(p.end)&&p.start<=p.end&&(p.auto===undefined||typeof p.auto==='boolean'));
  if(d.schoolYear!==undefined)check(Number.isInteger(d.schoolYear)&&d.schoolYear>=1900&&d.schoolYear<=9998);
  if(d.rankingWeekStart!==undefined)check(date(d.rankingWeekStart));
  check(Buffer.byteLength(JSON.stringify(d))<=44*1024*1024,'저장 한도(44MB)에 도달했습니다. 교사에게 백업과 오래된 기록 정리를 요청해주세요.',413);
  return d;
}
function socialAllowed(before,after,m) {
  const old=before.comments||[],next=after.comments||[];
  for(const c of old) {
    const n=next.find(x=>x.id===c.id);
    check(n?equal(c,n):c.memberId===m.id,'다른 사람의 댓글은 변경할 수 없습니다.',403);
  }
  for(const c of next.filter(x=>!old.some(y=>x.id===y.id)))check(c.memberId===m.id,'댓글 작성자가 일치하지 않습니다.',403);
  for(const emoji of new Set([...Object.keys(before.reactions||{}),...Object.keys(after.reactions||{})])) {
    const others=a=>(a||[]).filter(x=>x!==m.id).sort();
    check(equal(others(before.reactions?.[emoji]),others(after.reactions?.[emoji])),'다른 사람의 응원은 변경할 수 없습니다.',403);
  }
}
export function mergeEdit(old,input,m) {
  check(input?.revision===old.revision,'다른 사용자가 먼저 저장했습니다. 입력 내용을 복사한 후 최신 데이터를 불러와 다시 저장해주세요.',409);
  const visible=project(old,m), next=structuredClone(old);
  check(keys(input,['members','records','periods','schoolYear','rankingWeekStart','revision','studyTotals'])&&unique(input.members)&&unique(input.records)&&unique(input.periods));
  check(equal(input.studyTotals,visible.studyTotals),'통계는 서버가 계산합니다. 최신 데이터를 다시 불러와주세요.');
  check(input.members.length===old.members.length,'계정 추가·삭제는 전용 메뉴를 이용해주세요.',403);
  for(const member of next.members) {
    const proposed=input.members.find(x=>x.id===member.id), original=publicMember(member);
    check(proposed,'계정 정보가 일치하지 않습니다.',403);
    const {participation: a,...restA}=original,{participation:b,...restB}=proposed;
    check(equal(restA,restB),'계정 권한은 수정할 수 없습니다.',403);
    if(a!==b)check(m.role==='teacher'||m.id===member.id,'다른 학생의 설정은 바꿀 수 없습니다.',403);
    member.participation=b;
  }
  for(const key of ['schoolYear','rankingWeekStart']) {
    if(!equal(old[key],input[key]))check(m.role==='teacher','교사만 설정을 변경할 수 있습니다.',403);
    if(input[key]!==undefined)next[key]=input[key];else delete next[key];
  }
  if(!equal(old.periods,input.periods)&&m.role!=='teacher') {
    check(old.periods.every(p=>input.periods.some(n=>equal(p,n))),'교사만 기간을 변경할 수 있습니다.',403);
    for(const p of input.periods.filter(p=>!old.periods.some(o=>o.id===p.id)))check(p.auto===true&&p.start===p.end&&input.records.some(r=>r.memberId===m.id&&r.date===p.start),'교사만 기간을 추가할 수 있습니다.',403);
  }
  next.periods=input.periods;
  const ownPhotos=new Set(old.records.filter(r=>r.memberId===m.id).flatMap(r=>r.images));
  const ownPdfs=new Set(old.records.filter(r=>r.memberId===m.id).flatMap(r=>(r.pdfs||[]).map(p=>p.data)));
  for(const r of input.records)if(r.memberId===m.id)for(const pdf of r.pdfs||[]) {
    if(typeof pdf?.data==='string'&&pdf.data.startsWith('/api/pdfs/'))check(ownPdfs.has(pdf.data),'내가 올린 PDF만 재사용할 수 있습니다.',403);
  }
  for(const r of input.records)if(r.memberId===m.id)for(const photo of r.images||[]) {
    if(typeof photo==='string'&&photo.startsWith('/api/photos/'))check(ownPhotos.has(photo),'내가 올린 사진만 재사용할 수 있습니다.',403);
  }
  for(const r of visible.records) {
    const proposed=input.records.find(x=>x.id===r.id);
    if(!proposed) {check(r.memberId===m.id,'내 기록만 삭제할 수 있습니다.',403);next.records=next.records.filter(x=>x.id!==r.id);continue;}
    if(equal(r,proposed))continue;
    if(r.memberId!==m.id) {
      const {comments:c,reactions:a,...rest}=r,{comments:cc,reactions:aa,...restNext}=proposed;
      check(equal(rest,restNext),'다른 학생의 기록은 수정할 수 없습니다.',403);
    } else check(proposed.memberId===m.id&&proposed.kind===r.kind&&proposed.date===r.date,'기록 소유자·종류·날짜는 바꿀 수 없습니다.',403);
    socialAllowed(r,proposed,m);
    next.records[next.records.findIndex(x=>x.id===r.id)]=proposed;
  }
  for(const r of input.records.filter(r=>!visible.records.some(o=>o.id===r.id))) {
    check(!old.records.some(x=>x.id===r.id)&&r.memberId===m.id&&m.role==='student','기록을 추가할 권한이 없습니다.',403);
    const family=['target','study'].includes(r.kind)?'time':'planner';
    check(m.participation==='both'||m.participation===family,'참여 방식 설정을 확인해주세요.');
    check(r.comments.length===0&&Object.values(r.reactions).every(a=>a.length===0));
    next.records.push(r);
  }
  return validate(next);
}
