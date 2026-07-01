import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedSender } from '../security.js';

const OWNER_JID = '33614330440@s.whatsapp.net';
const OWNER_LID = '54246108078131@lid';

test('isAuthorizedSender: accepte le JID owner classique @s.whatsapp.net', () => {
  assert.equal(isAuthorizedSender(OWNER_JID, OWNER_JID), true);
});

test('isAuthorizedSender: accepte le JID owner avec suffixe device (:8)', () => {
  assert.equal(isAuthorizedSender('33614330440:8@s.whatsapp.net', OWNER_JID), true);
});

test('isAuthorizedSender: refuse un JID @s.whatsapp.net différent', () => {
  assert.equal(isAuthorizedSender('33699999999@s.whatsapp.net', OWNER_JID), false);
});

test('isAuthorizedSender: refuse les groupes (@g.us) même si owner', () => {
  assert.equal(isAuthorizedSender('120363151081854356@g.us', OWNER_JID), false);
});

test('isAuthorizedSender: refuse status@broadcast', () => {
  assert.equal(isAuthorizedSender('status@broadcast', OWNER_JID), false);
});

test('isAuthorizedSender: accepte le LID owner explicite quand ownerLid est fourni', () => {
  assert.equal(isAuthorizedSender(OWNER_LID, OWNER_JID, OWNER_LID), true);
});

test('isAuthorizedSender: refuse un LID différent même si ownerLid est fourni', () => {
  assert.equal(isAuthorizedSender('99999999999@lid', OWNER_JID, OWNER_LID), false);
});

test('isAuthorizedSender: refuse tout LID si ownerLid n\'est pas configuré', () => {
  assert.equal(isAuthorizedSender(OWNER_LID, OWNER_JID), false);
  assert.equal(isAuthorizedSender(OWNER_LID, OWNER_JID, undefined), false);
  assert.equal(isAuthorizedSender(OWNER_LID, OWNER_JID, ''), false);
});

test('isAuthorizedSender: refuse un JID vide ou owner non configuré', () => {
  assert.equal(isAuthorizedSender('', OWNER_JID), false);
  assert.equal(isAuthorizedSender(OWNER_JID, ''), false);
});
