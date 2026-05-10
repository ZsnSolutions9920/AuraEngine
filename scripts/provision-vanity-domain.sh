#!/usr/bin/env bash
# scripts/provision-vanity-domain.sh — Phase 4.6.b
#
# Issues a Let's Encrypt cert for a customer's vanity domain via HTTP-01
# challenge, drops a generated Nginx server block, and reloads Nginx.
# Idempotent: re-running for the same domain re-issues nothing if the
# cert + server block are already in place.
#
# Usage:
#   sudo provision-vanity-domain.sh <domain>
# Exit codes:
#   0  OK
#   1  Bad input
#   2  ACME webroot missing (run install-vanity-tls.sh first)
#   3  Cert issuance failed
#   4  Nginx config validation failed
#   5  Nginx reload failed

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${LETSENCRYPT_EMAIL:-admin@scaliyo.com}"
WEBROOT="/var/www/scaliyo/acme"
ENABLED_DIR="/etc/nginx/sites-enabled/vanity"
CONF_FILE="${ENABLED_DIR}/${DOMAIN}.conf"
TEMPLATE="${VANITY_TEMPLATE:-/var/www/scaliyo/scripts/vanity-server-block.conf.tmpl}"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"

# ── Validate input ──
if [[ -z "${DOMAIN}" ]]; then
  echo "usage: $0 <domain>" >&2
  exit 1
fi
# Basic FQDN regex — defense against shell injection via command line.
if ! [[ "${DOMAIN}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "ERROR: invalid domain syntax: ${DOMAIN}" >&2
  exit 1
fi

if [[ ! -d "${WEBROOT}" ]]; then
  echo "ERROR: ACME webroot ${WEBROOT} missing — run install-vanity-tls.sh first" >&2
  exit 2
fi
if [[ ! -f "${TEMPLATE}" ]]; then
  echo "ERROR: server-block template not found at ${TEMPLATE}" >&2
  exit 2
fi

# ── Issue cert (idempotent: certbot is a no-op if cert exists and is valid) ──
echo "[provision] Issuing/renewing cert for ${DOMAIN}"
if ! sudo /usr/bin/certbot certonly \
    --webroot -w "${WEBROOT}" \
    -d "${DOMAIN}" \
    --non-interactive --agree-tos -m "${EMAIL}" \
    --keep-until-expiring; then
  echo "ERROR: certbot failed for ${DOMAIN}" >&2
  exit 3
fi

if [[ ! -f "${LIVE_DIR}/fullchain.pem" ]]; then
  echo "ERROR: cert not present at ${LIVE_DIR} after certbot run" >&2
  exit 3
fi

# ── Write Nginx server block ──
echo "[provision] Writing ${CONF_FILE}"
mkdir -p "${ENABLED_DIR}"
TMP="$(mktemp)"
sed "s|{{DOMAIN}}|${DOMAIN}|g" "${TEMPLATE}" > "${TMP}"
sudo install -m 644 "${TMP}" "${CONF_FILE}"
rm -f "${TMP}"

# ── Validate + reload ──
if ! sudo /usr/bin/nginx -t; then
  echo "ERROR: nginx -t failed; rolling back ${CONF_FILE}" >&2
  sudo rm -f "${CONF_FILE}"
  exit 4
fi

if ! sudo /usr/bin/systemctl reload nginx; then
  echo "ERROR: nginx reload failed" >&2
  exit 5
fi

# ── Print cert expiry for the caller (poller parses this) ──
EXPIRES=$(sudo openssl x509 -enddate -noout -in "${LIVE_DIR}/fullchain.pem" | cut -d= -f2)
echo "[provision] OK: ${DOMAIN}"
echo "CERT_EXPIRES_AT=${EXPIRES}"
