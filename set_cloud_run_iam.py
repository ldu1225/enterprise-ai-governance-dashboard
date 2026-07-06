import urllib.request
import json
import google.auth
import google.auth.transport.requests

creds, project_id = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
creds.refresh(google.auth.transport.requests.Request())
token = creds.token

region = "us-central1"
service_name = "lges-ai-governance-dashboard"
url = f"https://{region}-run.googleapis.com/v1/projects/{project_id}/locations/{region}/services/{service_name}:setIamPolicy"

iam_body = {
    "policy": {
        "bindings": [
            {
                "role": "roles/run.invoker",
                "members": ["allUsers"]
            }
        ]
    }
}

req = urllib.request.Request(url, data=json.dumps(iam_body).encode('utf-8'), headers={
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json"
})

try:
    with urllib.request.urlopen(req) as resp:
        print("🎉 Successfully set IAM Policy (allUsers Invoker) for Cloud Run Service!")
except Exception as e:
    print("IAM Policy Setting Info:", e)
