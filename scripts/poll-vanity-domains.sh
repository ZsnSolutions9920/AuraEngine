#!/usr/bin/env bash
# scripts/poll-vanity-domains.sh — Phase 4.6.b
#
# Reads workspace_domains rows where status='verified' AND provisioned_at IS NULL,
# calls provision-vanity-domain.sh for each, then writes back via the
# mark_domain_provisioned / mark_domain_provision_failed RPCs.
#
# Designed for `cron` (every minute) or a systemd timer. Single-shot — exits
# after one sweep. Output goes to stdout/stderr; cron emails on non-zero exit.
#
# Required env (loaded from /etc/scaliyo/scaliyo.env, mode 600):
#   SUPABASE_URL              — https://<project>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (NOT the anon key)
#   LETSENCRYPT_EMAIL         — registration email for cert issuance

set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/scaliyo/scaliyo.env}"
PROVISION_SCRIPT="${PROVISION_SCRIPT:-/var/www/scaliyo/scripts/provision-vanity-domain.sh}"
LOCK_FILE="/run/scaliyo/poll-vanity-domains.lock"
MAX_PER_TICK=5

if [[ ! -r "${ENV_FILE}" ]]; then
  echo "[poll] ENV file ${ENV_FILE} missing — exiting" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "${ENV_FILE}"

if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "[poll] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set" >&2
  exit 1
fi

# ── Single-instance lock so a slow tick can't overlap with the next ──
mkdir -p "$(dirname "${LOCK_FILE}")" 2>/dev/null || true
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "[poll] another instance running — exiting"
  exit 0
fi

REST="${SUPABASE_URL}/rest/v1"
HEADERS=(
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}"
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
)

# ── Fetch up to MAX_PER_TICK domains needing provisioning ──
QUERY="select=id,domain&status=eq.verified&provisioned_at=is.null&order=created_at.asc&limit=${MAX_PER_TICK}"
ROWS=$(curl -sS --fail "${HEADERS[@]}" "${REST}/workspace_domains?${QUERY}")

# Empty array → nothing to do.
if [[ "${ROWS}" == "[]" || -z "${ROWS}" ]]; then
  exit 0
fi

# Iterate via jq.
echo "${ROWS}" | jq -c '.[]' | while read -r ROW; do
  ID=$(echo "${ROW}" | jq -r .id)
  DOMAIN=$(echo "${ROW}" | jq -r .domain)
  echo "[poll] provisioning ${DOMAIN} (id=${ID})"

  # Capture stdout + stderr from provisioner; we'll record either the
  # CERT_EXPIRES_AT line or the error.
  if OUT=$("${PROVISION_SCRIPT}" "${DOMAIN}" 2>&1); then
    EXPIRES=$(echo "${OUT}" | sed -n 's/^CERT_EXPIRES_AT=//p')
    if [[ -z "${EXPIRES}" ]]; then
      EXPIRES_ISO=null
    else
      # Convert "May 10 12:34:56 2027 GMT" → ISO 8601.
      EXPIRES_ISO=$(date -u -d "${EXPIRES}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
      [[ -z "${EXPIRES_ISO}" ]] && EXPIRES_ISO=null
      [[ "${EXPIRES_ISO}" != "null" ]] && EXPIRES_ISO="\"${EXPIRES_ISO}\""
    fi

    curl -sS --fail "${HEADERS[@]}" \
      -H "Content-Type: application/json" \
      -X POST "${REST}/rpc/mark_domain_provisioned" \
      -d "{\"p_domain_id\":\"${ID}\",\"p_cert_expires_at\":${EXPIRES_ISO}}" >/dev/null
    echo "[poll] OK ${DOMAIN}"
  else
    ERR=$(echo "${OUT}" | tail -1 | jq -Rs '.')
    curl -sS --fail "${HEADERS[@]}" \
      -H "Content-Type: application/json" \
      -X POST "${REST}/rpc/mark_domain_provision_failed" \
      -d "{\"p_domain_id\":\"${ID}\",\"p_error\":${ERR}}" >/dev/null
    echo "[poll] FAILED ${DOMAIN}: ${OUT}" >&2
  fi
done
