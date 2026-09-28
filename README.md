# Study Together — 서버 저장형 스터디 보드

기존 `study-board.html`의 화면과 학습 기능을 유지한 **GitHub → Render → Supabase 배포용 앱**입니다.

**먼저 `시작하기.md`를 읽으세요.** 소스만 GitHub에 올려서는 실행되지 않습니다. Supabase SQL 실행과 Render 환경변수 입력이 필요합니다.

## 구성

| 역할 | 서비스 |
| --- | --- |
| 소스 코드 보관·업데이트 | GitHub |
| 웹 화면과 인증 API 실행 | Render의 Node.js Web Service |
| 계정·설정·기록·댓글·응원 | Supabase PostgreSQL |
| 사진 원본 | Supabase의 비공개 `study-photos` Storage 버킷 |

인증은 기존의 **아이디 + 비밀번호** 방식을 유지한 Node.js 서버 인증입니다. 이메일 가입을 요구하는 Supabase Auth는 사용하지 않습니다. 비밀번호는 서버에서 scrypt로 해시 처리하며, 브라우저에는 비밀번호 해시나 Supabase 비밀 키를 보내지 않습니다. 로그인은 HttpOnly 쿠키로 12시간 유지됩니다.

## 유지한 기능

- 학생 가입·로그인, 교사 1명 초기 설정, 참여 방식 선택
- 아침 목표 시간·밤 실제 공부시간, 일일/월간 플래너와 달성 사진
- 여러 장 사진 등록, 수정·삭제, 날짜별 조회
- 주간·학년도 공부시간 순위, 기간 통계, 학년도 설정
- 댓글·응원·교사 피드백, 학생 비밀번호 초기화·강제 변경·삭제
- 교사 백업·복원, 기존 HTML에서 내보낸 JSON 백업 가져오기
- 반응형 화면, 다른 기기에서 로그인해 계속 사용

## 데이터와 권한

기록은 서버 저장이 끝난 뒤 저장 완료로 표시됩니다. 사진은 원본 대신 앱의 `/api/photos/...` 경로로 제공되며, 사진을 요청할 때마다 서버가 로그인과 해당 기록의 공개 범위를 검사합니다. 비공개 기록의 사진·메모·댓글·응원은 작성자와 교사만 받습니다. **이름·반 정보와 날짜별 실제 공부시간은 스터디 통계·순위에 공유됩니다.**

다른 사람이 먼저 저장했으면 버전 충돌로 저장을 중단합니다. 입력 내용을 복사한 후 ‘최신 데이터 다시 불러오기’를 눌러 다시 저장하세요. 새로고침은 열린 입력 내용을 지웁니다. 입력창·대화상자가 닫힌 상태에서는 약 20초마다 다른 사람의 변경을 확인합니다. 실시간 WebSocket은 사용하지 않습니다.

Supabase의 일반 클라이언트 역할(`anon`, `authenticated`)에는 데이터 테이블과 저장 함수 접근 권한을 주지 않습니다. 비공개 Storage도 공개 읽기 정책을 만들지 않습니다. 서비스 비밀 키를 가진 Render 서버가 요청마다 권한을 검사합니다. 전용 Supabase 프로젝트 사용을 권장합니다.

## 배포

1. Supabase 새 프로젝트에서 `supabase/schema.sql` 실행.
2. 이 폴더의 내용을 GitHub 저장소 루트에 업로드.
3. Render에서 해당 저장소를 Blueprint로 연결.
4. `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SETUP_KEY`, `JOIN_CODE` 입력.
5. Render 주소에서 교사 계정을 생성하고 학생에게 주소와 초대 코드 공유.

`render.yaml`은 **Render Free (`plan: free`)**로 설정되어 있습니다. Supabase도 **Free 조직/프로젝트**, GitHub도 무료 계정을 사용하세요. 유료 서비스나 디스크를 추가하지 않습니다. 무료 한도 내에서 운영하는 구성이며 무제한 사용을 보장하지 않습니다. 실제 클라우드 배포는 아직 수행하지 않았습니다. 자세한 무료 한도는 `무료운영.md`를 참고하세요.

## 로컬 실행

Node.js 22.9 이상과 npm이 필요합니다. 테스트에는 외부 npm 라이브러리가 필요하지 않습니다.

```powershell
Copy-Item .env.example .env
# .env를 열어 Supabase URL/Secret key와 코드를 채운 뒤 실행
npm ci
npm start
```

브라우저에서 `http://localhost:3000`으로 접속하세요. 로컬 실행도 `.env`가 가리키는 Supabase 서버에 저장합니다. 개발용 프로젝트를 따로 사용하세요. HTML 파일을 더블클릭해 여는 방식으로는 작동하지 않습니다.

## 환경변수

| 이름 | 값 |
| --- | --- |
| `SUPABASE_URL` | `https://프로젝트ID.supabase.co` |
| `SUPABASE_SECRET_KEY` | 서버용 `sb_secret_...` 키. `sb_publishable_...`를 넣지 마세요. 기존 service_role JWT도 지원합니다. |
| `SESSION_SECRET` | 무작위 32자 이상. Render Blueprint에서 자동 생성합니다. 변경하면 기존 쿠키가 무효화됩니다. |
| `SETUP_KEY` | 교사 최초 계정 생성 코드, 12자 이상. 교사에게만 전달하세요. |
| `JOIN_CODE` | 학생 가입 초대 코드, 8자 이상. 변경해도 기존 학생 계정에는 영향이 없습니다. |
| `APP_ORIGIN` | 로컬은 `http://localhost:3000`. Render 기본 주소에서는 생략하면 `RENDER_EXTERNAL_URL` 사용. 사용자 지정 도메인은 `https://study.example.com`처럼 입력. 끝에 `/` 금지. |
| `NODE_ENV` | Render에서는 `production`. HTTPS 전용 쿠키를 사용합니다. |
| `PORT` | 로컬 기본 3000. Render에서는 Render가 지정한 값 사용. |

비밀값을 `.env.example`, `render.yaml`, 프런트엔드, GitHub 저장소에 적지 마세요. `.env`는 Git에서 제외되며 ZIP에도 실제 비밀값을 넣지 않았습니다.

## 백업·이전·삭제

교사 메뉴의 **서버 백업**은 계정·기록·설정·사진 경로를 JSON으로 내려받습니다. 계정의 비밀번호 해시와 비공개 내용이 들어 있으므로 교사만 안전하게 보관하세요.

**서버 JSON은 사진 원본을 포함하지 않습니다.** 같은 Supabase 프로젝트의 Storage가 남아 있을 때 복원할 수 있습니다. 다른 프로젝트로 이전하거나 재해 복구용 백업을 만들 때에는 `study-photos` 버킷의 모든 객체도 별도로 보관·복사해야 합니다. Storage 파일명은 그대로 유지해야 합니다. 데이터베이스 백업만으로 사진 원본이 복원되지 않습니다.

기존 HTML에서 내보낸 `study-board-backup` JSON도 교사 메뉴에서 불러올 수 있습니다. 기존 계정과 사진이 실제로 들어 있는 JSON 파일이 필요합니다. HTML 파일 자체에는 사용자가 브라우저에 저장한 데이터가 들어 있지 않습니다. 기존 PBKDF2 비밀번호 해시는 로그인 호환을 지원합니다. 복원하면 **백업 속 교사 계정으로 로그인**해야 하며 현재 서버 데이터는 전체 교체됩니다.

기록·학생 삭제 시 서버에서 사진 접근 권한도 사라집니다. 사진 객체는 기존 백업 복원을 위해 비공개 Storage에 남습니다. 영구 삭제가 필요하면 사용 중인 기록과 보관할 백업이 해당 사진을 참조하지 않는지 확인하고 Supabase Storage에서 삭제하세요. 충돌·실패한 업로드도 미참조 객체로 남을 수 있습니다. 객체를 삭제하면 그 사진을 가리키는 과거 백업으로도 복구할 수 없습니다.

## 운영 범위

이 버전은 **교사 1명·단일 스터디/학급**용입니다. 서로 다른 학급의 독립 운영은 별도 Render 서비스와 Supabase 프로젝트를 만드세요.

- 계정 최대 300명, 기록 최대 20,000개, 기간 최대 2,000개.
- 기록당 사진 8장. 원본 선택 파일 12MB 이하, 브라우저에서 최대 1600px JPEG로 압축합니다. 전송용 사진 문자열은 장당 3MB 이하로 제한합니다.
- 사진을 제외한 보드 데이터는 최대 44MB. 기존 사진 내장형 HTML 백업의 일회성 가져오기도 44MB 이하입니다.
- 사진 총용량은 Supabase Storage 요금제에 따릅니다. Render 디스크에는 데이터를 영구 보관하지 않습니다.
- 보드 메타데이터는 하나의 JSONB 문서와 버전 번호로 저장합니다. 많은 동시 편집이나 여러 학급을 위한 대규모 서비스에는 테이블 분리·페이지 조회·분산 요청 제한이 추가로 필요합니다.
- 인증 시도 제한은 Render 프로세스 메모리 기준입니다. 재시작 시 초기화됩니다. 단일 인스턴스 운영을 전제로 합니다.
- 교사 계정의 이메일 자동 복구는 없습니다. 교사 계정 정보와 백업을 별도로 보관하세요.

## 검증

```sh
npm run check
npm test
```

API·권한·세션·충돌·복원·Storage 연동 어댑터 자동 테스트가 포함되어 있습니다. 검증 범위와 실제 클라우드 미검증 항목은 `TEST_REPORT.md`를 참고하세요.

## 파일

```text
public/            기존 화면을 분리한 HTML, CSS, JavaScript
server.mjs         HTTP API, 세션, Supabase DB/Storage 어댑터
domain.mjs         서버 데이터 검증과 기록별 권한
supabase/schema.sql  DB·함수·비공개 사진 버킷 생성
test/app.test.mjs   자동 테스트
render.yaml        Render Blueprint
.env.example       설정 양식
```

## 참고한 공식 문서

- [Render Node.js 웹 서비스](https://render.com/docs/deploy-node-express-app)
- [Render Blueprint 설정](https://render.com/docs/blueprint-spec)
- [Supabase API 키](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase 데이터베이스 함수](https://supabase.com/docs/guides/database/functions)
- [Supabase Storage 접근 제어](https://supabase.com/docs/guides/storage/security/access-control)

