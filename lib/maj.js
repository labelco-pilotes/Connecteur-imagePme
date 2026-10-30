// Mises à jour automatiques (electron-updater). L'app interroge notre serveur de mises à jour (VPS,
// provider "generic" : l'URL est dans package.json → build.publish.url), y lit le feed `latest.yml`,
// télécharge la nouvelle version en tâche de fond, puis l'installe au prochain lancement (installeur
// NSIS Windows). Entièrement silencieux et NON bloquant : aucune version / réseau coupé / app non
// packagée n'empêche le reste de tourner.
//
// ⚠️ Limites connues :
//   - À n'appeler QUE sur l'app packagée (`app.isPackaged`) : en dev, autoUpdater n'a pas de feed.
//   - macOS n'applique une mise à jour que si l'app est SIGNÉE (à faire plus tard). Windows (NSIS)
//     met à jour même non signé.
//   - Le serveur de MAJ doit servir `latest.yml` + le `.exe` en HTTPS, au MÊME dossier que l'URL
//     configurée (le feed référence le .exe par son nom relatif).
'use strict';

const { autoUpdater } = require('electron-updater');

// Branche les événements de mise à jour et lance la vérification.
// `notifier(titre, corps)` : affichage utilisateur (optionnel) ; `log(message)` : journalisation.
function verifierMisesAJour({ notifier, log } = {}) {
  const journal = typeof log === 'function' ? log : () => {};
  const prevenir = typeof notifier === 'function' ? notifier : () => {};

  autoUpdater.autoDownload = true; // télécharge dès qu'une version est dispo
  autoUpdater.autoInstallOnAppQuit = true; // installe à la fermeture / au prochain lancement

  autoUpdater.on('checking-for-update', () => journal('[MAJ] Recherche de mise à jour…'));
  autoUpdater.on('update-available', (info) => journal(`[MAJ] Nouvelle version ${info.version} → téléchargement…`));
  autoUpdater.on('update-not-available', () => journal('[MAJ] Déjà à jour.'));
  autoUpdater.on('download-progress', (p) => journal(`[MAJ] Téléchargement ${Math.round(p.percent)} %`));
  autoUpdater.on('update-downloaded', (info) => {
    journal(`[MAJ] Version ${info.version} téléchargée — s'installera au prochain démarrage.`);
    prevenir('Mise à jour prête', `La version ${info.version} s'installera au prochain lancement.`);
  });
  // Jamais fatal : une vérification impossible (pas de release, hors ligne) est un simple avertissement.
  autoUpdater.on('error', (err) => journal(`[MAJ] ⚠️ Vérification impossible : ${(err && err.message) || 'erreur inconnue'}`));

  autoUpdater.checkForUpdates().catch((err) => journal(`[MAJ] ⚠️ ${(err && err.message) || 'erreur inconnue'}`));
}

module.exports = { verifierMisesAJour };
