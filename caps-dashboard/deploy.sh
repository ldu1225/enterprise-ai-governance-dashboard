#!/usr/bin/env bash
# Deploy the customer governance console (caps-dashboard) to Cloud Run.
#
#   bash caps-dashboard/deploy.sh
#
# Settings (environment, else caps-dashboard/.env for the non-secret ones)
#   PROJECT_ID        default: duleetest
#   REGION            default: asia-northeast3 (same region as the Caps API)
#   SERVICE_NAME      default: caps-dashboard
#   CAPS_API_BASE_URL, HUB_PROJECT, SPOKE_PROJECTS
#
# Secrets go to Secret Manager and are mounted as env vars; nothing secret is printed or baked into the image:
#   caps-dashboard-api-key         CAPS_API_KEY (scoped Caps API key)          from $CAPS_API_KEY or .env
#   caps-dashboard-session-secret  DASHBOARD_SESSION_SECRET (>= 32 chars)      generated once if missing
#   caps-dashboard-admin-hash      DASHBOARD_ADMIN_PASSWORD_HASH (scrypt$...)  from .local_admin_hash (same password
#                                                                              as the local console)
# The service runs as a dedicated service account whose only permission is reading those three secrets:
# the console talks to the Caps REST API and never calls Google Cloud APIs itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"

dotenv() {  # dotenv KEY -> value from .env (parsed, never sourced)
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -1 | sed -e "s/^['\"]//" -e "s/['\"]$//"
}

PROJECT_ID="${PROJECT_ID:-duleetest}"
REGION="${REGION:-asia-northeast3}"
SERVICE_NAME="${SERVICE_NAME:-caps-dashboard}"
SA_ID="${SERVICE_NAME}-sa"
SA_EMAIL="${SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
CAPS_API_BASE_URL="${CAPS_API_BASE_URL:-$(dotenv CAPS_API_BASE_URL)}"
HUB_PROJECT="${HUB_PROJECT:-$(dotenv HUB_PROJECT)}"
SPOKE_PROJECTS="${SPOKE_PROJECTS:-$(dotenv SPOKE_PROJECTS)}"
CAPS_API_KEY="${CAPS_API_KEY:-$(dotenv CAPS_API_KEY)}"

: "${CAPS_API_BASE_URL:?CAPS_API_BASE_URL is required}"
: "${HUB_PROJECT:?HUB_PROJECT is required}"
G=(gcloud --project "$PROJECT_ID" --quiet)

log() { echo "==> $*" >&2; }

log "1/5 enable APIs"
"${G[@]}" services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com >&2

log "2/5 service account $SA_EMAIL"
"${G[@]}" iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 ||
  "${G[@]}" iam service-accounts create "$SA_ID" --display-name "Caps dashboard (Cloud Run)" >&2

put_secret() {  # put_secret NAME (value on stdin); adds a version only when the value changed
  local name="$1" value current
  value="$(cat)"
  if ! "${G[@]}" secrets describe "$name" >/dev/null 2>&1; then
    "${G[@]}" secrets create "$name" --replication-policy automatic >&2
  fi
  current="$("${G[@]}" secrets versions access latest --secret "$name" 2>/dev/null || true)"
  if [[ "$current" != "$value" ]]; then
    printf '%s' "$value" | "${G[@]}" secrets versions add "$name" --data-file=- >&2
  fi
  "${G[@]}" secrets add-iam-policy-binding "$name" --member "serviceAccount:$SA_EMAIL" \
    --role roles/secretmanager.secretAccessor >/dev/null
}

log "3/5 secrets"
[[ -n "$CAPS_API_KEY" ]] || { echo "CAPS_API_KEY is required (env or caps-dashboard/.env)" >&2; exit 1; }
printf '%s' "$CAPS_API_KEY" | put_secret caps-dashboard-api-key
if "${G[@]}" secrets versions access latest --secret caps-dashboard-session-secret >/dev/null 2>&1; then
  "${G[@]}" secrets versions access latest --secret caps-dashboard-session-secret | put_secret caps-dashboard-session-secret
else
  python3 -c 'import secrets; print(secrets.token_hex(32), end="")' | put_secret caps-dashboard-session-secret
fi
if [[ -n "${DASHBOARD_ADMIN_PASSWORD_HASH:-}" ]]; then
  printf '%s' "$DASHBOARD_ADMIN_PASSWORD_HASH" | put_secret caps-dashboard-admin-hash
elif [[ -f "$HERE/.local_admin_hash" ]]; then
  tr -d '\n' < "$HERE/.local_admin_hash" | put_secret caps-dashboard-admin-hash
else
  echo "Set DASHBOARD_ADMIN_PASSWORD_HASH (see README) or create the local admin password first." >&2; exit 1
fi

log "4/5 cloud run deploy $SERVICE_NAME ($REGION)"
"${G[@]}" run deploy "$SERVICE_NAME" --source "$HERE" --region "$REGION" \
  --service-account "$SA_EMAIL" --allow-unauthenticated \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 3 --concurrency 40 \
  --set-env-vars "^@^CAPS_API_BASE_URL=${CAPS_API_BASE_URL}@HUB_PROJECT=${HUB_PROJECT}@SPOKE_PROJECTS=${SPOKE_PROJECTS}" \
  --set-secrets "CAPS_API_KEY=caps-dashboard-api-key:latest,DASHBOARD_SESSION_SECRET=caps-dashboard-session-secret:latest,DASHBOARD_ADMIN_PASSWORD_HASH=caps-dashboard-admin-hash:latest" >&2

log "5/5 done"
"${G[@]}" run services describe "$SERVICE_NAME" --region "$REGION" --format 'value(status.url)'
