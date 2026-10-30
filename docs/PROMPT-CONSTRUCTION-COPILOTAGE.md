# Prompt de construction — couche serveur « connecteur ImagePME » (à donner au Claude copilotage)

> Cahier des charges complet. Figé le 2026-10-27 après cartographie + validation du mécanisme TDFC.
> Voir `IMAGEPME-PARAMS.md` pour les paramètres de téléchargement décodés.

```
CONSTRUCTION — Couche serveur « connecteur ImagePME » (copilotage)
==================================================================
Tu as déjà cartographié le dépôt et validé le mécanisme TDFC. On construit maintenant la couche
serveur complète. Respecte les conventions EXISTANTES du dépôt. Ajoute des tests. L'app desktop
companion est prête en face et s'aligne EXACTEMENT sur ce contrat.

RAPPEL DU FLUX
--------------
Membre sur un dossier → clic « Importer données ImagePME » → le backend crée un jeton de job
(usage unique) et ouvre un deep link copilotage-imagepme://job?token=<OTT> → l'app companion
s'ouvre, lit le jeton, appelle l'endpoint JOB pour savoir quoi récupérer, télécharge les .xlsx
depuis ImagePME (session du membre, AUCUN mot de passe), puis les renvoie à l'endpoint UPLOAD
→ rangement BlobStore + métadonnée + source « Image PME – CNOEC » + audit.

DÉCISIONS DÉJÀ ACTÉES (ne pas rediscuter)
-----------------------------------------
- Jeton de job = table à usage unique (réutiliser createReset/consumeReset, src/auth/auth-store.ts).
- Transport fichier à l'upload = base64 dans du JSON (cohérent avec l'existant) + plafond de taille.
- Format de réponse = { error } nu (convention du dépôt), PAS d'enveloppe {success,data}.
- Stockage fichier = BlobStore existant (src/api/blob-store.ts, S3 OVH), comme pieces-store.ts.
- Clé dossier = { espace: cabinet_id, entrepriseId: id }.
- Deep link = schéma copilotage-imagepme:// (confirme le nom définitif et dis-le moi).

BRIQUES RÉUTILISÉES
-------------------
- Géoloc : siegeBySiren(siren) (src/api/enrichment/entreprise.ts) → code_commune ;
  deptFromCommune(code_commune) (src/api/enrichment/core.ts) → code département.
- Source/étiquette : modèle SectorBenchmark (src/benchmarks/types.ts).

ENDPOINT 1 — JOB
----------------
GET <route job>?token=<OTT>
- Valide le jeton (existe, non expiré, non consommé) ; le consomme ; génère un uploadToken
  (TTL ~15 min, lié à { espace, entrepriseId }).
- CONSTRUIT LA LISTE D'ITEMS côté serveur (voir ci-dessous).
- Réponse : { espace, entrepriseId, nomEntreprise, geoResolue:bool, uploadToken, items:[...] } ou { error }.

Construction des items :
a) codeSecteur = data.ape (ex "62.01Z"). Si APE ABSENT → items:[] + { error:"ape_absent" }.
b) Géo : siegeBySiren(data.siren) → code_commune → deptFromCommune → codeDep ;
   codeDep → codeRegion via la TABLE INSEE ci-dessous.
   - SIREN résolu → produire les 3 niveaux (Nat, Reg, Dep), geoResolue:true.
   - SIREN NON résolu (null : démo/fictif/radié/étranger) → NATIONAL SEUL, geoResolue:false.
c) territoire : Nat→"All" ; Reg→codeRegion (ex "28") ; Dep→codeDep (ex "76").
d) Items TVA (un par niveau produit) :
   { typeDonnee:"TVA", niveauGeo:"Nat|Reg|Dep", territoire, territoireLabel, codeSecteur,
     periode:"DERNIERE" }
   → periode:"DERNIERE" = sentinelle : c'est l'APP qui lit la dernière période dispo dans
     ImagePME (il combine 2 mois si échantillon faible) et la remonte à l'upload.
e) Items TDFC (un par niveau produit) :
   { typeDonnee:"TDFC", niveauGeo:"Nat|Reg|Dep", territoire, codeSecteur,
     trancheca:N, tranchecaRepli:[...], annee:<data.finExercice> }
   - N dérivé de data.fin.ca : <150k→1, 150-250k→2, 250-500k→3, 500k-1M→4, 1-5M→5, 5-50M→6,
     ≥50M ou absent→0.
   - tranchecaRepli = [N, N-1, N+1, 0] borné 1..6 puis 0 (ex N=5→[5,4,6,0] ; N=1→[1,2,0]).
   - IMPORTANT : l'URL TDFC d'ImagePME NE CONTIENT PAS d'année (vérifié). `annee` est une
     MÉTADONNÉE de contexte (étiquette restitution), pas un paramètre de téléchargement.

ENDPOINT 2 — UPLOAD
-------------------
POST <route upload>   (Authorization: Bearer <uploadToken>)
Body JSON :
{ espace, entrepriseId, typeDonnee:"TVA|TDFC", niveauGeo, territoire, codeSecteur,
  periodeUtilisee,      // TVA : période réellement téléchargée (ex "2026-78")
  anneeContexte,        // TDFC : data.finExercice (contexte)
  trancheUtilisee,      // TDFC : tranche qui a réellement renvoyé des données
  trancheRepli:bool,    // TDFC : true si trancheUtilisee ≠ tranche principale
  source:"Image PME – CNOEC", dateExtraction, nomFichier, fichierBase64 }
- Valide : uploadToken (valide, non expiré, lié à espace/entrepriseId) ; champs présents ;
  taille base64 sous plafond (ex 20 Mo décodés) ; type .xlsx.
- Range le binaire via BlobStore (clé espace/entreprise/job/typeDonnee/niveauGeo).
- Enregistre la métadonnée rattachée au dossier + SOURCE « Image PME – CNOEC » + date, de façon
  à ce que la restitution affiche la source et (TDFC) la tranche utilisée (+ « repli » si applicable).
- Journalise (audit). Réponse : { fichierId, ... } ou { error }.

TABLE INSEE département → région (statique, à poser côté serveur)
----------------------------------------------------------------
11 Île-de-France : 75,77,78,91,92,93,94,95
24 Centre-Val de Loire : 18,28,36,37,41,45
27 Bourgogne-Franche-Comté : 21,25,39,58,70,71,89,90
28 Normandie : 14,27,50,61,76
32 Hauts-de-France : 02,59,60,62,80
44 Grand Est : 08,10,51,52,54,55,57,67,68,88
52 Pays de la Loire : 44,49,53,72,85
53 Bretagne : 22,29,35,56
75 Nouvelle-Aquitaine : 16,17,19,23,24,33,40,47,64,79,86,87
76 Occitanie : 09,11,12,30,31,32,34,46,48,65,66,81,82
84 Auvergne-Rhône-Alpes : 01,03,07,15,26,38,42,43,63,69,73,74
93 Provence-Alpes-Côte d'Azur : 04,05,06,13,83,84
94 Corse : 2A,2B
01 Guadeloupe : 971 | 02 Martinique : 972 | 03 Guyane : 973 | 04 La Réunion : 974 | 06 Mayotte : 976

EXIGENCES
---------
- Sécurité : OTT & uploadToken aléatoires forts, usage unique/limité, TTL courts, jamais loggés
  en clair ; pas de secret en dur.
- Persistance DB-prête : le code applicatif écrit normalement (comme createReset/consumeReset).
  Si ton environnement d'analyse est en lecture seule, signale juste ce qui manque pour écrire en prod.
- Tests : OTT invalide/expiré/rejoué ; uploadToken invalide ; APE absent ; SIREN non résolu
  (→ national seul) ; dérivation trancheca + repli ; base64 trop gros ; chemin nominal.

LIVRABLE
--------
- Code des 2 endpoints + deep link + génération OTT + table dép→région + tests.
- docs/IMAGEPME-CONNECTEUR.md : le contrat tel qu'implémenté.
- IMPORTANT : liste-moi tout ÉCART de noms (routes, champs, format) vs ce document, pour que je
  réaligne l'app desktop.
```
