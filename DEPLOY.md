# 롬캘린더 Vercel 배포 방법

구성: `index.html`(화면) + API(`api/events.js` 일정, `api/fixed.js` 고정비, `api/expenses.js` 변동 지출) + Upstash Redis(저장소, Vercel에서 무료로 연결).
가족 비밀번호는 서버 환경 변수 `FAMILY_PASSWORD`에만 있어서 화면 코드에는 들어가지 않아요.

PowerShell에서 `npx`가 막히면 `npx.cmd`로 실행하세요.

## 1. 로그인과 첫 배포

```powershell
cd C:\Users\jisu.lee\Documents\project\rom_calendar
npx.cmd vercel login
npx.cmd vercel deploy --prod
```

처음 배포할 때 묻는 질문:
- Set up and deploy? → `Y`
- Which scope? → 내 계정
- Link to existing project? → `N`
- Project name? → `rom-calendar`
- In which directory is your code located? → `./`
- Modify settings? → `N`

## 2. 저장소 연결 (Vercel 웹사이트)

1. vercel.com → `rom-calendar` 프로젝트 → **Storage** 탭
2. **Create Database** → **Upstash for Redis** (무료 플랜) → 만들기
3. 프로젝트에 **Connect** (환경 변수 `KV_REST_API_URL`, `KV_REST_API_TOKEN`이 자동으로 들어가요)

## 3. 가족 비밀번호 정하기

프로젝트 → **Settings → Environment Variables**
- Key: `FAMILY_PASSWORD`
- Value: 가족끼리 쓸 비밀번호 (길고 추측하기 어렵게)
- Environment: Production

## 4. 다시 배포해서 설정 적용

```powershell
npx.cmd vercel deploy --prod
```

나온 주소(예: `https://rom-calendar.vercel.app`)를 가족에게 보내고 비밀번호를 알려 주면 끝.

## 로컬에서 확인하기

```powershell
npm.cmd run dev
```
http://localhost:5178 , 비밀번호 `romi` (메모리에만 저장, 서버를 끄면 사라짐)

## 참고
- 비밀번호를 15분 안에 20번 틀리면 그 IP는 15분 동안 막혀요.
- 비밀번호를 바꾸면 3·4단계를 다시 하면 되고, 가족 기기에서는 새 비밀번호를 다시 넣어야 해요.
- 다른 가족이 바꾼 일정은 30초마다, 그리고 앱으로 돌아올 때 자동으로 새로 불러와요.
