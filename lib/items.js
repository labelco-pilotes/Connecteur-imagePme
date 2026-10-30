// Mappe un item de job copilotage → URL de téléchargement ImagePME.
// Item TVA  : { typeDonnee:'TVA',  niveauGeo, territoire, territoireLabel, codeSecteur, periode }
// Item TDFC : { typeDonnee:'TDFC', niveauGeo, territoire, codeSecteur, trancheca }
//
// IMPORTANT : cette fonction reçoit des valeurs CONCRÈTES. L'orchestrateur résout AVANT d'appeler :
//   - TVA  : remplace periode:"DERNIERE" par la période réelle lue dans l'appli ImagePME ;
//   - TDFC : fixe `trancheca` à la tranche effective (après éventuel repli échantillon faible).
'use strict';

const { buildTvaUrl, buildTdfcUrl } = require('./imagepme');

function buildUrlPourItem(item) {
  if (!item || typeof item !== 'object') {
    throw new Error('item invalide');
  }
  const base = {
    codeSecteur: item.codeSecteur,
    niveauGeographique: item.niveauGeo,
    territoire: item.territoire,
  };
  if (item.typeDonnee === 'TVA') {
    return buildTvaUrl({ ...base, date: item.periode, territoireLabel: item.territoireLabel || '' });
  }
  if (item.typeDonnee === 'TDFC') {
    return buildTdfcUrl({ ...base, trancheCa: item.trancheca });
  }
  throw new Error(`typeDonnee inconnu: "${item.typeDonnee}"`);
}

module.exports = { buildUrlPourItem };
