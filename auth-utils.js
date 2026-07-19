/**
 * Comparaison de token en temps constant — évite qu'un attaquant réseau
 * puisse déduire le token octet par octet via une timing attack sur les
 * comparaisons `!==` classiques (surtout pertinent pour les routes /api/*
 * et /notify, atteignables depuis le tailnet Tailscale, pas seulement en
 * local).
 */
import { timingSafeEqual } from 'crypto';

export function safeTokenEqual(received, expected) {
  const a = Buffer.from(received || '', 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  // timingSafeEqual exige des buffers de même longueur — une longueur
  // différente signifie déjà "pas égal", pas besoin de comparaison constante
  // pour cette étape (la longueur d'un token Bearer n'est pas un secret
  // exploitable au même titre que son contenu).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
