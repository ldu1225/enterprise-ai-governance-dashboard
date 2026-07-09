# main.tf (Enterprise AI Governance Dashboard IaC Deployment)

terraform {
  required_version = ">= 1.3.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 4.50.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# 1. 대시보드 전용 최소 권한(Least Privilege) 서비스 계정 생성
resource "google_service_account" "dashboard_sa" {
  account_id   = "ai-governance-dashboard-sa"
  display_name = "AI Governance Dashboard Runner"
  project      = var.project_id
}

# 2. BigQuery 데이터 조회 및 쿼리 잡(Job) 실행 최소 권한 부여
resource "google_project_iam_member" "bq_viewer" {
  project = var.project_id
  role    = "roles/bigquery.dataViewer"
  member  = "serviceAccount:${google_service_account.dashboard_sa.email}"
}

resource "google_project_iam_member" "bq_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.dashboard_sa.email}"
}

resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.dashboard_sa.email}"
}

# 3. Google Cloud Run v2 서비스 생성 (Pre-built 이미지 기반 기동)
resource "google_cloud_run_v2_service" "dashboard" {
  name     = var.dashboard_service_name
  location = var.region
  project  = var.project_id

  template {
    service_account = google_service_account.dashboard_sa.email

    containers {
      # 🎯 우리가 빌드하여 퍼블리시 해놓은 글로벌 Docker 컨테이너 이미지 참조
      image = "gcr.io/your-global-registry/ai-governance-dashboard:v1.0.0"

      # 🎯 소스코드와 인프라 분리를 위해 컨피그 환경 변수를 런타임에 동적 맵핑
      env {
        name  = "PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "AUDIT_DATASET_ID"
        value = var.audit_dataset_id
      }
      env {
        name  = "BILLING_DATASET_ID"
        value = var.billing_dataset_id
      }
      env {
        name  = "BILLING_TABLE_ID"
        value = var.billing_table_id
      }
      env {
        name  = "BILLING_ACCOUNT_ID"
        value = var.billing_account_id
      }
      env {
        name  = "DASHBOARD_TITLE"
        value = var.dashboard_title
      }
      env {
        name  = "DASHBOARD_SUBTITLE"
        value = var.dashboard_subtitle
      }
    }
  }

  # 기존 사내 VPC 망을 사용 중인 환경의 경우 ingress 정책 통제
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Output: 배포 완료 후 고객사 관리자가 HTTPS URL 주소를 바로 획득할 수 있도록 출력
output "dashboard_url" {
  value       = google_cloud_run_v2_service.dashboard.uri
  description = "대시보드 접속 서비스 URL (IAP 부하분산기 앞단 연결 필요)"
}
