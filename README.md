# MayaSpace for Obsidian

MayaSpace 백엔드(NestJS + Hocuspocus)에 연결해 **실시간 협업 편집**을 제공하는 옵시디언 플러그인입니다.
yjs / y-codemirror.next 기반 CRDT 동기화, IndexedDB 오프라인 캐시, 조직(org) 단위 폴더/파일 트리 동기화를 지원합니다.

## 요구 사항

- Obsidian `1.4.0` 이상
- 도달 가능한 MayaSpace 서버 (REST + WebSocket)

## 설치

### BRAT (베타 배포)

1. 커뮤니티 플러그인에서 **BRAT**(Obsidian42 - BRAT)를 설치·활성화합니다.
2. BRAT → **Add beta plugin** → `<your-gh-user>/mayaspace-plugin` 입력.
3. 설치 후 **설정 → 커뮤니티 플러그인**에서 "MayaSpace"를 활성화합니다.

> BRAT는 이 레포의 **published GitHub Release** 자산(`main.js`, `manifest.json`, `styles.css`)을 받아 설치합니다.
> 레포는 **public** 이어야 하며, 릴리스는 draft가 아닌 **publish 상태**여야 합니다.

### 수동 설치

릴리스에서 `main.js`, `manifest.json`, `styles.css`를 받아
`<vault>/.obsidian/plugins/mayaspace-plugin/`에 넣고 옵시디언을 새로고침합니다.

## 설정

설정 탭에서 지정합니다.

- **REST URL** — 예: `https://mayaspace.<도메인>` (로컬 개발 기본값 `http://localhost:3000`)
- **WebSocket URL** — 예: `wss://mayaspace.<도메인>/ws` (로컬 개발 기본값 `ws://localhost:3001`)
- 계정: 이메일/비밀번호 로그인 또는 회원가입(초대 토큰 / 새 조직)

> ⚠️ **보안:** 이 플러그인은 신뢰 클라이언트로 자격증명을 서버에 직접 전송합니다.
> 운영 환경에서는 반드시 **HTTPS/WSS** 엔드포인트를 사용하세요. 비밀번호는 디스크에 저장되지 않고,
> 발급된 토큰만 vault 로컬(`data.json`)에 저장됩니다.

## 개발

```bash
npm install
npm run dev      # esbuild watch
npm run build    # 타입체크 + 프로덕션 번들 (main.js 생성)
npm test         # jest
```

릴리스는 `manifest.json`의 `version`과 동일한 태그를 push하면
GitHub Action(`.github/workflows/release.yml`)이 빌드 후 자산을 단 draft 릴리스를 만듭니다.

```bash
git tag 0.1.0 && git push origin 0.1.0   # 앞에 v 없이, manifest version과 동일하게
```

## 라이선스

[MIT](./LICENSE)
