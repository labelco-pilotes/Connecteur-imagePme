// App companion ImagePME — process principal (POC build 4 : capture passive + relance /donnees).
//
// LEÇON du diagnostic : /data/requeteur exige des "options de sécurité" (hash) que l'appli
// calcule côté client. On ne les reconstruit PAS. On CAPTURE l'appel légitime que l'appli fait
// elle-même (preload qui enveloppe XHR/fetch) — méthode éprouvée de l'extension d'origine.
//
// Subtilité SSO : après le login CAS (experts-comptables), la fenêtre atterrit sur l'accueil
// (www.imagepme.fr/), PAS sur /donnees → l'appli ne rappelle pas le requêteur. Donc dès qu'on
// détecte l'accueil post-login, on renavigue vers /donnees pour déclencher l'appel → capture.
//
// Aucun mot de passe stocké. Upload SIMULÉ (sauvegarde disque).
const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { buildTvaUrl } = require('./lib/imagepme');
const { buildUrlPourItem } = require('./lib/items');
const { downloadExcel } = require('./lib/download');
const { fetchJob, uploadFichier, signalerStatutJob } = require('./lib/copilotage');
const { verifierMisesAJour } = require('./lib/maj');

const BUILD = '4-capture';
const IMAGEPME_URL = 'https://www.imagepme.fr/donnees';
const SILENT_TIMEOUT_MS = 12000; // essai silencieux avant d'afficher le login
const LOGIN_MAX_MS = 5 * 60 * 1000; // abandon après 5 min sans connexion
const PROTOCOLE_DEEPLINK = 'copilotage-imagepme'; // copilotage-imagepme://job?token=<OTT>
const PERIODE_TVA_TIMEOUT_MS = 20000; // attente max de lecture des dropdowns période (iframe Dash)
// En additif à la dernière période TVA, on récupère le MÊME mois l'année précédente (N-1) pour la
// comparaison annuelle. Mis en constante (pas de valeur « magique » dispersée dans le code).
const TVA_INCLURE_N1 = true;
// Re-tentatives in-session des unités en « echec » (erreurs réseau passagères) avant de clôturer :
// la session ImagePME et l'uploadToken sont encore valides. Seuls les « echec » sont réessayés.
const RETRY_ECHEC_MAX = 2;

const job = Object.freeze({
  dossierId: process.env.POC_DOSSIER || 'demo-123',
  naf: process.env.POC_NAF || '56.10C',
  mois: process.env.POC_MOIS || '2026-06',
});

let backgroundWin = null;
let captured = null; // URL node9 captée (avec les bonnes options de sécurité)
let captureResolvers = [];
let appPrete = false; // true après app.whenReady
let ottsEnAttente = []; // OTT reçus avant que l'app soit prête (open-url macOS au démarrage)
let chaineJobs = Promise.resolve(); // sérialise les jobs : un dossier à la fois
let periodeTvaDerniere = null; // "AAAA-MM" lue dans les dropdowns du requêteur (période DERNIERE)
let periodeTvaParts = {}; // assemblage en cours : { year, month }
let periodeTvaResolvers = [];

// Le preload remonte l'URL node9 lue dans l'appel légitime de l'appli.
ipcMain.on('NODE9_URL', (_event, url) => {
  if (!url || captured) {
    return;
  }
  captured = url;
  console.log('[APP] ✅ Jeton node9 capté (appel légitime de l’appli).');
  const resolvers = captureResolvers;
  captureResolvers = [];
  resolvers.forEach((resolve) => resolve(url));
});

// Le requêteur (iframe node9) pré-sélectionne la dernière période TVA dispo dans 2 dropdowns
// (tva_periode_year + tva_periode_month). Le preload remonte chaque valeur ; on assemble "AAAA-MM".
ipcMain.on('TVA_PERIODE_PART', (_event, payload) => {
  if (!payload || !payload.champ || !payload.valeur) {
    return;
  }
  periodeTvaParts = { ...periodeTvaParts, [payload.champ]: payload.valeur };
  if (periodeTvaParts.year && periodeTvaParts.month && !periodeTvaDerniere) {
    periodeTvaDerniere = `${periodeTvaParts.year}-${periodeTvaParts.month}`;
    console.log(`[APP] ✅ Dernière période TVA lue dans l’appli : ${periodeTvaDerniere}`);
    const resolvers = periodeTvaResolvers;
    periodeTvaResolvers = [];
    resolvers.forEach((resolve) => resolve(periodeTvaDerniere));
  }
});

// Attend la lecture de la période TVA, jusqu'à timeoutMs. Renvoie "AAAA-MM" ou null si délai dépassé.
function attendrePeriodeTva(timeoutMs) {
  if (periodeTvaDerniere) {
    return Promise.resolve(periodeTvaDerniere);
  }
  return new Promise((resolve) => {
    let done = false;
    const settle = (value) => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      }
    };
    periodeTvaResolvers.push(settle);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          periodeTvaResolvers = periodeTvaResolvers.filter((r) => r !== settle);
          settle(null);
        }, timeoutMs)
      : null;
  });
}

// Attend une capture, jusqu'à timeoutMs (0 = illimité). Renvoie l'URL ou null si délai dépassé.
function waitForCapture(timeoutMs) {
  if (captured) {
    return Promise.resolve(captured);
  }
  return new Promise((resolve) => {
    let done = false;
    const settle = (value) => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      }
    };
    captureResolvers.push(settle);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          captureResolvers = captureResolvers.filter((r) => r !== settle);
          settle(null);
        }, timeoutMs)
      : null;
  });
}

function createBackgroundWindow() {
  // Réutilise la fenêtre (et donc la session ImagePME + le referer déjà capté) entre deux jobs
  // successifs déclenchés par le deep link, au lieu d'en empiler une par dossier.
  if (backgroundWin && !backgroundWin.isDestroyed()) {
    return;
  }
  backgroundWin = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    title: 'Copilotage — ImagePME',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Nécessaire pour que le preload capte le XHR de la page (à durcir en prod via MAIN world).
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      // Le requêteur Dash (période TVA) vit dans une iframe node9 : on y injecte aussi le preload.
      nodeIntegrationInSubFrames: true,
    },
  });
  backgroundWin.loadURL(IMAGEPME_URL);

  // Driver SSO : après le login CAS, l'appli (SPA) route vers l'accueil SANS navigation
  // complète (history.pushState → did-navigate-in-page). On écoute donc les DEUX événements,
  // et dès qu'on est sur une page imagepme post-login (hors /donnees et /cas), on (re)charge
  // /donnees pour que l'appli fasse son appel /data/requeteur → capté par le preload.
  let lastPush = 0;
  const onNav = (url) => {
    console.log('[APP][nav]', url.slice(0, 90));
    if (captured) {
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return;
    }
    const now = Date.now();
    const estPageImagepme =
      parsed.host === 'www.imagepme.fr' &&
      parsed.pathname !== '/donnees' &&
      parsed.pathname !== '/cas';
    if (estPageImagepme && now - lastPush > 4000) {
      lastPush = now;
      console.log(`[APP] Page imagepme post-login (${parsed.pathname}) → relance /donnees.`);
      backgroundWin.loadURL(IMAGEPME_URL);
    }
  };
  backgroundWin.webContents.on('did-navigate', (_e, url) => onNav(url));
  backgroundWin.webContents.on('did-navigate-in-page', (_e, url) => onNav(url));
}

function notifier(titre, corps) {
  if (Notification.isSupported()) {
    new Notification({ title: titre, body: corps }).show();
  }
  console.log(`[APP] 🔔 ${titre} — ${corps}`);
}

async function executerJob(refererUrl) {
  console.log(`[APP] Job: dossier ${job.dossierId} · NAF ${job.naf} · mois ${job.mois}`);
  const url = buildTvaUrl({ codeSecteur: job.naf, date: job.mois });
  const buffer = await downloadExcel(url, refererUrl);

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const chemin = path.join(outDir, `imagepme_tva_nat_${job.naf.replace('.', '')}_${job.mois}.xlsx`);
  fs.writeFileSync(chemin, buffer);

  const ko = Math.round(buffer.length / 1024);
  console.log(`[APP] ✅ Terminé (upload simulé, ${ko} Ko) : ${chemin}`);
  notifier('Données ImagePME ajoutées ✅', `Dossier ${job.dossierId} · NAF ${job.naf} · ${ko} Ko`);
}

// Ouvre/charge ImagePME et renvoie l'URL node9 captée (secHASH), en affichant le login si besoin.
// Mutualisé entre le flux démo et le vrai flux de job.
async function obtenirReferer() {
  createBackgroundWindow();
  let refererUrl = await waitForCapture(SILENT_TIMEOUT_MS);
  if (!refererUrl) {
    console.log('[APP] Session absente → affichage du login ImagePME.');
    backgroundWin.show();
    backgroundWin.focus();
    refererUrl = await waitForCapture(LOGIN_MAX_MS);
    if (refererUrl) {
      backgroundWin.hide();
      console.log('[APP] Connecté → la fenêtre se recache, suite en arrière-plan.');
    }
  } else {
    console.log('[APP] Session ImagePME vivante → traitement en arrière-plan.');
  }
  return refererUrl;
}

async function lancerFlux() {
  console.log(`[APP] build=${BUILD} — démarrage (démo)`);
  const refererUrl = await obtenirReferer();
  if (!refererUrl) {
    notifier('Connexion ImagePME requise', 'Session non détectée (délai dépassé).');
    return;
  }
  try {
    await executerJob(refererUrl);
  } catch (error) {
    console.error('[APP] ❌ Job échoué :', error.message);
    notifier('Échec récupération ImagePME', error.message);
  }
}

// ===================== Orchestration réelle (job copilotage) =====================
// Flux : fetchJob(OTT) → pour chaque item : résoudre → downloadExcel → uploadFichier.
// Deux points de résolution runtime, isolés, à finaliser après une dernière capture :
//   (1) période TVA "DERNIERE" : lecture de la dernière période dispo dans l'appli ;
//   (2) détection "fichier vide" (secret statistique) pour le repli de tranche TDFC.

// Résout la période TVA : valeur explicite de l'item, sinon override env, sinon la dernière
// période lue dans le requêteur (dropdowns pré-sélectionnés par ImagePME).
async function resoudrePeriodeTva(item) {
  if (item.periode && item.periode !== 'DERNIERE') {
    return item.periode;
  }
  if (process.env.POC_PERIODE_TVA) {
    return process.env.POC_PERIODE_TVA;
  }
  const periode = await attendrePeriodeTva(PERIODE_TVA_TIMEOUT_MS);
  if (periode) {
    return periode;
  }
  const erreur = new Error('période TVA "DERNIERE" non lue dans l’appli (dropdowns indisponibles)');
  erreur.code = 'PERIODE_NON_RESOLUE';
  throw erreur;
}

// TDFC : essaie la tranche principale puis les replis jusqu'au premier fichier exploitable.
// (2) Détection du "vide" actuelle = fichier 0 octet (downloadExcel lève "Fichier vide") ;
// à affiner quand on aura observé le vrai signal de secret statistique.
async function telechargerTdfcAvecRepli(refererUrl, item) {
  const liste = Array.isArray(item.tranchecaRepli) && item.tranchecaRepli.length
    ? item.tranchecaRepli
    : [item.trancheca];
  const tranches = liste.filter((t, i, arr) => arr.indexOf(t) === i);
  let derniereErreur = null;
  for (const tranche of tranches) {
    const url = buildUrlPourItem({ ...item, trancheca: tranche });
    try {
      const buffer = await downloadExcel(url, refererUrl);
      return { buffer, trancheUtilisee: tranche, trancheRepli: tranche !== item.trancheca };
    } catch (error) {
      // "Pas de données à ce niveau" se manifeste par un fichier vide OU un 500 node9 : on tente
      // la tranche suivante (dont 0 = toutes). Toute autre erreur (réseau, 4xx…) remonte.
      const sansDonnee = error.code === 'FICHIER_VIDE' || error.status === 500;
      if (sansDonnee) {
        derniereErreur = error;
        console.log(`[APP] TDFC tranche ${tranche} indisponible (${error.status || 'vide'}) → tranche suivante.`);
        console.log(`[APP]    URL tentée : ${url}`);
        continue;
      }
      throw error;
    }
  }
  const indispo = new Error(
    `TDFC indisponible à ce niveau géo/secteur (toutes tranches : ${derniereErreur ? derniereErreur.message : 'vide'})`,
  );
  indispo.code = 'TDFC_INDISPONIBLE';
  throw indispo;
}

// "AAAA-MM" → même mois l'année précédente ("AAAA-1-MM"). Le mois peut être combiné (ex. "78" =
// juillet-août) : on le garde tel quel pour viser exactement la même fenêtre un an plus tôt.
// Renvoie null si la période est illisible (on n'ajoute alors pas de N-1 plutôt que d'échouer).
function periodeN1(periode) {
  const correspondance = /^(\d{4})-(\d{1,2})$/.exec(periode || '');
  if (!correspondance) {
    return null;
  }
  const anneePrecedente = Number(correspondance[1]) - 1;
  return `${anneePrecedente}-${correspondance[2]}`;
}

// Périodes TVA à récupérer pour un item : la dernière dispo (N) + (en additif) le même mois N-1.
function periodesTva(periodeDerniere) {
  const cibles = [{ periode: periodeDerniere, variante: 'N' }];
  const n1 = TVA_INCLURE_N1 ? periodeN1(periodeDerniere) : null;
  if (n1) {
    cibles.push({ periode: n1, variante: 'N-1' });
  }
  return cibles;
}

// Télécharge le .xlsx TVA d'une période concrète (l'item porte déjà `periode`).
async function telechargerTva(refererUrl, item) {
  const buffer = await downloadExcel(buildUrlPourItem(item), refererUrl);
  return { buffer, periodeUtilisee: item.periode };
}

// Une « unité » = un fichier concret à déposer (type × niveau géo × période). On la décrit SANS la
// télécharger, pour pouvoir réessayer précisément celles qui échouent (sans redéposer les voisines
// déjà réussies, ce qui créerait des doublons). `telecharger` est une closure différée.
// Renvoie { unites, lignesTerminales } : les lignes terminales (période TVA non résolue, type
// inconnu) n'ont pas d'unité et ne sont donc jamais réessayées.
async function construireUnites(refererUrl, item) {
  const base = {
    typeDonnee: item.typeDonnee,
    niveauGeo: item.niveauGeo,
    territoire: item.territoire,
    codeSecteur: item.codeSecteur,
  };
  if (item.typeDonnee === 'TVA') {
    let periodeDerniere;
    try {
      periodeDerniere = await resoudrePeriodeTva(item);
    } catch (error) {
      return { unites: [], lignesTerminales: [ligneErreur(base, error)] };
    }
    const unites = periodesTva(periodeDerniere).map(({ periode, variante }) => {
      const itemPeriode = { ...item, periode };
      return { base, variante, item: itemPeriode, telecharger: () => telechargerTva(refererUrl, itemPeriode) };
    });
    return { unites, lignesTerminales: [] };
  }
  if (item.typeDonnee === 'TDFC') {
    const unite = { base, variante: null, item, telecharger: () => telechargerTdfcAvecRepli(refererUrl, item) };
    return { unites: [unite], lignesTerminales: [] };
  }
  const ligne = { ...base, statut: 'echec', varianteTva: null, message: `typeDonnee inconnu: "${item.typeDonnee}"` };
  return { unites: [], lignesTerminales: [ligne] };
}

// Télécharge + dépose une unité, et renvoie sa ligne de rapport. Les absences de données (vide /
// 500 node9) deviennent « indisponible » (pas « échec ») — ex. un N-1 non publié pour un secteur
// à faible effectif. Les vraies erreurs techniques restent « echec » (réessayables in-session).
async function deposerUnite(job, unite) {
  const { base, variante, item, telecharger } = unite;
  const etiquette = `${item.typeDonnee}/${item.niveauGeo}${variante ? ` ${variante}` : ''}`;
  try {
    const resultat = await telecharger();
    const corps = await uploadFichier(job.uploadToken, construireMeta(job, item, resultat, variante), resultat.buffer);
    console.log(`[APP] ✅ ${etiquette} déposé.`);
    return {
      ...base,
      statut: 'depose',
      varianteTva: variante || null,
      fichierId: (corps && corps.fichierId) || null,
      periodeUtilisee: resultat.periodeUtilisee || null,
      trancheUtilisee: resultat.trancheUtilisee ?? null,
      trancheRepli: resultat.trancheRepli ?? false,
    };
  } catch (error) {
    const ligne = ligneErreur(base, error, variante);
    if (ligne.statut === 'echec') {
      console.error(`[APP] ❌ ${etiquette} — ${error.message}`);
    } else {
      console.log(`[APP] ⏭️  ${etiquette} ${ligne.statut} — ${error.message}`);
    }
    return ligne;
  }
}

// Dépose toutes les unités, puis réessaie (borné) UNIQUEMENT celles restées en « echec » tant que
// la session est vivante. « indisponible » / « en_attente » ne sont jamais réessayés (réessai inutile).
async function deposerUnitesAvecRetry(job, unites) {
  const lignes = new Array(unites.length);
  for (let i = 0; i < unites.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- dépôts séquentiels (une seule session ImagePME).
    lignes[i] = await deposerUnite(job, unites[i]);
  }
  for (let tentative = 1; tentative <= RETRY_ECHEC_MAX; tentative += 1) {
    const indicesEchec = lignes.reduce((acc, ligne, i) => (ligne.statut === 'echec' ? [...acc, i] : acc), []);
    if (indicesEchec.length === 0) {
      break;
    }
    console.log(`[APP] 🔁 Nouvelle tentative in-session (${tentative}/${RETRY_ECHEC_MAX}) — ${indicesEchec.length} échec(s) à rejouer.`);
    for (const i of indicesEchec) {
      // eslint-disable-next-line no-await-in-loop -- rejeu séquentiel des échecs résiduels.
      lignes[i] = await deposerUnite(job, unites[i]);
    }
  }
  return lignes;
}

// Ligne de rapport pour une erreur, avec le statut dérivé du type d'erreur.
function ligneErreur(base, error, variante) {
  return { ...base, statut: statutDepuisErreur(error), varianteTva: variante || null, message: error.message };
}

function construireNomFichier(item, resultat) {
  const secteur = String(item.codeSecteur || 'NA').replace('.', '');
  const niveau = String(item.niveauGeo || 'NA').toLowerCase();
  if (item.typeDonnee === 'TVA') {
    // La période (ex. 2026-78 vs 2025-78) distingue déjà N de N-1 → noms de fichiers uniques.
    return `imagepme_tva_${niveau}_${secteur}_${resultat.periodeUtilisee}.xlsx`;
  }
  return `imagepme_tdfc_${niveau}_${secteur}_t${resultat.trancheUtilisee}.xlsx`;
}

// `variante` : 'N' | 'N-1' pour la TVA (comparaison annuelle), null pour la TDFC.
function construireMeta(job, item, resultat, variante) {
  return {
    espace: job.espace,
    entrepriseId: job.entrepriseId,
    typeDonnee: item.typeDonnee,
    niveauGeo: item.niveauGeo,
    territoire: item.territoire,
    codeSecteur: item.codeSecteur,
    periodeUtilisee: resultat.periodeUtilisee || null,
    varianteTva: variante || null,
    anneeContexte: item.annee || null,
    trancheUtilisee: resultat.trancheUtilisee ?? null,
    trancheRepli: resultat.trancheRepli ?? false,
    source: 'Image PME – CNOEC',
    dateExtraction: new Date().toISOString().slice(0, 10),
    nomFichier: construireNomFichier(item, resultat),
  };
}

// Statut d'une unité en échec, selon le type d'erreur (sert au rapport renvoyé au copilotage).
function statutDepuisErreur(error) {
  if (error.code === 'PERIODE_NON_RESOLUE') {
    return 'en_attente';
  }
  // Pas de données publiées à ce niveau géo/secteur/période : TDFC toutes tranches épuisées, OU
  // fichier vide (secret statistique), OU 500 node9 (ex. TVA N-1 non publiée). Pas une « erreur ».
  if (error.code === 'TDFC_INDISPONIBLE' || error.code === 'FICHIER_VIDE' || error.status === 500) {
    return 'indisponible';
  }
  return 'echec';
}

// Agrège les statuts des lignes de rapport en compteurs (dérivés, pas mutés en cours de route).
function compterStatuts(lignes) {
  const init = { depose: 0, en_attente: 0, indisponible: 0, echec: 0 };
  return lignes.reduce(
    (acc, ligne) => ({ ...acc, [ligne.statut]: (acc[ligne.statut] || 0) + 1 }),
    init,
  );
}

async function executerJobComplet(refererUrl, ott) {
  const job = await fetchJob(ott);
  console.log(`[APP] Job ${job.entrepriseId} (${job.nomEntreprise || '?'}) — ${job.items.length} item(s), geoResolue=${job.geoResolue}`);
  // 1) On déplie les items en unités déposables (TVA → N + N-1, TDFC → 1) ; les lignes terminales
  //    (période non résolue, type inconnu) ne passent pas par un téléchargement.
  const unites = [];
  const lignesTerminales = [];
  for (const item of job.items) {
    // eslint-disable-next-line no-await-in-loop -- séquentiel (lecture période dans la même session).
    const decoupe = await construireUnites(refererUrl, item);
    unites.push(...decoupe.unites);
    lignesTerminales.push(...decoupe.lignesTerminales);
  }
  // 2) Dépôt des unités + re-tentatives in-session des échecs (erreurs réseau passagères).
  const lignesUnites = await deposerUnitesAvecRetry(job, unites);
  const rapportItems = [...lignesTerminales, ...lignesUnites];
  const compteurs = compterStatuts(rapportItems);
  const resume = `${compteurs.depose} déposé(s), ${compteurs.en_attente} en attente, ${compteurs.indisponible} indisponible(s), ${compteurs.echec} échec(s)`;
  console.log(`[APP] Job terminé : ${resume}`);
  notifier('Import ImagePME terminé', `${job.nomEntreprise || job.entrepriseId} — ${resume}`);
  await renvoyerStatut(job, compteurs, rapportItems);
}

// Renvoie le rapport de fin de job au copilotage. Non bloquant : les fichiers sont déjà déposés,
// un échec ici ne doit rien invalider.
async function renvoyerStatut(job, compteurs, items) {
  try {
    await signalerStatutJob(job.uploadToken, {
      espace: job.espace,
      entrepriseId: job.entrepriseId,
      resume: {
        deposes: compteurs.depose,
        enAttente: compteurs.en_attente,
        indisponibles: compteurs.indisponible,
        echecs: compteurs.echec,
      },
      items,
      termineLe: new Date().toISOString(),
    });
    console.log('[APP] ✅ Statut du job renvoyé au copilotage.');
  } catch (error) {
    console.error('[APP] ⚠️  Statut non renvoyé (non bloquant) :', error.message);
  }
}

// Récupère le referer (login si besoin) puis exécute le job. Partagé par le deep link et le
// mode CLI POC_OTT.
async function executerJobDepuisOtt(ott) {
  const refererUrl = await obtenirReferer();
  if (!refererUrl) {
    notifier('Connexion ImagePME requise', 'Session non détectée (délai dépassé).');
    return;
  }
  await executerJobComplet(refererUrl, ott);
}

// Déclenchement manuel du vrai flux (debug, sans le deep link) : POC_MODE=job POC_OTT=<jeton>.
async function lancerModeJob() {
  const ott = process.env.POC_OTT;
  if (!ott) {
    console.error('[APP] POC_OTT manquant (jeton de job requis en mode job).');
    app.quit();
    return;
  }
  try {
    await executerJobDepuisOtt(ott);
  } catch (error) {
    console.error('[APP] ❌ Job échoué :', error.message);
    notifier('Échec import ImagePME', error.message);
  }
}

// ===================== Deep link (copilotage-imagepme://job?token=<OTT>) =====================
// Le bouton "Synchroniser les données sectorielles" du copilotage crée le job puis ouvre ce lien.
// L'OS lance (ou réveille) l'app avec l'URL ; on en extrait l'OTT et on enchaîne le job.

function extraireOtt(url) {
  if (typeof url !== 'string' || !url.startsWith(`${PROTOCOLE_DEEPLINK}://`)) {
    return null;
  }
  try {
    const token = new URL(url).searchParams.get('token');
    return token && token.trim() ? token.trim() : null;
  } catch (_) {
    return null;
  }
}

function extraireOttDepuisArgv(argv) {
  for (const arg of argv) {
    const ott = extraireOtt(arg);
    if (ott) {
      return ott;
    }
  }
  return null;
}

// Enchaîne les jobs (un seul à la fois). Avant que l'app soit prête (open-url macOS), met en file.
function traiterDeepLink(ott) {
  if (!ott) {
    return;
  }
  if (!appPrete) {
    ottsEnAttente = [...ottsEnAttente, ott];
    return;
  }
  console.log('[APP] 🔗 Deep link reçu → lancement du job.');
  chaineJobs = chaineJobs
    .then(() => executerJobDepuisOtt(ott))
    .catch((error) => {
      console.error('[APP] ❌ Job (deep link) échoué :', error.message);
      notifier('Échec import ImagePME', error.message);
    });
}

// MODE APPRENTISSAGE (POC_MODE=learn) : fenêtre visible, aucune action automatique.
// Le membre clique lui-même chaque export dans ImagePME ; on capte PASSIVEMENT ce qu'ImagePME
// fabrique, par DEUX canaux complémentaires pour ne rien manquer :
//   - webRequest.onBeforeRequest : voit TOUTES les requêtes réseau (pas seulement XHR/fetch) ;
//   - session 'will-download'    : l'URL DÉFINITIVE d'un téléchargement déclenché.
// But : apprendre les paramètres réels du Régional, Départemental et TDFC (non observés par le
// POC) au lieu de les deviner. Nous ne téléchargeons rien nous-mêmes.
function lancerModeApprentissage() {
  console.log('[APP] === MODE APPRENTISSAGE ===');
  console.log('[APP] 1) Connecte-toi à ImagePME.  2) Clique UN PAR UN les exports :');
  console.log('[APP]    TVA National · TVA Régional · TVA Départemental · TDFC (+ rég./dép. si tu veux)');
  console.log('[APP] Chaque URL captée s’affiche ici ET va dans out/apprentissage-urls.txt.');
  console.log('[APP] Ferme la fenêtre quand tu as cliqué tous les exports.\n');

  const dossierSortie = path.join(__dirname, 'out');
  fs.mkdirSync(dossierSortie, { recursive: true });
  const fichierCible = path.join(dossierSortie, 'apprentissage-urls.txt');
  const fichierTrafic = path.join(dossierSortie, 'apprentissage-trafic.txt');

  const ecrire = (fichier, texte) => {
    try {
      fs.appendFileSync(fichier, texte);
    } catch (error) {
      console.error('[APP] Écriture du log échouée :', error.message);
    }
  };

  const fenetre = new BrowserWindow({
    show: true,
    width: 1280,
    height: 860,
    title: 'ImagePME — Mode apprentissage',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  const sessionWeb = fenetre.webContents.session;
  let compteur = 0;

  const noterExport = (origine, methode, url) => {
    compteur += 1;
    console.log(`[APP] 🎯 Export capté (#${compteur}, ${origine}) :\n${url}\n`);
    ecrire(fichierCible, `\n#${compteur} [${new Date().toISOString()}] (${origine} ${methode})\n${url}\n`);
  };

  // Canal 1 : toutes les requêtes vers datakkod. Trace verbeuse (filet de sécurité) +
  // signalement des vraies URL d'export (download_...).
  sessionWeb.webRequest.onBeforeRequest({ urls: ['*://*.datakkod.com/*'] }, (details, callback) => {
    ecrire(fichierTrafic, `[${details.method}] ${details.url}\n`);
    if (details.url.includes('download_')) {
      noterExport('requête', details.method, details.url);
    }
    callback({});
  });

  // Canal 2 : l'URL définitive de tout téléchargement déclenché par ImagePME. On laisse le
  // téléchargement se faire (ImagePME le range dans tes Téléchargements) ; on veut juste l'URL.
  sessionWeb.on('will-download', (_event, item) => {
    noterExport('download', 'GET', item.getURL());
  });

  fenetre.loadURL(IMAGEPME_URL);
  fenetre.on('closed', () => {
    console.log(`\n[APP] Mode apprentissage terminé — ${compteur} capture(s).`);
    console.log(`[APP] Exports : ${fichierCible}`);
    console.log(`[APP] Trafic complet : ${fichierTrafic}`);
    app.quit();
  });
}

// MODE CAPTURE PÉRIODE (POC_MODE=capture) : fenêtre visible sur le requêteur. On enregistre les
// réponses Dash (_dash-update-component) et les candidats du DOM pour APPRENDRE où ImagePME expose
// la dernière période TVA disponible. Diagnostic uniquement — on ne télécharge rien.
function lancerModeCapturePeriode() {
  console.log('[APP] === MODE CAPTURE PÉRIODE ===');
  console.log('[APP] 1) Connecte-toi si besoin.  2) Laisse le requêteur se charger (TVA).');
  console.log('[APP] 3) Ferme la fenêtre quand c’est affiché.\n');

  const dossierSortie = path.join(__dirname, 'out');
  fs.mkdirSync(dossierSortie, { recursive: true });
  const fichierDash = path.join(dossierSortie, 'capture-periode-dash.txt');
  const fichierDom = path.join(dossierSortie, 'capture-periode-dom.txt');

  const ecrire = (fichier, texte) => {
    try {
      fs.appendFileSync(fichier, texte);
    } catch (error) {
      console.error('[APP] Écriture du log échouée :', error.message);
    }
  };

  ipcMain.on('DASH_CAPTURE', (_event, payload) => {
    if (!payload || !payload.url) {
      return;
    }
    console.log(`[APP] 📥 Dash capté (${payload.body.length} o) : ${payload.url.slice(0, 80)}`);
    ecrire(fichierDash, `\n===== [${new Date().toISOString()}] ${payload.url} =====\n${payload.body}\n`);
  });

  ipcMain.on('DOM_CANDIDATES', (_event, payload) => {
    if (!payload) {
      return;
    }
    const textes = Array.isArray(payload.textes) ? payload.textes : [];
    const selects = Array.isArray(payload.selects) ? payload.selects : [];
    const origine = payload.origine || '(origine inconnue)';
    console.log(`[APP] 🔎 DOM [${origine}] : ${textes.length} texte(s) type période, ${selects.length} sélecteur(s).`);
    if (textes.length) {
      console.log('[APP]    période(s) détectée(s) :', textes.slice(0, 10).join(' · '));
    }
    ecrire(fichierDom, `\n===== [${new Date().toISOString()}] ${origine} =====\nTEXTES:\n${textes.join('\n')}\n\nSELECTS:\n${selects.join('\n\n')}\n`);
  });

  const fenetre = new BrowserWindow({
    show: true,
    width: 1280,
    height: 860,
    title: 'ImagePME — Capture période TVA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      // Le requêteur Dash vit dans une iframe (node9.datakkod.com) : on y injecte aussi le preload.
      nodeIntegrationInSubFrames: true,
      additionalArguments: ['--poc-capture-dash'],
    },
  });
  fenetre.loadURL(IMAGEPME_URL);
  fenetre.on('closed', () => {
    console.log(`\n[APP] Capture terminée.`);
    console.log(`[APP] Réponses Dash : ${fichierDash}`);
    console.log(`[APP] Candidats DOM : ${fichierDom}`);
    app.quit();
  });
}

// Modes CLI de dev : 'flux' (démo, défaut) · 'learn' (capture passive) · 'job' (POC_OTT=<jeton>).
// En usage réel, l'app est lancée par le deep link copilotage-imagepme://job?token=<OTT>.
const MODE = process.env.POC_MODE || 'flux';

function demarrer() {
  appPrete = true;
  // Mises à jour : vérification en tâche de fond dès le démarrage (app packagée uniquement).
  // Non bloquant — n'impacte ni le deep link ni le job en cours.
  if (app.isPackaged) {
    verifierMisesAJour({ notifier, log: (message) => console.log(message) });
  }
  // Deep link au démarrage : Windows/Linux le passent dans argv ; macOS via open-url (déjà mis
  // en file dans ottsEnAttente avant que l'app soit prête).
  const ottArgv = extraireOttDepuisArgv(process.argv);
  const ottsDemarrage = ottArgv ? [...ottsEnAttente, ottArgv] : ottsEnAttente;
  ottsEnAttente = [];
  if (ottsDemarrage.length > 0) {
    ottsDemarrage.forEach(traiterDeepLink);
    return;
  }
  // Packagée sans deep link (ex. 1er lancement pour enregistrer le schéma) : on reste en attente
  // d'un copilotage-imagepme://… ; les modes démo/CLI ne servent qu'en dev (electron .).
  if (app.isPackaged) {
    console.log('[APP] Prête — en attente d’un deep link copilotage-imagepme://job?token=…');
    return;
  }
  if (MODE === 'learn') {
    return lancerModeApprentissage();
  }
  if (MODE === 'capture') {
    return lancerModeCapturePeriode();
  }
  if (MODE === 'job') {
    return lancerModeJob();
  }
  return lancerFlux();
}

// Instance unique : indispensable pour le deep link. Une 2e ouverture (clic suivant sur le bouton)
// transmet l'OTT à l'instance déjà lancée au lieu d'en démarrer une seconde.
const instanceUnique = app.requestSingleInstanceLock();
if (!instanceUnique) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    traiterDeepLink(extraireOttDepuisArgv(argv));
  });
  // macOS transmet le deep link par open-url (peut précéder whenReady → mis en file).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    traiterDeepLink(extraireOtt(url));
  });
  // Enregistre le schéma. En dev (app non packagée), on pointe l'exécutable Electron + le script.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOLE_DEEPLINK, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOLE_DEEPLINK);
  }
  app.whenReady().then(demarrer);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
