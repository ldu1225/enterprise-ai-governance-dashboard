# variables.tf (GCP Cloud Run 및 IAM 리소스 배포 변수 정의)

variable "project_id" {
  type        = string
  description = "대시보드를 기동할 대상 GCP 프로젝트 ID"
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Cloud Run 서비스를 생성할 GCP 대상 리전"
}

variable "audit_dataset_id" {
  type        = string
  default     = "ge_analytics"
  description = "Vertex AI 및 Cloud Audit 감사 로그가 적재되는 BigQuery 데이터셋 ID"
}

variable "billing_dataset_id" {
  type        = string
  default     = "billing_detailed_usage"
  description = "GCP Detailed Billing Export 데이터가 들어있는 BigQuery 데이터셋 ID"
}

variable "billing_table_id" {
  type        = string
  description = "GCP Billing Detailed Export 실시간 과금 스트리밍 테이블 ID"
}

variable "billing_account_id" {
  type        = string
  description = "GCP Billing Account ID (결제 계정 ID)"
}

variable "dashboard_title" {
  type        = string
  default     = "your-company-name"
  description = "대시보드 및 AI 챗봇의 주 브랜드 타이틀 명칭"
}

variable "dashboard_subtitle" {
  type        = string
  default     = "AI Governance & Agent Platform Dashboard"
  description = "대시보드 부 타이틀 명칭"
}
