import urllib.request
import json
import base64
import tarfile
import io
import os
import google.auth
import google.auth.transport.requests

def build_and_deploy():
    print("=== Building & Deploying REAL LGES Dashboard to Cloud Run ===")
    creds, project_id = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    creds.refresh(google.auth.transport.requests.Request())
    token = creds.token
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # 1. Create Tar archive of source code
    print("📦 Archiving source code...")
    tar_stream = io.BytesIO()
    with tarfile.open(fileobj=tar_stream, mode="w:gz") as tar:
        for root, dirs, files in os.walk("."):
            if ".git" in root or "node_modules" in root or "__pycache__" in root:
                continue
            for file in files:
                filepath = os.path.join(root, file)
                tar.add(filepath, arcname=os.path.relpath(filepath, "."))
    
    tar_bytes = tar_stream.getvalue()
    print(f"📦 Source archive created ({len(tar_bytes)} bytes)")

    # 2. Get Cloud Build Storage Bucket Location via REST API
    bucket_url = f"https://cloudbuild.googleapis.com/v1/projects/{project_id}/builds"
    
    # 3. Create Cloud Build using Dockerfile in repository
    # Convert source tar to Google Storage Upload Location or Cloud Storage API
    storage_location_url = f"https://storage.googleapis.com/storage/v1/b/{project_id}_cloudbuild/o?uploadType=media&name=source_{int(os.time() if hasattr(os, 'time') else 12345)}.tgz"
    
    print("🚀 Triggering Cloud Build API directly...")

if __name__ == "__main__":
    build_and_deploy()
