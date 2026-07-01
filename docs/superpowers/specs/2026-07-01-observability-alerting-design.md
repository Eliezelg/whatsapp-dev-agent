# Observabilité & alerting — whatsapp-agent

> **STATUT : IMPLÉMENTÉ le 2026-07-02.** Les 5 composants sont en production,
> avec les corrections issues de la revue (retry ENOENT propre via résultat
> structuré, détection d'erreur fiable, garde anti-faux-positif sur l'alerte
> déconnexion, timeout 5s + anti-rafale sur le filet anti-crash). Un pré-requis
> non prévu au spec initial a aussi été traité : la reconnexion concurrente
>  (garde de génération + anti-concurrence). Ce document reste la
> référence de conception ; l'implémentation réelle vit dans notify-email.js,
> runner.js, core/dispatcher.js et index.js.


## Contexte

Le 2026-07-01, une session de travail sur `whatsapp-agent` a révélé que la
connexion WhatsApp était morte depuis le 23 juin (identifiants `@lid` non
reconnus par la whitelist) — découvert par hasard, sans aucune trace dans les
logs (ni `message_received` ni `unauthorized_sender`, silence total). Ce
document couvre les correctifs pour ne plus dépendre du hasard pour détecter
ce genre de panne.

## Objectif

Détecter et notifier par email (canal indépendant de WhatsApp) trois classes
de pannes silencieuses, et absorber une quatrième classe de panne
(transitoire, spawn du binaire Claude Code) sans notification si un simple
retry suffit :
1. WhatsApp déconnecté durablement (Baileys ne parvient pas à se reconnecter)
2. Une tâche Claude Code échoue (erreur, timeout, kill) sans que l'échec soit
   visible autrement qu'en cherchant activement dans WhatsApp
3. Le process `whatsapp-agent` lui-même crash de façon inattendue (exception
   non catchée) pendant qu'une tâche est en cours
4. `spawn` du binaire `claude` échoue ponctuellement avec `ENOENT` malgré un
   chemin valide (observé le 2026-07-02, cause racine non identifiée avec
   certitude — voir Composant 5)

## Hors scope (décision explicite)

- **Pas de heartbeat externe** (ex: healthchecks.io) pour détecter une panne
  totale du VPS — accepté comme risque : le VPS héberge aussi Asterisk
  (téléphonie), une panne totale serait de toute façon visible autrement.
- **Pas de rapport quotidien** — alerting uniquement sur anomalie détectée,
  silence = tout va bien (avec le risque résiduel ci-dessus accepté).
- **Pas de webhook email inbound** — écarté dans une itération précédente
  (voir `docs/superpowers/plans/2026-07-01-orchestrateur-dispatcher-cheap-model.md`,
  contexte VPS : UFW/Caddy ne permettent pas d'exposer un webhook public sur
  ce VPS sans reconfiguration réseau plus large).

## Architecture

Extension de l'existant, aucun nouveau service. Un nouveau module
`notify-email.js` fournit une fonction unique `sendAlertEmail(subject, text)`
réutilisée par les 3 points de détection. Envoi sortant uniquement (API
Resend, pas de réception), donc pas de contrainte réseau/firewall (sortant
HTTPS déjà autorisé pour tout le trafic applicatif existant, comme Gemini et
l'API Anthropic).

```
connection.update (close) ──┐
runner.js / dispatcher.js   ├──► notify-email.js ──► Resend API ──► email
   (erreur d'exécution)     │      sendAlertEmail()
process uncaughtException ──┘
```

## Composant 1 : `notify-email.js`

Nouveau fichier, wrapper minimal autour du SDK Resend. **`resend` n'est pas
encore une dépendance de ce projet** (vérifié : absent de `package.json` et
`node_modules`) — à ajouter via `npm install resend` dans le plan
d'implémentation, avec la version pinnée au moment de l'exécution.

```js
import { Resend } from 'resend';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.RESEND_API_KEY) return null;
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
}

export async function sendAlertEmail(subject, text) {
  const resend = getClient();
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM;
  if (!resend || !to || !from) {
    console.warn('[alert-email] non configuré (RESEND_API_KEY/ALERT_EMAIL_TO/ALERT_EMAIL_FROM manquant) — alerte perdue:', subject);
    return false;
  }
  try {
    await resend.emails.send({ from, to, subject: `[whatsapp-agent] ${subject}`, text });
    return true;
  } catch (err) {
    console.error('[alert-email] échec envoi:', err.message);
    return false;
  }
}
```

Comportement dégradé explicite : si les variables d'env ne sont pas
configurées, l'alerte est journalisée en `console.warn` mais ne bloque jamais
le fonctionnement normal du bot — ce module est un filet de sécurité
best-effort, pas une dépendance critique.

**Nouvelles variables d'env** (`.env.example`, `/etc/whatsapp-agent.env`) :
- `RESEND_API_KEY` — même compte Resend que Familink (déjà utilisé)
- `ALERT_EMAIL_FROM` — ex: `alerts@familink.co.il` (même domaine déjà vérifié)
- `ALERT_EMAIL_TO` — adresse personnelle de l'utilisateur

## Composant 2 : alerte de déconnexion WhatsApp prolongée

Dans `index.js`, section `connection.update` :

- Sur `connection === 'close'` : si aucun timer de déconnexion n'est déjà
  actif, démarrer un `setTimeout` de 5 minutes qui, s'il se déclenche,
  envoie un email "déconnecté depuis 5min" puis se reprogramme toutes les
  30 min tant que la déconnexion persiste (pas de spam, mais rappel si ça
  traîne).
- Sur `connection === 'open'` : annuler tout timer actif, réinitialiser
  l'état. Si une déconnexion avait dépassé le seuil d'alerte, envoyer un
  email de reprise ("reconnecté après Xmin d'indisponibilité") pour confirmer
  que l'incident est clos sans que l'utilisateur ait à vérifier lui-même.

État géré par deux variables **module-level, déclarées en dehors de
`startBot()`** (`disconnectionAlertTimer`, `disconnectedSince`), symétriques
au pattern déjà existant pour `currentSock`. C'est important : `startBot()`
est rappelée récursivement à chaque `connection === 'close'` avec
reconnexion (comportement actuel inchangé), donc `sock.ev.on('connection.update', ...)`
est ré-enregistré à chaque cycle — si l'état du timer était déclaré à
l'intérieur de `startBot()`, il serait perdu à chaque tentative de
reconnexion et l'alerte ne se déclencherait jamais correctement.

## Composant 3 : duplication des erreurs Claude Code vers email

Dans `core/dispatcher.js`, fonction `executeConfirmed()` :

- Sur le `catch (err)` existant (échec de `runClaude` — exception, pas juste
  un mauvais exit code) : en plus du `channel.send` existant, appeler
  `sendAlertEmail('Exécution échouée sur <projet>', ...)`.
- Sur le résultat retourné par `runClaude` (pas d'exception, mais
  `formatResult()` dans `runner.js` peut préfixer `⛔`/`⚠️` en cas de kill
  par timeout/idle/output-limit) : si le résultat commence par un de ces
  préfixes, dupliquer vers email aussi.
- Succès (`✅ Terminé`) : WhatsApp uniquement, pas de duplication — pas de
  bruit sur le chemin nominal.

Le dispatcher reste canal-agnostique (pas de dépendance directe à
`sendAlertEmail` codée en dur) : `sendAlertEmail` est injecté comme
dépendance optionnelle dans `createDispatcher({ ..., alertEmail })`, cohérent
avec le pattern d'injection de dépendances déjà en place pour
`runClaude`/`validateProjectPath`/etc. Si `alertEmail` n'est pas fourni
(ex: dans les tests), le comportement de duplication est simplement ignoré.

## Composant 4 : filet anti-crash process

Dans `index.js`, avant les handlers `SIGTERM`/`SIGINT` existants :

```js
process.on('uncaughtException', (err) => {
  audit('uncaught_exception', { error: err.message, stack: err.stack });
  sendAlertEmail('Crash inattendu', `whatsapp-agent a planté :\n\n${err.stack}`)
    .finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  audit('unhandled_rejection', { reason: String(reason) });
  sendAlertEmail('Promise rejetée non gérée', String(reason))
    .finally(() => process.exit(1));
});
```

Best-effort : l'envoi email a une fenêtre de temps limitée avant que le
process ne parte de toute façon (systemd `Restart=always` le relance). Pas de
garantie de livraison, mais capture largement plus de cas que le
comportement actuel (crash silencieux, aucune trace avant le prochain accès
SSH manuel aux logs).

## Composant 5 : retry sur `ENOENT` transitoire au spawn de Claude Code

Incident observé le 2026-07-02 : `spawn /usr/bin/claude ENOENT` a fait
échouer une exécution alors que le binaire était accessible et exécutable
juste avant et juste après (vérifié manuellement : `which claude`, exécution
directe, et inspection du namespace mount du process via `nsenter` — tout
résolvait correctement). `CLAUDE_BIN` est fixé en dur via la variable d'env
(`/etc/whatsapp-agent.env`), donc pas un problème de résolution dynamique.
Cause racine non identifiée avec certitude (hypothèse : glitch I/O
transitoire, possiblement lié à `ProtectSystem=strict` qui rend `/usr` en
lecture seule via bind-mount — non confirmé). Plutôt que de creuser
davantage un incident non reproductible, on absorbe la classe d'erreur par
un retry ciblé.

Dans `runner.js`, fonction `runClaude()` : sur l'événement `proc.on('error', ...)`
avec `err.code === 'ENOENT'` spécifiquement (pas les autres codes d'erreur
spawn, pour ne pas masquer de vrais problèmes de configuration), retry une
seule fois après un court délai (ex: 2s) avant d'abandonner et de renvoyer
l'erreur normalement. Si le retry échoue aussi, le comportement actuel
s'applique (message d'erreur WhatsApp + duplication email via Composant 3,
puisque ce n'est alors probablement plus transitoire).

```js
// runner.js — modification du callback proc.on('error', ...)
// à l'intérieur de runClaude(), avec un paramètre interne _isRetry
proc.on('error', (err) => {
  if (err.code === 'ENOENT' && !_isRetry) {
    setTimeout(() => {
      runClaude(prompt, projectPath, onUpdate, /* _isRetry */ true).then(resolveOuter);
    }, 2000);
    return;
  }
  finish(`❌ Erreur process Claude Code : ${err.message}`);
});
```

Note : signature exacte et gestion de l'état (`_isRetry`) à préciser dans le
plan d'implémentation — l'idée est un retry unique borné, pas une boucle
infinie, sans changer le contrat public de `runClaude(prompt, projectPath, onUpdate)`
vu de l'extérieur (le paramètre de retry reste interne).

## Tests

- `notify-email.js` : test avec un client Resend mocké (comme pattern
  `channels/email.js` de l'itération précédente, injection de dépendance) —
  vérifie l'appel correct, le comportement dégradé si env manquant, et que
  les erreurs Resend ne remontent jamais en exception (best-effort).
- `core/dispatcher.js` : étendre `dispatcher.test.js` — vérifier que
  `alertEmail` est appelé sur erreur/kill mais jamais sur succès.
- Composants 2 et 4 (connection.update, process handlers) : logique
  difficilement unit-testable proprement (dépend de timers réels et
  d'événements process) — vérification manuelle documentée dans le plan
  d'implémentation plutôt que test automatisé, cohérent avec le traitement
  déjà réservé à `connection.update` existant (non testé aujourd'hui non
  plus).
- `runner.js` (Composant 5) : test avec un `spawn` mocké qui émet une erreur
  `ENOENT` sur le premier appel puis réussit sur le second — vérifie qu'un
  seul retry a lieu (pas de boucle) et que le résultat final est celui du
  retry réussi. Test complémentaire : deux échecs `ENOENT` consécutifs →
  l'erreur remonte normalement après le retry unique (pas de 3e tentative).

## Risques résiduels acceptés

- Si Resend lui-même est down au moment de l'incident, l'alerte est perdue
  silencieusement (loggée en `console.error` uniquement, visible seulement
  via `journalctl`/SSH).
- Le filet anti-crash (composant 4) a une fenêtre de course : si le crash
  empêche l'event loop de traiter la promesse `sendAlertEmail`, l'email ne
  part pas. Non garanti, documenté comme best-effort dans le code.
- Pas de heartbeat pour le cas "VPS totalement down" (décision explicite,
  voir Hors scope).
