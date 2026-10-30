// Client des 2 endpoints copilotage (contrat figé le 2026-10-27).
//   GET  {BASE}/imagepme/job?token=<OTT>  → détails du job + uploadToken + items
//   POST {BASE}/imagepme/upload           → dépôt d'un .xlsx (base64) avec Bearer uploadToken
// Le domaine vient de COPILOTAGE_BASE_URL (placeholder tant que le domaine réel n'est pas fixé).
'use strict';

const ROUTES = Object.freeze({
  job: '/imagepme/job',
  upload: '/imagepme/upload',
  complete: '/imagepme/complete', // retour d'état de fin de job (résumé + détail par item)
});

// Plafond serveur : fichier décodé ≤ 15 Mo (JSON ≤ 25 Mo). On garde-fou côté client.
const MAX_FICHIER_OCTETS = 15 * 1024 * 1024;

// Domaine copilotage par défaut (prod). L'app packagée n'a pas d'env ; on bake la prod ici et on
// laisse COPILOTAGE_BASE_URL l'override en dev (ex. http://127.0.0.1:3000).
const DEFAULT_BASE_URL = 'https://app.label-co-pilotes.com';

function baseUrl() {
  const url = process.env.COPILOTAGE_BASE_URL || DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

async function lireJson(reponse) {
  return reponse.json().catch(() => null);
}

// Échange l'OTT contre le contexte du job.
async function fetchJob(ott) {
  if (!ott) {
    throw new Error('OTT (token de job) requis');
  }
  const url = `${baseUrl()}${ROUTES.job}?token=${encodeURIComponent(ott)}`;
  const reponse = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const corps = await lireJson(reponse);
  if (!reponse.ok || !corps || corps.error) {
    throw new Error(`JOB refusé: ${(corps && corps.error) || reponse.status}`);
  }
  if (!Array.isArray(corps.items) || !corps.uploadToken) {
    throw new Error('Réponse JOB invalide (items/uploadToken manquants)');
  }
  return corps;
}

// Dépose un fichier. `meta` = l'enveloppe du contrat (sans fichierBase64) ; `buffer` = le .xlsx.
async function uploadFichier(uploadToken, meta, buffer) {
  if (!uploadToken) {
    throw new Error('uploadToken requis');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('buffer fichier vide');
  }
  if (buffer.length > MAX_FICHIER_OCTETS) {
    throw new Error(`fichier trop volumineux (${buffer.length} o > ${MAX_FICHIER_OCTETS} o)`);
  }
  const body = JSON.stringify({ ...meta, fichierBase64: buffer.toString('base64') });
  const reponse = await fetch(`${baseUrl()}${ROUTES.upload}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${uploadToken}`,
    },
    body,
  });
  const corps = await lireJson(reponse);
  if (!reponse.ok || (corps && corps.error)) {
    throw new Error(`UPLOAD refusé: ${(corps && corps.error) || reponse.status}`);
  }
  return corps; // { fichierId, ... }
}

// Signale au copilotage la fin du job : résumé + statut par item (depose/en_attente/indisponible/
// echec). Même auth que l'upload (Bearer uploadToken, lié à {espace,entrepriseId}). Non bloquant
// côté app : un échec ici ne doit pas invalider les fichiers déjà déposés.
async function signalerStatutJob(uploadToken, rapport) {
  if (!uploadToken) {
    throw new Error('uploadToken requis');
  }
  if (!rapport || typeof rapport !== 'object') {
    throw new Error('rapport de statut requis');
  }
  const reponse = await fetch(`${baseUrl()}${ROUTES.complete}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${uploadToken}`,
    },
    body: JSON.stringify(rapport),
  });
  const corps = await lireJson(reponse);
  if (!reponse.ok || (corps && corps.error)) {
    throw new Error(`STATUT refusé: ${(corps && corps.error) || reponse.status}`);
  }
  return corps;
}

module.exports = { fetchJob, uploadFichier, signalerStatutJob, ROUTES };
