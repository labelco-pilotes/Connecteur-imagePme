# POC Electron — validation de l'architecture desktop

But **unique** de ce POC : prouver que, dans une fenêtre Electron, on capte bien le
jeton node9 (`secHASH`) que l'appli ImagePME génère quand **le membre se connecte
lui-même**. Si ce POC réussit, toute l'app desktop (download → upload → UI →
auto-update) peut être construite sur cette base.

> Ce POC **ne télécharge rien**, **n'upload rien**, **ne stocke aucun identifiant**.
> Il ouvre juste imagepme.fr et écoute l'appel légitime `/data/requeteur`.

## Lancer le POC (sur ta machine, pas en CI)

```bash
cd desktop-poc
npm install      # télécharge Electron (~1re fois, ~100 Mo)
npm start
```

## Ce que fait le POC (jalon 3a : companion arrière-plan)

L'app est **invisible par défaut**. Au lancement elle exécute un job (simulé) :
capture du jeton → download National → upload *simulé* (sauvegarde `out/`) → **notification système**.

**Deux chemins à tester :**

1. **Session ImagePME vivante** (tu t'es connecté lors d'un run précédent — le cookie persiste) :
   → **aucune fenêtre ne s'affiche**. Tu vois juste une notification « Données ImagePME ajoutées ✅ »
   et le `.xlsx` dans `out/`. C'est le comportement 100 % arrière-plan.

2. **Session absente** (1er lancement, ou après déconnexion sur imagepme.fr) :
   → après ~15 s, la **fenêtre de login s'affiche**. Tu te connectes → elle **se recache
   automatiquement** → le job continue seul → notification.

### Forcer le test du chemin « login » (session neuve)

```bash
# Supprime la session persistée de l'app, puis relance :
rm -rf ~/Library/Application\ Support/imagepme-desktop-poc && npm start
```

### Changer le job simulé (NAF / mois / dossier)

```bash
POC_NAF=47.11F POC_MOIS=2026-05 POC_DOSSIER=client-42 npm start
```

(Défaut : NAF `56.10C`, mois `2026-06`, dossier `demo-123`.)

➡️ **Si tu obtiens le `.xlsx` dans `out/`** : la chaîne complète (capture → Referer →
download) est validée. On passe à l'UI + upload copilotage + auto-update.

➡️ **« Fichier vide »** = secret statistique (< 10 entreprises sur ce NAF/période) ou
requête rejetée → réessaie avec un NAF plus courant.

➡️ **Rien après connexion** : l'appli n'appelle peut-être `/data/requeteur` qu'au clic
sur l'onglet « Données ». Me le dire, on ajuste le preload.

## Note sécurité (pour la version production, PAS le POC)

Le POC désactive `contextIsolation`/`sandbox` pour que le preload puisse envelopper le
XHR de la page (méthode éprouvée de l'extension). En production on durcira ça :
injection ciblée dans le monde principal via `MAIN world` ou un worldScript, en
gardant `contextIsolation: true`. Hors périmètre du POC.
