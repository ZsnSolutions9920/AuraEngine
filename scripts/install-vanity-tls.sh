#!/usr/bin/env bash
# scripts/install-vanity-tls.sh — Phase 4.6.b
#
# One-time VPS setup for vanity-domain TLS automation. Idempotent.
#
# What it does:
#   1. Creates /var/www/scaliyo/acme webroot for Let's Encrypt HTTP-01 challenges
#   2. Creates /etc/nginx/sites-enabled/vanity directory for generated server blocks
#   3. Installs the cron entry that runs poll-vanity-domains.sh every minute
#   4. Validates that /etc/scaliyo/scaliyo.env is in place with the required vars
#
# Run once after pulling a deploy that includes the scripts/ directory:
#   sudo /var/www/scaliyo/scripts/install-vanity-tls.sh
#
# To uninstall: remove the cron entry, the vanity dir, and the webroot.

set -euo pipefail

ACME_DIR="/var/www/scaliyo/acme"
VANITY_DIR="/etc/nginx/sites-enabled/vanity"
ENV_FILE="/etc/scaliyo/scaliyo.env"
CRON_FILE="/etc/cron.d/scaliyo-vanity-tls"
POLL_SCRIPT="/var/www/scaliyo/scripts/poll-vanity-domains.sh"
PROVISION_SCRIPT="/var/www/scaliyo/scripts/provision-vanity-domain.sh"

echo "── Phase 4.6.b vanity-TLS install ──────────────────────────────"

# ── Required tools ──
for cmd in certbot nginx curl jq flock openssl; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: ${cmd} not installed"
    if [[ "${cmd}" == "jq" ]]; then echo "  → sudo apt-get install -y jq"; fi
    exit 1
  fi
done

# ── ACME webroot ──
echo "→ creating ${ACME_DIR}"
sudo mkdir -p "${ACME_DIR}/.well-known/acme-challenge"
sudo chown -R www-data:www-data "${ACME_DIR}"
sudo chmod 755 "${ACME_DIR}"

# ── Vanity server-block dir ──
echo "→ creating ${VANITY_DIR}"
sudo mkdir -p "${VANITY_DIR}"

# ── Make scripts executable ──
echo "→ chmod +x scripts"
sudo chmod 755 "${POLL_SCRIPT}" "${PROVISION_SCRIPT}"

# ── Validate env file ──
if [[ ! -r "${ENV_FILE}" ]]; then
  echo ""
  echo "⚠  ${ENV_FILE} not present. Create it as root with mode 600:"
  echo ""
  echo "    sudo install -d -m 700 /etc/scaliyo"
  echo "    sudo tee ${ENV_FILE} > /dev/null <<'EOF'"
  echo "SUPABASE_URL=https://utvydxqiqedaaxmmpfpf.supabase.co"
  echo "SUPABASE_SERVICE_ROLE_KEY=<paste service-role JWT>"
  echo "LETSENCRYPT_EMAIL=<your-email>"
  echo "EOF"
  echo "    sudo chmod 600 ${ENV_FILE}"
  echo ""
  echo "Then re-run this install script."
  exit 1
fi

# Check perms — should not be world-readable.
PERM=$(stat -c '%a' "${ENV_FILE}")
if [[ "${PERM}" != "600" && "${PERM}" != "640" ]]; then
  echo "WARNING: ${ENV_FILE} has perms ${PERM}; recommend 600"
fi

# ── Cron entry ──
echo "→ installing cron entry at ${CRON_FILE}"
sudo tee "${CRON_FILE}" > /dev/null <<EOF
# Phase 4.6.b — poll workspace_domains for newly-verified rows and provision
# vanity TLS certs. Runs as administrator (NOPASSWD-allowed certbot + nginx
# commands per /etc/sudoers.d/scaliyo-certbot).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

* * * * * administrator ${POLL_SCRIPT} >> /var/log/scaliyo-vanity-tls.log 2>&1
EOF
sudo chmod 644 "${CRON_FILE}"

# Touch the log file so cron can write to it.
sudo touch /var/log/scaliyo-vanity-tls.log
sudo chown administrator:administrator /var/log/scaliyo-vanity-tls.log

# ── Reload Nginx so the updated aurafunnel.conf (with ACME catch-all and
#    vanity include) takes effect.
echo "→ validating + reloading nginx"
sudo /usr/bin/nginx -t
sudo /usr/bin/systemctl reload nginx

echo ""
echo "✓ Vanity-domain TLS automation installed."
echo "  • Webroot:        ${ACME_DIR}"
echo "  • Server blocks:  ${VANITY_DIR}"
echo "  • Cron:           ${CRON_FILE}"
echo "  • Log:            /var/log/scaliyo-vanity-tls.log"
echo ""
echo "To watch:  tail -f /var/log/scaliyo-vanity-tls.log"
