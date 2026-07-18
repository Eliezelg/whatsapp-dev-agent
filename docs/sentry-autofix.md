# Sentry autofix — source d'erreurs automatique

Quand une erreur de production remonte dans Sentry, l'agent la corrige tout
seul : fix, tests, commit, push — et te prévient sur WhatsApp.

```
Sentry (issue non résolue)
    ↓  poll toutes les 5 min (sentry-watch.timer)
scripts/sentry-watch.js
    ↓  POST /api/dispatch (canal API, autoConfirm)
Gemini → dispatcher (sécurité, rate limit, sessions) → Claude Code
    ↓
fix + tests + commit + push, résultat sur WhatsApp + transcript projet
```

Aucun nouveau service : `sentry-watch` réutilise le pipeline existant
(mêmes garde-fous que WhatsApp et l'app mobile) et le pattern des watchers
systemd (`security-audit.timer`).

## Configuration

Dans `/etc/whatsapp-agent.env` :

```env
SENTRY_TOKEN=sntrys_...        # User Auth Token (scopes org:read, project:read, event:read)
SENTRY_ORG=mon-org             # slug de l'organisation Sentry
SENTRY_PROJECTS=slug-sentry:projet-agent,slug2:projet2
# SENTRY_HOST=sentry.io        # optionnel (self-hosted)
```

`SENTRY_PROJECTS` mappe un slug de projet **Sentry** vers un nom de projet
**de l'agent** (clé de `projects.json`). Le chemin du projet doit exister sur
le serveur et être un repo git avec droit de push.

Ni restart de `whatsapp-agent` ni rechargement nécessaires : le timer relit
l'env à chaque tick. Installation des unités (déjà fait en prod) :

```bash
cp scripts/sentry-watch.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now sentry-watch.timer
```

## Anti-boucle et garde-fous

- Une issue Sentry = **une seule tentative** d'autofix (état dans
  `/var/lib/sentry-watch/handled.json`).
- Max 2 dispatchs par tick, 1 par projet, jamais si une exécution est déjà
  active sur le projet (`GET /api/status`).
- Les protections du dispatcher s'appliquent : rate limit global, patterns
  dangereux, validation de chemin.
- Consigne dans le prompt : si le fix n'est pas sûr → aucun commit, analyse
  écrite dans `AUTOFIX-REPORT-<shortId>.md` à la racine du projet.

## Suivi / debug

```bash
systemctl list-timers sentry-watch.timer
journalctl -u sentry-watch -n 50
cat /var/lib/sentry-watch/handled.json   # issues déjà traitées
```

Pour rejouer une issue : retirer son id de `handled.json` (et la remettre
*unresolved* dans Sentry si besoin).
