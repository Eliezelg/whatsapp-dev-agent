/**
 * Route API interne pour un futur client (app Android v2). Auth par token
 * statique simple (Bearer), symétrique au NOTIFY_TOKEN déjà utilisé pour
 * /notify dans notify-server.js. Non branché en production par ce plan —
 * squelette prêt à l'emploi pour quand un client existera réellement.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} rawBody - JSON: { message: string, senderId: string }
 * @param {{apiToken: string, dispatcher: {handleMessage: Function}, channel: {name: string, send: Function}}} opts
 */
export async function handleApiDispatch(req, res, rawBody, { apiToken, dispatcher, channel }) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${apiToken}`) {
    res.writeHead(401).end('unauthorized');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400).end('invalid json');
    return;
  }

  const { message, senderId } = payload;
  if (!message || !senderId) {
    res.writeHead(400).end('message et senderId requis');
    return;
  }

  await dispatcher.handleMessage(channel, senderId, message);
  res.writeHead(200).end('ok');
}
