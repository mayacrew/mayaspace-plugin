# MayaSpace for Obsidian

MayaSpace 백엔드(NestJS + Hocuspocus)에 연결해 **실시간 협업 편집**을 제공하는 옵시디언 플러그인입니다.
yjs / y-codemirror.next 기반 CRDT 동기화, IndexedDB 오프라인 캐시, 조직(org) 단위 폴더/파일 트리 동기화를 지원합니다.

> 백엔드·전체 제품 개요는 별도 레포 `mayaspace`(루트 `README.md`, `docs/ROADMAP.md`) 참고.
> 연결/동기화 내부 흐름은 [`docs/connection-and-sync-flows.md`](docs/connection-and-sync-flows.md).

## 주요 기능

- **실시간 공동편집** — 같은 파일을 여러 사용자·디바이스가 동시에 편집(CRDT, Hocuspocus WS), 원격 커서.
- **오프라인 우선** — IndexedDB 캐시로 오프라인 편집 후 재연결 시 머지.
- **조직 = 폴더 트리** — 서버 org 폴더를 vault의 루트 폴더(`MayaSpace`) 아래로 미러링, tree 동기화(폴링).
- **권한 인식 동기화** — 폴더별 ACL(READ/UPDATE/CREATE/DELETE) 반영. 읽기 권한 회수 시 로컬 `.md` 정리.
- **버전 히스토리** — 타임라인·미리보기·GitHub식 diff·복원 UI.
- **이미지 첨부** — 에디터 드롭/붙여넣기를 노트 옆 `attachments/`로 업로드·동기화(이미지·20MiB).
- **동기화 상태 표시** — explorer의 파일·폴더 배지(연결/동기화중/오프라인/충돌, 폴더는 하위 집계).

## 요구 사항

- Obsidian `1.4.0` 이상 (데스크톱·모바일)
- 도달 가능한 MayaSpace 서버 (REST + WebSocket)

## 설치

### BRAT (베타 배포)

1. 커뮤니티 플러그인에서 **BRAT**(Obsidian42 - BRAT)를 설치·활성화합니다.
2. BRAT → **Add beta plugin** → `mayacrew/mayaspace-plugin` 입력.
3. 설치 후 **설정 → 커뮤니티 플러그인**에서 "MayaSpace"를 활성화합니다.

> BRAT는 이 레포의 **published GitHub Release** 자산(`main.js`, `manifest.json`, `styles.css`)을 받아 설치합니다.
> 레포는 **public** 이어야 하며, 릴리스는 draft가 아닌 **publish 상태**여야 합니다.

### 수동 설치

릴리스에서 `main.js`, `manifest.json`, `styles.css`를 받아
`<vault>/.obsidian/plugins/mayaspace-plugin/`에 넣고 옵시디언을 새로고침합니다.

## 설정

설정 탭에서 지정합니다. 서버 주소 기본값은 **호스팅된 MayaSpace 인스턴스**를 가리키며, 자체 호스팅 시 본인 서버 주소로 바꿉니다(로컬 개발은 `http://localhost:3000` / `ws://localhost:3001`).

| 항목 | 설명 |
|---|---|
| **REST URL** | MayaSpace REST API 주소 (예: `https://mayaspace.<도메인>`) |
| **Web app URL** | 가입·대시보드를 여는 고객 웹앱(apps/web) 주소 — REST/WS와 별개 |
| **WebSocket URL** | Hocuspocus 협업 엔드포인트 (예: `wss://mayaspace.<도메인>/ws`) |
| **로그인 / 회원가입** | 로그인은 Device Flow(아래), 회원가입은 웹앱을 브라우저로 엽니다 |
| **Display name** | 동시편집 시 커서 옆에 표시될 이름 (기본: 이메일 username) |
| **MayaSpace root folder** | 서버 org 폴더가 미러링되는 vault 내 루트 폴더 (기본 `MayaSpace`) |
| **Tree poll interval** | 서버 tree 변경 폴링 주기(초). `0`이면 폴링 끔 (기본 30) |
| **Prefetch all files** | 모든 파일에 백그라운드 실시간 세션을 엽니다. 대용량 vault는 메모리·IO 폭주를 막기 위해 꺼둠(기본). 끄면 열린/최근 파일만 실시간 |

## 인증 (Device Flow)

- **로그인**: "로그인"을 누르면 Device Flow 모달이 `user_code`를 보여주고 승인 페이지(웹앱)를 엽니다. 브라우저에서 승인하면 플러그인이 폴링으로 토큰을 발급받습니다. **비밀번호를 플러그인에 입력하지 않습니다.**
- **회원가입**: 고객 웹앱(apps/web)을 브라우저로 엽니다(초대 토큰 / 새 조직).
- **보안**: 발급된 토큰만 vault 로컬(`data.json`)에 저장되고, **refresh 토큰은 암호화 저장**됩니다. 운영 환경에서는 반드시 **HTTPS/WSS** 엔드포인트를 사용하세요.

## 개발

```bash
npm install
npm run dev      # esbuild watch
npm run build    # 타입체크 + 프로덕션 번들 (main.js 생성)
npm test         # jest
npm run deploy   # build 후 로컬 vault에 설치 (scripts/install.sh)
```

릴리스는 `manifest.json`의 `version`과 동일한 태그(앞에 `v` 없이)를 push하면
GitHub Action(`.github/workflows/release.yml`)이 빌드·태그 검증 후 자산을 단 **draft 릴리스**를 만듭니다. 내용 확인 후 GitHub에서 publish하면 BRAT가 그 릴리스를 받습니다.

```bash
git tag 0.4.0 && git push origin 0.4.0   # manifest version과 동일하게
```

## 라이선스

[MIT](./LICENSE)
