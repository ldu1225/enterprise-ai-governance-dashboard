# 🛡️ Enterprise AI Governance & Agent Platform Dashboard
> **엔터프라이즈 통합 AI 거버넌스 및 Agent 플랫폼 관제 시스템 설치 & 운용 마스터 가이드**

---

## 📐 1. 전체 아키텍처 및 시스템 원리 (System Architecture)

본 플랫폼은 Google Cloud Platform(GCP) 상에서 발생하는 모든 AI 프롬프트 사용량, 과금 비용, 사용자 활동 감사 로그, Model Armor 보안 차단 이벤트를 BigQuery로 실시간 수집하여 통합 관제 대시보드로 시각화합니다.

```mermaid
graph TD
    %% Base Styling Definitions
    classDef gcpFill fill:#4285F4,stroke:#1A73E8,stroke-width:2px,color:#fff;
    classDef bqFill fill:#34A853,stroke:#188038,stroke-width:2px,color:#fff;
    classDef backendFill fill:#EA4335,stroke:#D93025,stroke-width:2px,color:#fff;
    classDef uiFill fill:#FBBC04,stroke:#F9AB00,stroke-width:2px,color:#000;
    classDef secFill fill:#A142F4,stroke:#8E24AA,stroke-width:2px,color:#fff;

    subgraph GCP_Cloud_Infrastructure ["☁️ GCP Cloud Infrastructure & Log Streaming Engine"]
        A["🤖 Vertex AI Agent Builder & Gemini Enterprise"]:::gcpFill -->|Data Access Audit Log| B["🔀 GCP Log Router (Log Sinks)"]:::gcpFill
        C["🛡️ Model Armor Security Filter"]:::secFill -->|PII / Jailbreak Logs| B
        D["💸 GCP Billing Export Engine"]:::gcpFill -->|Detailed Usage Stream| E[("🗄️ BigQuery: billing_detailed_usage")]:::bqFill
        B -->|Audit Sink| F[("🗄️ BigQuery: ge_analytics")]:::bqFill
        B -->|Security Sink| G[("🗄️ BigQuery: modelarmor_security")]:::bqFill
    end

    subgraph Dashboard_Backend ["🐍 Enterprise Backend Server (Python 3.11 / 3.12)"]
        H["⚙️ config.yaml (Single Source of Truth)"]:::backendFill --> I["🚀 backend_server.py"]:::backendFill
        E -->|Billing Standard SQL| I
        F -->|Audit Logs SQL| I
        G -->|Model Armor SQL| I
        I <-->|REST / JSON API Schema| J["✨ Gemini 3.5 Flash Engine"]:::secFill
    end

    subgraph Frontend_UI ["🎨 Real-Time Control Center UI (HTML5 / Vanilla JS / Chart.js)"]
        K["📊 index.html Interactive Dashboard"]:::uiFill <-->|REST API Async Fetch| I
        K <-->|Multi-Turn Conversational Analytics| J
    end
```

---

## 🛠️ 2. 필수 사전 환경 구축 (Prerequisites & OS-Specific Installation)

실행 도중 `command not found` 오류가 절대 발생하지 않도록, 보유하신 OS에 맞게 명령어를 복사하여 터미널(Terminal / PowerShell)에 입력하십시오.

### 2.1 Python 3.10+ 설치 가이드

#### 🍎 macOS (Homebrew 사용)
```bash
# Homebrew 설치 (미설치 시)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Python 3.11 설치
brew install python@3.11
python3 --version
```

#### 🐧 Linux (Ubuntu / Debian)
```bash
sudo apt update && sudo apt install -y python3 python3-pip python3-venv git curl
python3 --version
```

#### 🐧 Linux (RHEL / CentOS / Rocky Linux)
```bash
sudo dnf install -y python311 python3-pip git curl
python3 --version
```

#### 🪟 Windows (PowerShell 관리자 권한)
```powershell
# Chocolatey 사용 시
choco install python --version=3.11.8 -y

# 또는 winget 사용 시
winget install Python.Python.3.11
```

---

### 2.2 Google Cloud SDK (`gcloud` CLI) 및 Git 설치 가이드

#### 🍎 macOS
```bash
brew install --cask google-cloud-sdk git
```

#### 🐧 Linux (Ubuntu/Debian)
```bash
sudo apt-get install -y apt-transport-https ca-certificates gnupg curl git
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
sudo apt-get update && sudo apt-get install -y google-cloud-cli
```

#### 🪟 Windows (PowerShell)
```powershell
winget install Google.CloudSDK
```

#### 🔑 Google Cloud 인증 가이드
설치 후 아래 2개 명령어를 순서대로 실행하여 인증 로그인을 수행합니다:
```bash
# 1. 일반 사용자 인증
gcloud auth login

# 2. Application Default Credentials (ADC) 인증 (Cloud Platform Scope 포함 필수)
gcloud auth application-default login --scopes="https://www.googleapis.com/auth/cloud-platform"
```

---

## ⚙️ 3. 환경설정 파일 (`config.yaml`) 운용 안내

본 프로그램은 **`config.yaml` 파일 단 하나만 수정하면 전체 시스템 백엔드 및 프론트엔드가 100% 자동 적용**되도록 완벽히 설계되어 있습니다. 본 소스 코드는 수정을 전혀 하실 필요가 없습니다!

`config.yaml` 파일 내용:
```yaml
# ==============================================================================
# Enterprise AI Governance & Agent Platform Dashboard Configuration
# ==============================================================================

server:
  port: 8088              # 서비스 포트 (기본값: 8088)
  host: "0.0.0.0"
  cache_ttl_seconds: 300  # API 응답 쿼리 캐시 유지 시간 (초)

gcp:
  # 고객사의 실제 GCP 프로젝트 ID로 변경하십시오.
  project_id: "your-gcp-project-id"
  
  # BigQuery 감사 로그 데이터셋 ID
  audit_dataset_id: "ge_analytics"
  
  # BigQuery GCP Billing Detailed Export 데이터셋 및 스트리밍 테이블 ID
  billing:
    dataset_id: "billing_detailed_usage"
    table_id: "gcp_billing_export_resource_v1_XXXXXX_XXXXXX_XXXXXX"
    account_id: "XXXXXX-XXXXXX-XXXXXX"

dashboard:
  title: "Enterprise AI Governance"
  subtitle: "AI Governance & Agent Platform Control Center"
```

---

## ☁️ 4. GCP 인프라 사전 준비 (BigQuery & Log Router)

GCP 관리자는 대시보드 가동 전 아래 BigQuery 데이터셋 및 Log Router 싱크를 생성해야 합니다.

### 4.1 BigQuery 데이터셋 생성 (Day Partitioning 적용)
```bash
# 프로젝트 ID 설정
export PROJECT_ID="your-gcp-project-id"

# 1. 감사 로그 데이터셋 생성
gcloud alpha bq datasets create ge_analytics --project=$PROJECT_ID --location=us-central1

# 2. 과금 Export 데이터셋 생성
gcloud alpha bq datasets create billing_detailed_usage --project=$PROJECT_ID --location=us-central1

# 3. Model Armor 보안 데이터셋 생성
gcloud alpha bq datasets create modelarmor_security --project=$PROJECT_ID --location=us-central1
```

### 4.2 GCP Log Router (로그 싱크) 생성
```bash
# 1. 감사 로그 싱크 생성 (Gemini Ent & Vertex AI 감사 로그)
gcloud logging sinks create lges-audit-sink \
  bigquery.googleapis.com/projects/$PROJECT_ID/datasets/ge_analytics \
  --log-filter='protoPayload.serviceName=("aiplatform.googleapis.com" OR "cloudaudit.googleapis.com")' \
  --project=$PROJECT_ID

# 2. Model Armor 보안 차단 로그 싱크 생성
gcloud logging sinks create lges-modelarmor-sink \
  bigquery.googleapis.com/projects/$PROJECT_ID/datasets/modelarmor_security \
  --log-filter='jsonPayload.event_type="MODEL_ARMOR_BLOCK"' \
  --project=$PROJECT_ID
```

---

## 💻 5. 로컬(Local) 환경 가동 방법

```bash
# 1. 가상환경 생성 및 활성화
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 2. 필수 라이브러리 설치
pip install google-cloud-bigquery google-auth google-api-python-client PyYAML

# 3. 대시보드 백엔드 가동
python3 backend_server.py
```
* 서버 가동 후 웹 브라우저를 열고 `http://localhost:8088`에 접속합니다.

---

## 🚀 6. GCP Cloud Run 실서버 자동 배포 가이드

```bash
# 1. GCP 프로젝트 지정
gcloud config set project your-gcp-project-id

# 2. Cloud Run 원클릭 배포
gcloud run deploy lges-ai-governance-dashboard \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```
* 배포가 완료되면 터미널에 생성된 `https://...run.app` 실서버 Live URL로 즉시 접속 가능합니다.

---

## ❓ 7. 트러블슈팅 및 자주 묻는 질문 (FAQ)

### Q1. 당일 Gemini 3.5 Flash 호출 통계 및 과금 비용이 대시보드 그래프에 바로 안 보입니다.
> **원인**: GCP Billing Detailed Export (BigQuery 과금 연동) 파이프라인 특성상 **2시간~4시간(최대 12시간)의 배치 정산 지연(Latency)**이 발생합니다.<br>
> **해결**: 구글 과금 파이프라인 정산 후 BigQuery에 집계되면 그래프에 동적 반영됩니다.

### Q2. `401 ACCESS_TOKEN_TYPE_UNSUPPORTED` 에러가 발생합니다.
> **해결**: 아래 명령어로 ADC 자격 증명을 갱신합니다.
> ```bash
> gcloud auth application-default login --scopes="https://www.googleapis.com/auth/cloud-platform"
> ```

### Q3. `Address already in use` 오류가 발생합니다.
> **해결**: 아래 명령어로 8088 포트 점유 프로세스를 종료합니다.
> ```bash
> lsof -ti:8088 | xargs kill -9
> ```

---
* **문서 버전**: v1.0.0 Enterprise Release
* **라이선스**: Enterprise Platform License
