import urllib.request
import json
import sys

endpoints = [
    ("/api/projects", "GCP Projects List"),
    ("/api/metrics/summary?days=30", "Summary Metrics"),
    ("/api/metrics/usage-timeline?days=30", "LLM Model Usage Timeline"),
    ("/api/metrics/agent-creation-timeline?days=30", "Agent Creation Timeline"),
    ("/api/metrics/agent-creators-ranking?days=30", "Agent Creators Ranking"),
    ("/api/metrics/agent-usage-daily?days=30", "Daily Agent Usage"),
    ("/api/metrics/zombie-agents", "Zombie Agents List"),
    ("/api/metrics/cost-spikes?days=30", "GCP Billing Cost Spikes"),
    ("/api/metrics/heavy-users?days=30", "Top Heavy Users"),
    ("/api/metrics/file-uploads?days=30", "User File Uploads Audit"),
    ("/api/metrics/model-armor?days=30", "Model Armor Block Logs"),
    ("/api/lifecycle/agents?days=30", "All Lifecycle Agents Registry")
]

print("==========================================================================")
print("🔍 LGES Dashboard 12개 REST API 엔드포인트 100% 전수 검수 시작")
print("==========================================================================\n")

failed_count = 0
for path, desc in endpoints:
    url = f"http://localhost:8088{path}"
    try:
        req = urllib.request.urlopen(url, timeout=10)
        status = req.status
        body = req.read().decode('utf-8')
        data = json.loads(body)
        
        is_empty = False
        if isinstance(data, list) and len(data) == 0:
            is_empty = True
        elif isinstance(data, dict):
            if not data:
                is_empty = True
            elif "timeline" in data and len(data["timeline"]) == 0:
                is_empty = True
            elif "skuBreakdown" in data and len(data.get("skuBreakdown", [])) == 0 and len(data.get("topSkus", [])) == 0:
                is_empty = True
                
        status_str = "⚠️ EMPTY DATA" if is_empty else "✅ OK"
        print(f"[{status_str}] {desc:<35} | Path: {path}")
        if is_empty:
            print(f"   ↳ Response Data: {data}\n")
    except Exception as e:
        print(f"[❌ ERROR] {desc:<35} | Path: {path} | Exception: {e}\n")
        failed_count += 1

print("\n==========================================================================")
print(f"전수 점검 완료: 총 {len(endpoints)}개 중 {failed_count}개 실패")
print("==========================================================================")
