// Construction des URL de téléchargement Excel ImagePME (TVA + TDFC, 3 niveaux géographiques).
// Paramètres FIGÉS d'après la capture réelle du 2026-10-27 (mode apprentissage) — aucun deviné.
// Aucun secret ici. `codeSecteur` = code APE/NAF. ImagePME utilise les codes INSEE standard
// pour le territoire : "All" (National), code région INSEE (Régional), code département (Départemental).
'use strict';

const DASH_BASE = 'https://node9.datakkod.com/webapp/45205';

const DOWNLOAD_ENDPOINTS = Object.freeze({
  tva: `${DASH_BASE}/download_tva_excel`,
  tdfc: `${DASH_BASE}/download_tdfc_excel`,
});

// Niveaux géographiques observés dans les URL ImagePME.
const NIVEAUX_GEO = Object.freeze({
  national: 'Nat',
  regional: 'Reg',
  departemental: 'Dep',
});

const NIVEAUX_VALIDES = new Set(Object.values(NIVEAUX_GEO));

// Validation à la frontière (ne jamais faire confiance aux entrées — règle projet).
const NAF_RE = /^[0-9]{2}\.?[0-9]{2}[A-Z]?$/i; // ex. "43.91A", "62.01Z"
const DATE_RE = /^[0-9]{4}-[0-9]{1,2}$/; // "AAAA-MM" (ex. "2026-06") ou période combinée "AAAA-78"
const TRANCHE_CA_RE = /^[0-6]$/; // 0 = toutes tranches, 1..6 = tranches de CA croissantes

function assertSecteur(codeSecteur) {
  if (!codeSecteur || !NAF_RE.test(codeSecteur)) {
    throw new Error(`codeSecteur (NAF) invalide: "${codeSecteur}"`);
  }
}

function assertNiveauTerritoire(niveauGeographique, territoire) {
  if (!NIVEAUX_VALIDES.has(niveauGeographique)) {
    throw new Error(`niveau_geographique invalide: "${niveauGeographique}" (attendu Nat|Reg|Dep)`);
  }
  if (!territoire) {
    throw new Error('territoire requis ("All" au National, code région/département sinon)');
  }
  if (niveauGeographique === NIVEAUX_GEO.national && territoire !== 'All') {
    throw new Error('territoire doit être "All" au niveau National');
  }
}

// TVA mensuel. `date` = période "AAAA-MM" (ou combinée ex. "2026-78", décidée par ImagePME).
function buildTvaUrl({
  codeSecteur,
  date,
  niveauGeographique = NIVEAUX_GEO.national,
  territoire = 'All',
  territoireLabel = '',
} = {}) {
  assertSecteur(codeSecteur);
  if (!date || !DATE_RE.test(date)) {
    throw new Error(`date (période) invalide: "${date}" — attendu "AAAA-MM" (ex. "2026-06")`);
  }
  assertNiveauTerritoire(niveauGeographique, territoire);

  const params = new URLSearchParams({
    croec: '0',
    declaration: 'MENS',
    niveau_geographique: niveauGeographique,
    territoire,
    territoire_label: territoireLabel,
    niveau_secteur: 'NAF732',
    code_secteur: codeSecteur,
    date,
    profile: 'private',
  });
  return `${DOWNLOAD_ENDPOINTS.tva}?${params.toString()}`;
}

// TDFC (liasses fiscales, annuel). PAS de `date` ni de `declaration`. `trancheCa` = 0 (toutes) à 6.
function buildTdfcUrl({
  codeSecteur,
  trancheCa = 0,
  niveauGeographique = NIVEAUX_GEO.national,
  territoire = 'All',
} = {}) {
  assertSecteur(codeSecteur);
  const tranche = String(trancheCa);
  if (!TRANCHE_CA_RE.test(tranche)) {
    throw new Error(`trancheCa invalide: "${trancheCa}" — attendu 0 (toutes) à 6`);
  }
  assertNiveauTerritoire(niveauGeographique, territoire);

  const params = new URLSearchParams({
    croec: '0',
    niveau_geographique: niveauGeographique,
    territoire,
    niveau_secteur: 'NAF732',
    code_secteur: codeSecteur,
    profile: 'private',
    trancheca: tranche,
  });
  return `${DOWNLOAD_ENDPOINTS.tdfc}?${params.toString()}`;
}

module.exports = { buildTvaUrl, buildTdfcUrl, NIVEAUX_GEO, DOWNLOAD_ENDPOINTS, DASH_BASE };
