# 🛡️ Enterprise AI Governance & Agent Platform Dashboard

> **엔터프라이즈 통합 AI 거버넌스, 과금 추적 및 AI 챗봇 관제 플랫폼 마스터 가이드**
> **GCP Cloud Run 라이브 URL**: https://your-dashboard-service-hash.run.app

---

## 📐 1. 전체 아키텍처 및 시스템 원리 (System Architecture)

본 플랫폼은 Google Cloud Platform(GCP) 상에서 발생하는 모든 AI 프롬프트 사용량, 과금 비용, 사용자 활동 감사 로그, Model Armor 보안 차단 이벤트를 BigQuery로 실시간 수집하고, **Gemini 3.5 Flash 실시간 조율 엔진**을 통해 관제 대시보드 및 AI 챗봇으로 통합 제공합니다.

```mermaid
graph TD
    classDef gcpFill fill:#4285F4,stroke:#1A73E8,stroke-width:2px,color:#fff;
    classDef bqFill fill:#34A853,stroke:#188038,stroke-width:2px,color:#fff;
    classDef backendFill fill:#EA4335,stroke:#D93025,stroke-width:2px,color:#fff;
    classDef uiFill fill:#FBBC04,stroke:#F9AB00,stroke-width:2px,color:#000;
    classDef secFill fill:#A142F4,stroke:#8E24AA,stroke-width:2px,color:#fff;

    subgraph GCP_Cloud_Infrastructure ["☁️ GCP Cloud Infrastructure & Log Streaming Engine"]
        A["🤖 Vertex AI Agent Builder & Gemini Enterprise"]:::gcpFill -->|Data Access Audit Log| B["🔀 GCP Log Router (Log Sinks)"]:::gcpFill
        C["🛡️ Model Armor Security Filter"]:::secFill -->|Sanitized Verdict Block Logs| B
        D["💸 GCP Detailed Billing Export Engine"]:::gcpFill -->|Resource Usage Stream| E[("🗄️ BigQuery: billing_detailed_usage")]:::bqFill
        B -->|Audit Log Sink| F[("🗄️ BigQuery: ge_analytics")]:::bqFill
        B -->|Model Armor Operations Sink| G[("🗄️ BigQuery: modelarmor_sanitize_operations")]:::bqFill
    end

    subgraph Dashboard_Backend ["🐍 Enterprise Backend Server (Python 3.11 / Multi-Threaded)"]
        H["⚙️ config.yaml (Single Source of Truth)"]:::backendFill --> I["🚀 backend_server.py"]:::backendFill
        E -->|Billing Standard SQL| I
        F -->|Audit Logs SQL| I
        G -->|Model Armor SQL| I
        I <-->|REST API / Dynamic SKU Orchestration| J["✨ Gemini 3.5 Flash Engine"]:::secFill
    end

    subgraph Frontend_UI ["🎨 Real-Time Control Center UI (HTML5 / Vanilla JS / Chart.js)"]
        K["📊 index.html Interactive Dashboard"]:::uiFill <-->|REST API Async Fetch| I
        K <-->|2nd-Pass Fact-Based Conversational Analytics| J
    end
```

---

## 🛠️ 2. GCP Infrastructure Setup & Data Pipeline (구글 클라우드 환경 설정 및 데이터 스트리밍)

본 플랫폼을 성공적으로 구동하기 위해서는 GCP 콘솔 상에서 빌링 스트리밍 및 로그 라우터 싱크가 사전 구성되어 있어야 합니다.

### 2.1 GCP Detailed Billing Export (상세 과금 데이터 스트리밍)
GCP 리소스별 실시간 상세 비용을 BigQuery로 자동 내보내기 하도록 설정합니다.
1. **GCP Console** 접속 후 **Billing (결제)** 메뉴로 이동합니다.
2. 좌측 메뉴에서 **Billing Export (결제 데이터 내보내기)**를 클릭합니다.
3. **Detailed Cost Export (상세 비용 내보내기)** 탭을 선택하고 **Edit Settings (설정 편집)**을 누릅니다.
4. 데이터를 적재할 **GCP Project** 및 **BigQuery Dataset**을 지정하거나 새로 생성합니다.
5. 설정을 저장하면 `gcp_billing_export_resource_v1_{BILLING_ACCOUNT_ID}` 형태의 테이블이 자동 생성되어 실시간으로 리소스별 요금이 스트리밍됩니다.
6. 생성된 **Dataset ID**와 **Table ID**를 `config.yaml` 의 `billing` 섹션에 복사하여 설정합니다.

### 2.2 GCP Log Router & Sink Setup (감사 및 보안 로그 싱크 설정)
> [!IMPORTANT]
> **⚠️ 필수 사전 설정 (Vertex AI 감사 로그 활성화)**:
> Veo 3.1 Lite, Imagen 등 Vertex AI 모델 예측 호출 및 NotebookLM API 사용량을 정상 감지하려면 **GCP Console ➡️ IAM & Admin ➡️ Audit Logs** 메뉴로 이동한 뒤, **`Vertex AI API`** 서비스를 찾아 우측 정보 창의 **`Data Read` 및 `Data Write` 감사 로그** 체크박스를 반드시 체크하여 활성화(Save)해 주셔야 합니다. 이 작업을 생략하면 데이터 접근(Data Access) 로그가 생성되지 않아 대시보드 상에 카운트되지 않습니다.

Vertex AI Agent, Cloud Audit, Model Armor 보안 차단 기록 로그를 BigQuery로 포워딩하는 로그 싱크를 생성합니다.

1. **GCP Console ➡️ Logging ➡️ Log Router (로그 라우팅)** 메뉴로 이동합니다.
2. **Create Sink (싱크 만들기)**를 클릭하고 다음 정보를 설정합니다:
   - **Sink Name (싱크 이름)**: `ai-governance-audit-sink`
   - **Sink Destination (싱크 대상)**: `BigQuery dataset`을 선택하고 적재할 데이터셋(예: `ge_analytics`)을 연결합니다.
3. **Choose logs to include in sink (싱크에 포함할 로그 선택)** 필터 란에 아래의 **핵심 Log Inclusion Filter** 쿼리를 그대로 입력합니다:
   ```query
   -- 1. Vertex AI Agent Builder & Gemini Enterprise Activity Logs
   (logName:"projects/YOUR_PROJECT_ID/logs/discoveryengine.googleapis.com%2Fgemini_enterprise_user_activity" OR
    logName:"projects/YOUR_PROJECT_ID/logs/discoveryengine.googleapis.com%2Fgen_ai_user_message") OR
   -- 2. Cloud Audit Data Access Logs (NotebookLM & Workspace Activity)
   (logName:"projects/YOUR_PROJECT_ID/logs/cloudaudit.googleapis.com%2Fdata_access" AND 
    (protoPayload.serviceName="discoveryengine.googleapis.com" OR protoPayload.serviceName="notebooklm.googleapis.com")) OR
   -- 3. Model Armor Security Sanitization Block Logs
   (logName:"projects/YOUR_PROJECT_ID/logs/modelarmor.googleapis.com%2Fsanitize_operations")
   ```
4. **Create Sink**를 완료하면 BigQuery 데이터셋에 관련 로그 테이블들이 자동 구성되어 대시보드가 실시간 분석을 시작할 수 있게 됩니다.

### 2.3 IAM Service Account Permissions (필요 서비스 계정 권한)
백엔드 서버 또는 Cloud Run에 구동되는 컨테이너가 BigQuery 데이터를 읽을 수 있도록 서비스 계정에 최소한 다음 IAM 권한을 부여하십시오:
- **`BigQuery Data Viewer` (roles/bigquery.dataViewer)**: 빌링 및 감사 로그 데이터셋 읽기용
- **`BigQuery Job User` (roles/bigquery.jobUser)**: BigQuery 쿼리 실행 직무 수행용

---

## 💾 3. BigQuery 데이터 보존 기한 및 비용 최적화 (Data Retention & Cost Optimization)

감사 로그 및 실시간 빌링 데이터가 BigQuery에 무제한 누적되어 스토리지 비용이 불필요하게 청구되는 것을 방지하기 위해, 관리자는 **최대 4개월(120일) 보존 정책**을 강제하도록 설정할 수 있습니다. 

### 3.1 파티션별 만료 기한 설정 (Time Partition Expiration - 적극 권장)
감사 로그 테이블들은 날짜(`timestamp`) 기준으로 파티션이 나뉘어 있습니다. 테이블 자체는 유지하면서 **120일(4개월)이 지난 과거 데이터 행들만 백엔드에서 자동 순차 삭제**되도록 설정합니다.

1. **Cloud Shell 또는 로컬 CLI**를 엽니다.
2. 아래 `bq update` 명령어를 실행하여 파티션 유효기간을 120일(10,368,000초)로 업데이트합니다:
   ```bash
   # 1. Gemini Enterprise 사용자 활동 로그 파티션 만료 설정 (120일)
   bq update --time_partitioning_expiration 10368000 your-gcp-project-id:your_audit_dataset_id.discoveryengine_googleapis_com_gemini_enterprise_user_activity

   # 2. Gemini Enterprise 유저 메시지 로그 파티션 만료 설정 (120일)
   bq update --time_partitioning_expiration 10368000 your-gcp-project-id:your_audit_dataset_id.discoveryengine_googleapis_com_gen_ai_user_message

   # 3. Model Armor 보안 차단 로그 파티션 만료 설정 (120일)
   bq update --time_partitioning_expiration 10368000 your-gcp-project-id:your_audit_dataset_id.modelarmor_googleapis_com_sanitize_operations
   ```
3. 설정이 완료되면 구글 클라우드가 매일 백그라운드에서 120일을 초과한 과거 로그 파티션을 자동으로 영구 파기하여 비용을 극대화하여 아껴줍니다.

### 3.2 데이터셋 기본 테이블 만료 기한 설정 (Default Table Expiration)
데이터셋 내에 향후 임시 혹은 신규 생성되는 모든 감사/과금 테이블들의 기본 수명을 일괄적으로 120일로 제한합니다.

1. **GCP BigQuery 콘솔**로 이동합니다.
2. 생성한 감사 로그 데이터셋(예: `ge_analytics`)을 선택하고 **[Details (세부정보)] ➡️ [Edit (편집)]**을 클릭합니다.
3. **Table Expiration (테이블 만료)** 체크박스를 활성화하고 **`120` 일**로 입력한 뒤 저장합니다.
4. (CLI 명령어 실행):
   ```bash
   bq update --default_table_expiration 10368000 your-gcp-project-id:your_audit_dataset_id
   ```

### 3.3 파이썬 스크립트를 통한 데이터셋 전체 테이블 보존 정책 일괄 주입 (Python SDK Automation - Optional)
CLI 명령어 권한 오류가 나거나 여러 테이블을 한 번에 처리하고 싶을 때, 관리자가 로컬 가상환경에서 파이썬 스크립트를 활용해 데이터셋 내 전체 테이블의 만료일(예: 90일)을 안전하게 일괄 지정할 수 있는 옵셔널 자동화 스크립트입니다.

1. **`set_retention.py`** 파일을 생성하고 아래 코드를 복사합니다 (GCP 프로젝트 및 데이터셋 ID는 템플릿 환경에 맞게 수정하십시오):
   ```python
   # set_retention.py
   from google.cloud import bigquery
   from google.auth import default
   import datetime

   # 1. GCP ADC 사용자 자격증명 로드
   credentials, project = default()
   
   # 2. GCP Project ID 지정
   client = bigquery.Client(credentials=credentials, project="your-gcp-project-id")

   # 3. 보존 기한 설정 (90일)
   EXPIRATION_MS = 90 * 24 * 60 * 60 * 1000  # 90일 (밀리초)
   EXPIRATION_DELTA = datetime.timedelta(days=90)

   # 4. 대상 데이터셋 목록
   datasets = ["your_audit_dataset_id", "your_billing_dataset_id"]

   for ds_name in datasets:
       print(f"=== Processing Dataset: {ds_name} ===")
       dataset_ref = client.dataset(ds_name)
       
       # 데이터셋 레벨 기본 테이블 만료일 지정 (90일)
       dataset = client.get_dataset(dataset_ref)
       dataset.default_table_expiration_ms = EXPIRATION_MS
       client.update_dataset(dataset, ["default_table_expiration_ms"])
       print(f"Dataset {ds_name} default expiration set to 90 days.")

       # 데이터셋 내 모든 테이블 루프
       tables = list(client.list_tables(dataset_ref))
       for t in tables:
           table = client.get_table(t.reference)
           if table.time_partitioning:
               # 파티션 테이블 ➡️ 파티션별 만료일 90일 지정
               table.time_partitioning.expiration_ms = EXPIRATION_MS
               client.update_table(table, ["time_partitioning"])
               print(f"  -> Table {t.table_id} partition expiration set to 90 days.")
           else:
               # 비파티션 테이블 ➡️ 테이블 만료일 90일 지정 (오늘부터 90일 후 삭제)
               table.expires = datetime.datetime.now(datetime.timezone.utc) + EXPIRATION_DELTA
               client.update_table(table, ["expires"])
               print(f"  -> Table {t.table_id} table expiration set to 90 days.")
   ```
2. 로컬 가상환경에서 아래와 같이 실행합니다:
   ```bash
   python3 set_retention.py
   ```
3. 실행 완료 시 두 데이터셋 내부의 모든 파티션 및 비파티션 테이블에 90일 만료 규칙이 100% 동적 주입됩니다.

---

## 🌟 4. 핵심 기능 및 엔터프라이즈 하이라이트 (Key Features)

### 1️⃣ LLM 모델별 과금 추이 및 동적 SKU 묶음 리포트
- **GCP Detailed Billing Export 100% 실시간 연동**: `billing_detailed_usage` 테이블을 직접 쿼리하여 Claude 3.5 Sonnet / Sonnet 4.5, Gemini 3.5 Flash, Gemini 3.1 Flash Lite, Gemini 3.0 Pro 등 모든 생성형 AI 모델의 사용 토큰 수량(Tokens) 및 소요 비용($ USD)을 추적합니다.
- **Gemini 3.5 Flash 동적 SKU 매핑**: 복잡하고 가변적인 GCP Billing SKU 문자열을 Gemini 3.5 Flash가 동적으로 그룹핑하여 대표 모델명으로 자동 합산 및 정렬합니다.
- **동적 시스템 일자 앵커링 (`datetime.date.today()`)**: 조회 기준일을 시스템 현재 날짜로 자동 계산하여 향후 접속 시에도 항상 오늘 시점까지의 과금 꺾은선 피크를 완벽히 표출합니다.

### 2️⃣ Model Armor 실시간 보안 차단 감사 로그 (Sanitized Verdict Block)
- **실제 프롬프트 텍스트 조회**: BigQuery `modelarmor_sanitize_operations` 테이블과 직결되어, 차단된 원본 사용자 프롬프트 문구와 차단 사유(`VERDICT_BLOCK: PI_JAILBREAK_MATCH` 등)를 100% 투명하게 관제합니다.

### 3️⃣ Gemini 3.5 Flash 기반 2단계(2nd-Pass) 팩트 분석 AI 챗봇
- **전사 6대 BigQuery 데이터셋 100% 통합 인지**: Billing, ModelArmor, DiscoveryEngine, CloudAudit, CodeAssist, AgentRegistry 데이터셋 전체를 지능적으로 쿼리합니다.
- **실행 결과 기반 2단계 팩트 분석 (Execute-then-Analyze)**: 뻔한 원론적 답변 대신, BigQuery에서 실제 조회된 팩트 데이터(토큰 수량, 달러 비용, 차단 텍스트 등)를 읽고 100% 명확한 분석 결과를 작성합니다.
- **지능형 차트 조건부 렌더링**: 수치 통계 질문(Top 3 비용, 유저 랭킹 등)에만 정밀 차트를 렌더링하고, 프롬프트 문구 및 이력 목록 조회 시에는 차트를 비활성화하여 정갈한 텍스트 리포트를 제공합니다.

---

## 📊 5. 대시보드 메트릭 및 BigQuery 데이터 소스 매핑 (Metrics Map)

대시보드의 개별 카드 및 그래프를 산출하는 데 사용된 구체적인 BigQuery 원천 데이터 및 컬럼 매핑 관계는 다음과 같습니다:

| 대시보드 UI 영역 (Metric Card) | GCP BigQuery 데이터 원천 및 테이블명 (Source Table) | 추출 조건 및 사용된 필드 (SQL Conditions & Fields) | 설명 (Description) |
| :--- | :--- | :--- | :--- |
| **Gemini Enterprise 실제 활성 사용자 수** | `cloudaudit_googleapis_com_activity` & `discoveryengine_googleapis_com_gen_ai_user_message` | `COUNT(DISTINCT email)`<br> - `protopayload_auditlog.authenticationInfo.principalEmail`<br> - `jsonPayload.user`<br> - (gserviceaccount 제외 필터 적용) | 선택한 기간 동안 플랫폼에 로그인하여 활동한 순수 인간(Human) 유저 수량입니다. |
| **Gemini Enterprise 실제 할당 라이선스 수** | GCP Discovery Engine REST API | `GET /v1alpha/projects/{project}/locations/global/licenseConfigs`<br> - `licenseCount` (state = 'ACTIVE') | GCP LicenseConfig API 통신을 통해 현재 전사 활성화된 실제 구매/할당 라이선스 볼륨을 실시간 조회합니다. |
| **Gemini Enterprise 유저 프롬프트 제출 수** | `discoveryengine_googleapis_com_gen_ai_user_message` | `COUNT(1)` WHERE `jsonPayload.content.role = 'user'`<br> - (더미/배치 요약 프롬프트 구문 제외) | 사용자가 Gemini Enterprise 및 Agent Builder 대화창에서 보낸 고유 질문 제출 횟수 누계입니다. |
| **선택 기간 총 과금액 (Total Billing Sum)** | `billing_detailed_usage.gcp_billing_export_resource_v1_...` | `SUM(cost)` WHERE `usage_start_time` 필터 매칭 | 구글 클라우드에 적재되는 전사 스트리밍 빌링 원본 행의 cost 금액을 실시간 합산한 누적 청구 금액입니다. |
| **Model Armor Sanitized (보안 차단 건수)** | `modelarmor_googleapis_com_sanitize_operations` | `COUNT(1)` WHERE `sanitizationVerdict LIKE '%BLOCK%'` | Model Armor 프롬프트 인젝션 및 개인정보 유출 검사 필터에 걸려 차단된 보안 위험 시도 건수입니다. |
| **NotebookLM 생성 및 활성 노트북 수** | `cloudaudit_googleapis_com_data_access` | `COUNT(DISTINCT notebook_id)` WHERE `protopayload_auditlog.resourceName LIKE '%/notebooks/%'` | BigQuery 감사 로그에 기록된 리소스 경로 내 고유 노트북 인스턴스의 생성/작동 수량입니다. |
| **NotebookLM 활성 사용자 수** | `cloudaudit_googleapis_com_data_access` | `COUNT(DISTINCT principalEmail)` WHERE `methodName = 'GenerateFreeFormStreamed'` | 선택한 관제 기간 동안 노트북에 접속하여 한 번 이상 질문을 보낸 고유 계정 수입니다. |
| **총 노트북 질문 및 대화 호출 수** | `cloudaudit_googleapis_com_data_access` | `COUNT(DISTINCT resourceName || principalEmail || timestamp)` WHERE `methodName = 'GenerateFreeFormStreamed'` | 중복 스트리밍 연결 호출을 제외하고 순수 유저가 노트북에서 전송한 진짜 프롬프트 제출 누적 수량입니다. |
| **사용자 파일 업로드 감사 내역 (Table)** | `discoveryengine_googleapis_com_gen_ai_user_message` | `jsonPayload.content.parts[2].text` WHERE `parts[1].text LIKE '%<start_of_user_uploaded_file%'` | 파일이 구글 백엔드에 안전하게 가공되어 업로드 및 인덱싱이 완료되었는지 확인하는 상태 메시지를 감사 로그에서 다이렉트로 매핑합니다. |
| **날짜별 에이전트별 사용 횟수 (Chart)** | `discoveryengine_googleapis_com_gemini_enterprise_user_activity` | `COUNT(1)` GROUP BY `jsonPayload.request.userevent.agentspaceinfo.agentinfo.name` (에이전트 표시명) | 하드코딩 매핑 사전 없이, 빅쿼리 활동 로그 jsonPayload 내부에 들어 있는 실시간 에이전트 DisplayName 명칭을 그대로 100% 동적 연동하여 레전드로 차트 표출합니다. |

---

## 🛠️ 6. 단계별 빌드 및 배포 마스터 가이드 (Step-by-Step Deployment Guide)

고객사 환경에 플랫폼을 구축 및 빌드하기 위한 5단계 표준 흐름입니다. 아래 단계를 순서대로 빠짐없이 진행하십시오.

### 1️⃣ [Step 1] GCP Infrastructure Setup (구글 클라우드 사전 인프라 구성)
대시보드 구동의 기초가 되는 빅쿼리 과금 스트리밍 및 감사 로그 수집 싱크를 준비합니다.
1. **GCP Billing Export 활성화**: 결제 콘솔 내 'Billing Export' 메뉴에서 'Detailed Cost Export'를 활성화하고 빅쿼리 데이터셋을 연결합니다. (생성된 `gcp_billing_export_resource_v1_{ACCOUNT_ID}` 테이블명 확인)
2. **Log Router 감사 로그 싱크 구성**: Logging 콘솔의 'Log Router'에서 빅쿼리 적재 싱크를 만들고 본 문서 **2.2절의 로그 인클루전 필터 쿼리**를 주입하여 `ge_analytics` 등의 데이터셋에 로그가 자동 적재되도록 설정합니다.

### 2️⃣ [Step 2] config.yaml 환경설정 튜닝 (Dashboard Configuration)
프로젝트 환경에 맞게 Single Source of Truth 설정 파일을 작성합니다.
1. 프로젝트 루트의 `config.yaml` 파일을 엽니다.
2. 아래 주요 항목에 [Step 1]에서 확인한 실측 GCP 자원 정보들을 정확하게 기입합니다:
   - `gcp.project_id`: "사용자의 실측 GCP 프로젝트 ID"
   - `gcp.audit_dataset_id`: "감사 로그가 쌓이는 빅쿼리 데이터셋 ID"
   - `gcp.billing.dataset_id`: "빌링 데이터셋 ID"
   - `gcp.billing.table_id`: "gcp_billing_export_resource_v1_{BILLING_ACCOUNT_ID}"
   - `gcp.billing.account_id`: "GCP 결제 계정 ID (E.g. 01E9C5-...)"

### 3️⃣ [Step 3] GCP Local Authentication Setup (로컬 인증 토큰 바인딩)
로컬 장비 및 서버에서 빅쿼리에 접근하기 위해 사용자 자격증명(ADC) 토큰을 인증합니다.
1. 로컬 터미널에 GCP SDK(`gcloud`)가 설치되어 있는지 확인합니다.
2. 아래 명령을 실행하여 브라우저 로그인을 완료하고 Application Default Credentials를 활성화합니다:
   ```bash
   gcloud auth application-default login
   ```

### 4️⃣ [Step 4] 로컬 가상환경 구성 및 개발 서버 구동 (Local Launching)
로컬 샌드박스에서 대시보드 동작을 우선 빌드하고 기동합니다.
1. 프로젝트 루트 경로로 이동하여 Python 가상환경을 활성화하고 의존성을 설치합니다:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install google-cloud-bigquery google-genai pyyaml
   ```
2. 아래 명령어로 다중 스레드 백엔드 관제 서버를 8088 포트로 즉시 기동합니다:
   ```bash
   python3 backend_server.py
   ```
3. 웹 브라우저를 열고 `http://localhost:8088/` 에 접속하여 실시간 AI 거버넌스 렌더링을 최종 확인합니다.

### 5️⃣ [Step 5] GCP Cloud Run 프로덕션 컨테이너 빌드 & 배포 (Cloud Production Deploy)
대시보드를 구글 클라우드 런(Serverless Cloud Run) 환경으로 완전 무중단 프로덕션 릴리즈합니다.
1. 아래 2라인 쉘 커맨드를 차례대로 실행하여 로컬 ADC 토큰을 기반으로 소스코드를 GCP Artifact Registry에 컨테이너 이미지로 자동 원격 빌딩하고 배포합니다:
   ```bash
   TOKEN=$(gcloud auth application-default print-access-token)
   CLOUDSDK_AUTH_ACCESS_TOKEN=$TOKEN gcloud run deploy ai-governance-dashboard \
     --source . \
     --region us-central1 \
     --allow-unauthenticated \
     --project "your-gcp-project-id"
   ```
2. 배포 완료 후 터미널에 출력되는 고유 **Service URL**(`https://your-dashboard-service-hash.run.app`)을 통해 전사 유저가 대시보드와 AI 팩트 체크 챗봇을 즉각 실시간 사용할 수 있게 됩니다!

---

## 📄 7. 구성 파일 설명 (Project Structure)

- `backend_server.py`: Python 기반 다중 스레드 HTTP REST 백엔드 서버 (BigQuery Integration & Gemini 3.5 Flash 2nd-Pass Fact Analyzer Engine)
- `index.html`: 크렉스티오(Crextio) 엔터프라이즈 디자인 시스템 기반 프론트엔드 대시보드 & AI 챗봇 모달 UI
- `config.yaml`: BigQuery 데이터셋, 프로젝트 ID, 쿼리 설정 튜닝 파일 (Single Source of Truth)
- `Dockerfile`: Google Cloud Run 컨테이너 빌드 파일

