# Hub-and-Spoke GCP AI Usage & Model Budget Dashboard

[`gcp-ai-usage-caps-api`](https://github.com/ldu1225/gcp-ai-usage-caps-api/tree/main) (`v1.3.0`)를 백엔드로 사용하여 **허브(`duleetest`)** 와 **스포크(`dulee-ai-test`)** 프로젝트의 Google Cloud AI(**Gemini Platform**, **Antigravity**, **Gemini Enterprise**) 사용량을 **유저별·모델별로 트래킹**하고, **예산 상한 초과 시 IAM Deny v2로 자동/수동 차단**하는 경량 BFF 대시보드입니다.

외부 Python/JS 패키지 의존성 없이 Python 3.12 표준 라이브러리와 모던 HTML/CSS/Vanilla JS만으로 동작합니다.

## 주요 기능

1. **개요 & 유저 트래킹 (`duleetest` Hub · `dulee-ai-test` Spoke)**
   - 프로젝트별 필터(`전체`, `duleetest (Hub)`, `dulee-ai-test (Spoke)`), 기간 선택, 실시간 로그 병합(`fresh`) 지원
   - 유저별 요청 수, 토큰, 공식 Cloud Billing Catalog SKU 추정 비용, Hub/Spoke 분리 비용, 예산 소진율, 상태(`active`/`over_cap`/`suspended`/`blocked`) 조회
   - 유저 상세 모달: 일별 사용량 SVG 차트, 프로젝트별/모델별 상세 내역, 적용 중인 모델 규칙 확인
   - 유저별 개별 예산 캡(`PUT /v1/caps/users/{email}` — 합산 또는 Hub/Spoke 프로젝트별 상한) 및 즉시 차단/해제(`POST /v1/users/{email}/block|unblock`)
2. **모델 예산 & 자동 차단**
   - 전역/유저별 모델 예산 규칙(`PUT /v1/model-rules/default`, `PUT /v1/users/{email}/model-rules`): 모델 ID 또는 패턴(`gemini-4-argon`, `claude-*`, `*`)별로 **월 예산($ USD)**, 토큰, RPM 상한 지정 및 초과 시 `block_service`(IAM Deny v2 자동 차단) 집행
   - `POST /v1/model-rules/evaluate` 기반 Dry-Run 미리보기 및 즉시 평가·차단
   - 실시간 Model Garden 카탈로그 + 로그 관측 모델 + 공식 SKU 단가 조회 및 프로젝트별 Org Policy(`constraints/vertexai.allowedModels`) 허용/차단(Dry-Run 포함)
3. **허브/스포크 정책**
   - 전역 지출 캡 정책(`PUT /v1/caps/policy`) 및 Hub/Spoke별 기본 상한(`project_defaults`)
   - 안전 게이트 G1–G7 포함 지출 캡 집행(`POST /v1/caps/enforce`)
   - `duleetest`(Hub) / `dulee-ai-test`(Spoke)별 월간 프로젝트 하드캡 및 Gemini Platform 추론 요청 로그 상태 조회·활성화
4. **위반 & 감사 로그**
   - 모델 예산/정책 위반 이벤트(`GET /v1/model-violations`) 및 거버넌스 감사 로그(`GET /v1/audit-logs`)

## 로컬 실행 방법 (고객사 포털 입장 · 100% REST API 전용)

이 대시보드는 **GCP SDK, `gcloud`, BigQuery, GCS, IAM API를 일절 직접 호출하지 않으며**, 오직 `gcp-ai-usage-caps-api`의 REST 엔드포인트(`/v1/*`)와 발급받은 Scoped M2M API Key(`Authorization: Bearer gcpai_...`)만으로 동작합니다.

기본적으로 `127.0.0.1:8090`에 바인딩됩니다. `caps-dashboard/.env`(gitignored) 또는 환경 변수에 `CAPS_API_BASE_URL`과 `CAPS_API_KEY`를 설정한 뒤 실행합니다.

```bash
CAPS_API_BASE_URL="https://gcp-ai-usage-caps-api-484712896449.asia-northeast3.run.app" \
CAPS_API_KEY="gcpai_..." \
HUB_PROJECT="duleetest" \
SPOKE_PROJECTS="dulee-ai-test" \
python3 caps-dashboard/server.py
```

또는 `caps-dashboard/.env` 파일에 설정해 둔 경우:

```bash
python3 caps-dashboard/server.py
```

브라우저에서 **`http://localhost:8090`** 으로 접속해 최초 로컬 관리자 비밀번호(12자 이상)를 설정하면 바로 `duleetest`와 `dulee-ai-test`를 제어할 수 있습니다.

## Cloud Run 배포 예시

Cloud Run 배포 시에는 반드시 `CAPS_API_KEY`, `DASHBOARD_SESSION_SECRET`(32자 이상), `DASHBOARD_ADMIN_PASSWORD_HASH`(`scrypt$<salt>$<hash>`)를 Secret Manager로 주입해야 합니다.

```bash
# scrypt 비밀번호 해시 생성 예시 (로컬에서 1회 실행 후 Secret Manager에 저장)
python3 -c 'import getpass, sys; sys.path.insert(0, "caps-dashboard"); from app.security import hash_password; print(hash_password(getpass.getpass("Admin password (12+ chars): ")))'
```

## 테스트 실행

```bash
python3 -m unittest discover -s caps-dashboard/tests -v
```

## 2026-11 리디자인 (영상 촬영용 프리미엄 UI)

- **API 호출 보기 (API Call Inspector)**: 헤더의 `API 호출 보기` 버튼을 누르면, BFF가 화면 동작마다 호출한 `gcp-ai-usage-caps-api` `/v1/*` 요청이 실시간으로 표시됩니다(메서드, 경로, 상태, 지연, 요청 본문, 응답 일부). 호출 기록은 세션별 링 버퍼(`GET /api/_trace?since=`)에 저장되며 Authorization 헤더와 API 키는 기록하지 않습니다.
- **사용자 드릴다운**: Hub/Spoke별 및 모델별 비용, 일별 추이, 한도 게이지, 감사 이력, IAM Deny 집행 상태(`propagating` → `enforced`)를 경과 시간과 함께 실시간으로 추적합니다(`GET /api/user/cap?fresh=true` 폴링).
- **비용 탐색기** (`GET /api/costs`), **모델 거버넌스** (Org Policy Dry-run → 적용, 모델 규칙 평가), **정책 & G1–G7**, **감사 & 위반** 탭.
- OpenAI · Anthropic은 "기존 연동 (별도 시스템)" 표시만 하며 수치는 보여주지 않습니다. 화면의 모든 수치는 Caps API에서 받은 값입니다.
- Playwright 촬영용 selector 목록: [`UI_IDS.md`](UI_IDS.md)
- 로컬 테스트 인스턴스: `PORT=8097 DASHBOARD_ADMIN_PASSWORD='<12자 이상>' python3 caps-dashboard/server.py`. 이 경우 비밀번호는 메모리에서만 해시되며 `.local_admin_hash`를 변경하지 않습니다.
