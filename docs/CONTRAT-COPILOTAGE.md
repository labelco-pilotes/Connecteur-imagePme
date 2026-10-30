# Contrat copilotage ↔ app companion (FINAL, 2026-10-27)

Noms définitifs confirmés par le Claude copilotage après construction. L'app s'aligne dessus
(`lib/copilotage.js`, `lib/items.js`).

## Deep link
`copilotage-imagepme://job?token=<OTT>` — à enregistrer comme handler de schéma.

## Endpoints appelés par l'app
| Appel | Méthode + route | Auth | Réponse |
|---|---|---|---|
| Récupérer le job | `GET {BASE}/imagepme/job?token=<OTT>` | l'OTT (public) | `{ espace, entrepriseId, nomEntreprise, geoResolue, uploadToken, items[] }` ou `{ error }` |
| Déposer un fichier | `POST {BASE}/imagepme/upload` | `Authorization: Bearer <uploadToken>` | `{ fichierId, ... }` ou `{ error }` |
| Retour d'état fin de job | `POST {BASE}/imagepme/complete` | `Authorization: Bearer <uploadToken>` | `{ ok:true }` ou `{ error }` |

> Création du job (côté navigateur, pas l'app) : `POST /api/imagepme/jobs`.
> Jeton : table serveur dédiée `imagepme_jobs` (usage unique atomique, porte `{espace, entrepriseId}`).
> Clé blob (interne serveur) : `imagepme/espace/entreprise/job/type/niveau/<fichierId>`.

## Item de job
- TVA : `{ typeDonnee:"TVA", niveauGeo:"Nat|Reg|Dep", territoire, territoireLabel, codeSecteur, periode:"DERNIERE" }`
- TDFC : `{ typeDonnee:"TDFC", niveauGeo:"Nat|Reg|Dep", territoire, codeSecteur, trancheca:N, tranchecaRepli:[...], annee }`

> **TVA N-1 (comparaison annuelle)** : un item TVA (une entrée) produit **jusqu'à 2 fichiers** par
> niveau géo : la dernière période dispo (`varianteTva:"N"`) **et**, en additif, le même mois l'année
> précédente (`varianteTva:"N-1"`). Ex. dernière = `2026-78` (juil.-août) → l'app dépose aussi
> `2025-78`. Deux uploads distincts (fichierId différents), distingués par `periodeUtilisee` et
> `varianteTva`. Si le N-1 n'est pas publié (secteur à faible effectif), il remonte `indisponible`
> — le N reste déposé. Rien à changer dans la définition d'item ; côté stockage/affichage, prévoir
> 1 ou 2 fichiers TVA par niveau.

## Body d'upload
`{ espace, entrepriseId, typeDonnee, niveauGeo, territoire, codeSecteur, periodeUtilisee,
   varianteTva:"N"|"N-1"|null, anneeContexte, trancheUtilisee, trancheRepli,
   source:"Image PME – CNOEC", dateExtraction, nomFichier, fichierBase64 }`

## Retour d'état de fin de job (`POST /imagepme/complete`)
Appelé une fois par job, après tous les items (non bloquant côté app). Auth = `Bearer uploadToken`.
Body : `{ espace, entrepriseId, resume:{ deposes, enAttente, indisponibles, echecs },
  items:[ { typeDonnee, niveauGeo, territoire, codeSecteur, statut, varianteTva?, fichierId?,
  periodeUtilisee?, trancheUtilisee?, trancheRepli?, message? } ], termineLe }`.
Pour la TVA, `varianteTva` vaut `"N"` ou `"N-1"` (null pour la TDFC) — **même nom de champ que dans
le body /upload** — une ligne de rapport par fichier, donc jusqu'à 2 lignes TVA par niveau géo.
Statuts `statut` (sans accent) : `depose` · `indisponible` · `echec` · `en_attente`.
Clés `resume` (camelCase pluriel) : `deposes` · `enAttente` · `indisponibles` · `echecs`.
Statuts : `depose` · `indisponible` (pas de données ImagePME à ce niveau géo/secteur, ex. TDFC
régional d'un secteur à faible effectif → 500 node9 ; **à afficher "pas de données", pas erreur**) ·
`echec` (vraie erreur) · `en_attente` (ne devrait plus arriver, période TVA lue auto).

**Re-tentative in-session (côté app)** : avant d'appeler `/complete`, l'app rejoue automatiquement
les unités restées en `echec` (erreurs réseau passagères) tant que la session ImagePME et
l'uploadToken sont valides — borné (`RETRY_ECHEC_MAX`), seuls les `echec` (ni `indisponible`, ni
`en_attente`). Un `echec` dans le rapport final est donc un échec PERSISTANT. Les `manquants`
résiduels renvoyés par `/complete` doivent passer par un NOUVEAU job (`GET /imagepme/job`), pas par
une boucle `/complete` (OTT à usage unique, uploadToken ~15 min). Un rejeu peut re-déposer une unité
dont l'upload avait réussi mais dont la réponse s'était perdue → **dédoublonner côté serveur** sur
`(typeDonnee, niveauGeo, periodeUtilisee, varianteTva)`.

## Config app / mise en service
`COPILOTAGE_BASE_URL` (env) = domaine copilotage :
- Prod : `https://app.label-co-pilotes.com`
- Dev local : `http://127.0.0.1:3000`

Contraintes serveur : fichier ≤ 15 Mo décodés, JSON ≤ 25 Mo, 60 req/min sur `/imagepme/*`
(`IMAGEPME_RATE_LIMIT_PER_MIN`). Client natif → pas de CORS/cookie (auth OTT puis Bearer).

**Prérequis avant test** : déployer la branche copilotage → migration 043 crée `imagepme_jobs` +
`imagepme_fichiers` et active les routes (rien de manuel ensuite).

Émettre un OTT de test : `POST /api/imagepme/jobs` (session, body `{"entrepriseId":"..."}`) →
`{ token, deepLink }` ; ou le script serveur `scripts/imagepme-mint-ott.ts` (sans session).

Dossiers réels de test (espace `454c6b6d-46f8-401e-b6bf-0815f9059c26`) :
`853601607` ARTECKA (47.41Z) · `931030696` 04 01 HOLDING (70.10Z).
Dossier `FOUBERTB` FOUBERT (43.22A) — espace `2d4bd85c-1df2-4a52-a722-3d953d1b1551`.

Commande de test app : `COPILOTAGE_BASE_URL=<base> POC_MODE=job POC_OTT=<jeton> npm start`

## Reste à l'orchestrateur (runtime, à câbler au vrai flux)
1. Enregistrer le schéma deep link + récupérer l'OTT à l'ouverture.
2. Boucler sur `items` : résoudre la **période TVA** (lire la dernière dispo dans l'appli) et le
   **repli de tranche TDFC** (essayer `tranchecaRepli` jusqu'au 1er fichier exploitable), puis
   `buildUrlPourItem` → `downloadExcel(url, refererNode9)` → `uploadFichier`.
3. Deux signaux encore à observer en live : **comment l'appli expose la dernière période**, et
   **comment ImagePME signale un fichier vide** (secret statistique) pour déclencher le repli.
