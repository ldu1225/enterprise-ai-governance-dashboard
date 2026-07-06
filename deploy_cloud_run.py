import urllib.request
import json
import subprocess
import os
import sys

# Get GCP Auth Token via google.auth (admin@dulee.altostrat.com)
def get_auth_token():
    try:
        import google.auth
        import google.auth.transport.requests
        creds, proj = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
        creds.refresh(google.auth.transport.requests.Request())
        return creds.token
    except Exception as e:
        print("Error getting OAuth token:", e)
        return None

token = get_auth_token()
print("OAuth Token Acquired:", bool(token))

if token:
    print("Project ID: duleetest")
    # Verify Cloud Run API Status via REST
    url = "https://run.googleapis.com/v1/namespaces/duleetest/services"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print("Cloud Run Services List Success!")
            print("Existing Services Count:", len(data.get("items", [])))
    except Exception as err:
        print("Cloud Run REST API status:", err)
