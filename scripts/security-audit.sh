#!/bin/bash
# Audit sécurité automatique du VPS via Claude Code CLI.
# Lance le prompt d'audit (light ou full), capture la sortie, l'envoie sur WhatsApp.
#
# Usage : security-audit.sh [light|full]
# Lancé par systemd timers : security-audit-light.timer + security-audit-full.timer.
#
# IMPORTANT : Ce script doit être lancé par root pour avoir accès aux logs système
# (journalctl, fail2ban-client, apt list) ET pour pouvoir appliquer les fixes triviaux.

set -euo pipefail

MODE="${1:-light}"
LOG_DIR=/var/log/security-audit
PROMPT_LIGHT=/usr/local/share/security-audit/prompt-light.txt
PROMPT_FULL=/usr/local/share/security-audit/prompt-full.txt
WORKDIR=/var/lib/security-audit

mkdir -p "$LOG_DIR" "$WORKDIR"
chmod 700 "$LOG_DIR" "$WORKDIR"

DATE=$(date +%Y-%m-%d_%H%M%S)
LOG_FILE="$LOG_DIR/audit-$MODE-$DATE.md"

case "$MODE" in
  light)
    # Skip light le dimanche (le full prendra le relais à la même heure)
    if [ "$(date +%u)" = "7" ]; then
      echo "[$(date)] Dimanche → light skipped (full prendra le relais)"
      exit 0
    fi
    PROMPT_FILE="$PROMPT_LIGHT"
    ;;
  full)  PROMPT_FILE="$PROMPT_FULL" ;;
  *) echo "Usage: $0 [light|full]" >&2 ; exit 1 ;;
esac

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: prompt file $PROMPT_FILE missing" >&2
  exit 1
fi

# Sourcer NOTIFY_TOKEN depuis /etc/whatsapp-agent.env
if [ -f /etc/whatsapp-agent.env ]; then
  set -a
  source /etc/whatsapp-agent.env
  set +a
fi

if [ -z "${NOTIFY_TOKEN:-}" ]; then
  echo "WARNING: NOTIFY_TOKEN absent, le rapport sera juste loggé sans WhatsApp" >&2
fi

# === Lancement Claude Code ===
# On utilise le compte Claude Max via /root/.claude (déjà authentifié par setup-token).
# --print pour mode non-interactif, --dangerously-skip-permissions pour permettre
# les commandes système nécessaires à l'audit.
echo "[$(date)] Démarrage audit $MODE" | tee -a "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Claude Code lit le prompt depuis stdin
# Timeout 30 min pour éviter blocage cron
REPORT=$(timeout 1800 claude \
  --print \
  --dangerously-skip-permissions \
  < "$PROMPT_FILE" 2>&1 || echo "❌ Claude Code timeout/erreur")

echo "$REPORT" >> "$LOG_FILE"

# === Envoi WhatsApp via /notify ===
if [ -n "${NOTIFY_TOKEN:-}" ]; then
  # Tronquer à 4000 chars (limite WhatsApp safe)
  REPORT_TRUNC=$(printf '%s' "$REPORT" | head -c 4000)

  # JSON-escape via jq
  PAYLOAD=$(jq -n --arg text "$REPORT_TRUNC" '{text: $text}')

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST http://127.0.0.1:5111/notify \
    -H "Authorization: Bearer $NOTIFY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --max-time 30 || echo "000")

  echo "[$(date)] WhatsApp notify HTTP $HTTP_CODE" >> "$LOG_FILE"

  if [ "$HTTP_CODE" != "200" ]; then
    echo "WARNING: WhatsApp notify failed (HTTP $HTTP_CODE)" >&2
    exit 2
  fi
fi

# Rotation : garder 30 derniers fichiers par mode
ls -1t "$LOG_DIR/audit-$MODE-"*.md 2>/dev/null | tail -n +31 | xargs -r rm -f

echo "[$(date)] Audit $MODE terminé : $LOG_FILE"
