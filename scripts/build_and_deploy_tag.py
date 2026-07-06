import urllib.request
import json
import tarfile
import io
import os
import time
import google.auth
import google.auth.transport.requests

def main():
    creds, project_id = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    creds.refresh(google.auth.transport.requests.Request())
    token = creds.token

    ts = int(time.time())
    target_image = f"gcr.io/{project_id}/lges-ai-governance-app:v{ts}"
    print(f"=== Building Real Container Image: {target_image} ===")

    # 1. Archive workspace files
    tar_stream = io.BytesIO()
    with tarfile.open(fileobj=tar_stream, mode="w:gz") as tar:
        for root, dirs, files in os.walk("."):
            if any(p in root for p in [".git", "node_modules", "__pycache__", ".tempmediaStorage"]):
                continue
            for f in files:
                if f.endswith(".pyc") or f.endswith(".tar.gz"):
                    continue
                full_p = os.path.join(root, f)
                rel_p = os.path.relpath(full_p, ".")
                tar.add(full_p, arcname=rel_p)

    archive_data = tar_stream.getvalue()
    bucket_name = f"{project_id}_cloudbuild"
    object_name = f"source-{ts}.tgz"

    # Upload to GCS
    gcs_upload_url = f"https://storage.googleapis.com/upload/storage/v1/b/{bucket_name}/o?uploadType=media&name={object_name}"
    req_upload = urllib.request.Request(gcs_upload_url, data=archive_data, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/x-tar"
    })
    with urllib.request.urlopen(req_upload) as resp:
        print("✅ Source Code Uploaded to GCS!")

    # Trigger Cloud Build
    url_build = f"https://cloudbuild.googleapis.com/v1/projects/{project_id}/builds"
    build_spec = {
        "source": {
            "storageSource": {
                "bucket": bucket_name,
                "object": object_name
            }
        },
        "steps": [
            {
                "name": "gcr.io/cloud-builders/docker",
                "args": ["build", "--no-cache", "-t", target_image, "."]
            },
            {
                "name": "gcr.io/cloud-builders/docker",
                "args": ["push", target_image]
            }
        ],
        "images": [target_image]
    }

    req_build = urllib.request.Request(url_build, data=json.dumps(build_spec).encode(), headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    })

    with urllib.request.urlopen(req_build) as resp_b:
        b_data = json.loads(resp_b.read().decode())
        build_id = b_data.get("metadata", {}).get("build", {}).get("id", "")
        print(f"🚀 Cloud Build Started! Build ID: {build_id}")
        
        for _ in range(40):
            time.sleep(3)
            b_status_url = f"https://cloudbuild.googleapis.com/v1/projects/{project_id}/builds/{build_id}"
            req_s = urllib.request.Request(b_status_url, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req_s) as resp_s:
                st_data = json.loads(resp_s.read().decode())
                status = st_data.get("status", "")
                print(f"Build status: {status}...")
                if status == "SUCCESS":
                    print(f"🎉 NEW IMAGE BUILT SUCCESSFULLY: {target_image}")
                    # Deploy to Cloud Run immediately
                    region = "us-central1"
                    service_name = "lges-ai-governance-dashboard"
                    service_url = f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{project_id}/services/{service_name}"
                    
                    service_body = {
                        "apiVersion": "serving.knative.dev/v1",
                        "kind": "Service",
                        "metadata": {
                            "name": service_name,
                            "namespace": project_id
                        },
                        "spec": {
                            "template": {
                                "spec": {
                                    "containers": [
                                        {
                                            "image": target_image,
                                            "env": [
                                                {"name": "PROJECT_ID", "value": project_id},
                                                {"name": "AUDIT_DATASET_ID", "value": "ge_analytics"},
                                                {"name": "BILLING_DATASET_ID", "value": "billing_detailed_usage"},
                                                {"name": "BILLING_TABLE_ID", "value": "gcp_billing_export_resource_v1_01E9C5_E0B654_4D2CB0"},
                                                {"name": "BUILD_TAG", "value": f"v{ts}"}
                                            ],
                                            "ports": [{"containerPort": 8080}]
                                        }
                                    ]
                                }
                            }
                        }
                    }
                    
                    req_put = urllib.request.Request(service_url, data=json.dumps(service_body).encode('utf-8'), headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json"
                    }, method="PUT")
                    with urllib.request.urlopen(req_put) as resp_cr:
                        cr_data = json.loads(resp_cr.read().decode('utf-8'))
                        live_url = cr_data.get("status", {}).get("url", "")
                        print(f"🎉 CLOUD RUN SUCCESSFULLY UPDATED TO {target_image}!")
                        print(f"🌐 Live URL: {live_url}")
                    return target_image

if __name__ == "__main__":
    main()
