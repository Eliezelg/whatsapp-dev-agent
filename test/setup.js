/**
 * Environnement minimal des tests, precharge via `node --test --import`.
 *
 * security.js valide ALLOWED_PROJECT_ROOTS a l'import et leve si la variable
 * est absente : pas de defaut permissif sur une racine de chemins, c'est
 * volontaire. En prod la valeur vient de /etc/whatsapp-agent.env (systemd),
 * mais les tests n'ont ni ce fichier ni .env (gitignore) — tout test qui
 * importait security.js, directement ou via agent.js / runner.js, crashait
 * donc avant son premier assert.
 *
 * On injecte ici des racines de test explicites plutot que d'assouplir le
 * garde ou de dependre d'un .env non versionne : le harnais doit reproduire
 * l'environnement de prod, pas le code s'adapter au harnais.
 *
 * Seule cette variable est necessaire : c'est la seule lue au chargement d'un
 * module. Le reste de la configuration est injecte par les tests eux-memes.
 * Les valeurs ne sont volontairement pas celles de la prod — un test ne doit
 * jamais dependre de l'arborescence reelle du VPS.
 */
process.env.ALLOWED_PROJECT_ROOTS ??= '/workspaces,/opt/projects';
