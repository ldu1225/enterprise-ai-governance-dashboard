import urllib.request
import json
import os
import google.auth
import google.auth.transport.requests

def deploy_service():
    print("=== Deploying LGES AI Governance Dashboard to Cloud Run (Project: duleetest) ===")
    creds, project_id = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    creds.refresh(google.auth.transport.requests.Request())
    token = creds.token
    
    region = "us-central1"
    service_name = "lges-ai-governance-dashboard"
    
    # 1. Cloud Run Knative Service Spec Definition
    service_body = {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": service_name,
            "namespace": project_id,
            "labels": {
                "cloud.googleapis.com/location": region
            }
        },
        "spec": {
            "template": {
                "spec": {
                    "containers": [
                        {
                            "image": "gcr.io/duleetest/lges-ai-governance-app:latest",
                            "env": [
                                {"name": "PROJECT_ID", "value": "duleetest"},
                                {"name": "AUDIT_DATASET_ID", "value": "ge_analytics"},
                                {"name": "BILLING_DATASET_ID", "value": "billing_detailed_usage"},
                                {"name": "BILLING_TABLE_ID", "value": "gcp_billing_export_resource_v1_01E9C5_E0B654_4D2CB0"},
                                {"name": "DEPLOY_TIMESTAMP", "value": "20260706_144400"}
                            ],
                            "ports": [{"containerPort": 8080}]
                        }
                    ]
                }
            }
        }
    }
    
    url = f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{project_id}/services"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        req = urllib.request.Request(url, data=json.dumps(service_body).encode('utf-8'), headers=headers, method="POST")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            live_url = data.get("status", {}).get("url", "")
            print(f"🎉 SUCCESS! Service Created in Cloud Run!")
            print(f"🌐 Cloud Run Live URL: {live_url}")
            return live_url
    except urllib.error.HTTPError as err:
        if err.code == 409: # Already exists -> Update service
            print("ℹ️ Service already exists. Updating existing Cloud Run Service...")
            update_url = f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{project_id}/services/{service_name}"
            req_put = urllib.request.Request(update_url, data=json.dumps(service_body).encode('utf-8'), headers=headers, method="PUT")
            with urllib.request.urlopen(req_put) as resp_put:
                data_put = json.loads(resp_put.read().decode('utf-8'))
                live_url = data_put.get("status", {}).get("url", "")
                print(f"🎉 SUCCESS! Cloud Run Service Updated!")
                print(f"🌐 Cloud Run Live URL: {live_url}")
                return live_url
        else:
            print(f"❌ Cloud Run Deploy Error {err.code}:", err.read().decode('utf-8'))
            return None

if __name__ == "__main__":
    deploy_service()
