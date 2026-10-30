// Téléchargement du .xlsx ImagePME depuis node9 (port adapté de src/download.js).
// node9 est stateless côté cookie : l'auth repose sur l'en-tête Referer qui porte le secHASH.
// Dans Electron (process principal / Node), on pose ce Referer librement — pas besoin de
// declarativeNetRequest. Plus simple et sans le bug d'ID de règle partagé de l'extension.
'use strict';

// `downloadUrl` : URL download_tva_excel paramétrée. `refererUrl` : URL node9 captée (secHASH).
async function downloadExcel(downloadUrl, refererUrl) {
  if (!refererUrl) {
    throw new Error('refererUrl (URL du requêteur node9) requise');
  }

  const response = await fetch(downloadUrl, {
    method: 'GET',
    headers: { Referer: refererUrl },
  });

  if (!response.ok) {
    // node9 renvoie 500 quand il n'a pas de données à ce niveau géo/secteur (pas qu'une erreur
    // serveur générique) ; on expose le statut pour que l'appelant puisse décider d'un repli.
    const erreur = new Error(`Téléchargement ImagePME: statut ${response.status}`);
    erreur.status = response.status;
    throw erreur;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    // Fichier vide = secret statistique (< 10 entreprises) ou requête rejetée.
    const erreur = new Error('Fichier vide (secret statistique < 10, ou requête rejetée)');
    erreur.code = 'FICHIER_VIDE';
    throw erreur;
  }
  return buffer;
}

module.exports = { downloadExcel };
