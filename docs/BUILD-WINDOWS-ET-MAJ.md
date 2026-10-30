# Build Windows + Mises à jour auto (feed hébergé sur VPS) — mode d'emploi

Objectif : fabriquer un installeur Windows (`.exe`) **sans machine Windows ni Wine**, le tester sur
un vrai Windows, et faire en sorte que les versions suivantes se **mettent à jour toutes seules** en
allant chercher le feed sur **TON VPS** (le code source reste privé).

## Comment la chaîne fonctionne

```
  tag vX.Y.Z  ──►  CI GitHub Actions (Windows)  ──►  .exe + latest.yml + .blockmap
                                                           │
                               (dépôt auto par SSH, ou à la main la 1re fois)
                                                           ▼
                                   VPS : https://updates.label-co-pilotes.com/connecteur-imagepme/
                                                           ▲
       App installée ──► lit latest.yml ──► télécharge le .exe ──► s'installe au prochain lancement
```

- **`latest.yml`** = le feed : il contient la version, le nom du `.exe` et son empreinte (sha512).
- L'app compare sa version à celle du feed ; si plus récente, elle télécharge le `.exe` **depuis le
  même dossier** et l'installe au redémarrage.

> ⚠️ **Règle d'or** : `latest.yml` et le `.exe` doivent être servis **dans le même dossier**, en
> **HTTPS**, à l'URL configurée dans `package.json` → `build.publish[0].url`.
> Actuellement : `https://updates.label-co-pilotes.com/connecteur-imagepme/` — **à adapter** à ton
> VPS si tu changes de sous-domaine/dossier.

---

## Étape 0 — Préparer le VPS Hostinger (une seule fois)

1. **Sous-domaine + dossier** : crée (ex.) `updates.label-co-pilotes.com` pointant vers un dossier,
   et à l'intérieur un dossier `connecteur-imagepme/`. C'est là qu'iront `latest.yml` + le `.exe`.
2. **HTTPS obligatoire** : active le **SSL** (Let's Encrypt, inclus chez Hostinger) sur ce
   sous-domaine. electron-updater **refuse le HTTP**.
3. **Vérifie l'URL** dans `package.json` → `build.publish[0].url` : elle doit correspondre
   **exactement** à `https://<sous-domaine>/<dossier>/` (slash final compris).
4. Taille : chaque `.exe` pèse **~80–120 Mo** (runtime Electron inclus) — prévois la place. Garder
   la **version courante + latest.yml** suffit (optionnel : garder la précédente pour les deltas).

---

## Étape 1 — Dépôt GitHub (privé) + push (une seule fois)

Le dépôt peut rester **privé** (on ne publie rien dessus : le feed est sur ton VPS). Depuis
`desktop-poc/` :

```bash
git init
git add .
git commit -m "chore: connecteur ImagePME — build Windows + auto-update VPS"
gh repo create <ton-org>/connecteur-imagepme --private --source . --remote origin --push
```

Le `.gitignore` exclut déjà `node_modules/`, `dist/`, `out/`, `*.xlsx`, `*.har`, `.env`, `*.pem`,
`*.key`. **Vérifie `git status`** avant de pousser (rien de sensible).

---

## Étape 2 — Produire une version (le CI fabrique le `.exe` + `latest.yml`)

```bash
# 1) Monte la version dans package.json (ex. 0.0.1 -> 0.0.2). La version PILOTE la mise à jour.
# 2) Tag + push :
git commit -am "release: v0.0.2"
git tag v0.0.2
git push origin main --tags
```

Le workflow *build* démarre (onglet **Actions**) — déclenchable aussi à la main (*Run workflow*).
Il produit un **artefact `windows-installer`** (téléchargeable depuis la page du run) contenant
`...Setup 0.0.2.exe`, `latest.yml`, `.blockmap`.

### Déposer les fichiers sur le VPS — 2 options

**Option A (1re fois, à la main)** : télécharge l'artefact depuis Actions, dézippe, et **upload les
3 fichiers** (`latest.yml`, le `.exe`, le `.blockmap`) dans le dossier `connecteur-imagepme/` du VPS
via le **gestionnaire de fichiers Hostinger** ou **FTP**.

**Option B (automatique)** : ajoute 4 **secrets** au dépôt GitHub (*Settings → Secrets and
variables → Actions*) — le CI déposera alors tout seul par SSH à chaque build :

| Secret | Exemple |
|---|---|
| `VPS_HOST` | `147.79.xx.xx` ou `label-co-pilotes.com` |
| `VPS_USER` | `u123456` (utilisateur SSH Hostinger) |
| `VPS_PATH` | `/home/u123456/domains/updates.label-co-pilotes.com/public_html/connecteur-imagepme` |
| `VPS_SSH_KEY` | la **clé privée SSH** (contenu complet) autorisée sur le VPS |

> Tant que `VPS_HOST` n'est pas défini, l'étape de dépôt est **sautée** proprement (tu fais
> l'Option A). Dès que les secrets sont là, c'est **automatique**.

---

## Étape 3 — Installer + tester sur un vrai PC Windows

1. Récupère le `.exe` (depuis l'artefact Actions **ou** depuis l'URL du VPS) sur un PC Windows.
2. Double-clic → **SmartScreen « éditeur inconnu »** (non signé) → **« Informations
   complémentaires » → « Exécuter quand même »**. (La signature lèvera cet avertissement — reporté.)
3. L'app s'installe **sans droits admin** et enregistre le schéma `copilotage-imagepme://`.

### Vérifier le deep link / le bouton
- **Vrai parcours** : copilotage → **« Synchroniser les données sectorielles »** → l'app se lance,
  login ImagePME si besoin, job, notification de fin.
- **Test direct** : `Win+R` → `copilotage-imagepme://job?token=<OTT_FRAIS>`.

### Checklist
- [ ] L'installeur s'exécute et installe l'app.
- [ ] Le bouton copilotage ouvre l'app (deep link enregistré).
- [ ] TVA (N + N-1 × Nat/Rég/Dép) + TDFC récupérés, retry sur échec réseau.
- [ ] Notification de fin (+ retour d'état sur le bouton si l'endpoint est prêt).

---

## Étape 4 — Tester la mise à jour automatique (le cœur de ta demande)

1. Installe la **v0.0.2** sur le PC Windows (Étape 3).
2. Monte la version → **v0.0.3**, tag + push → le CI refait les fichiers.
3. Dépose la v0.0.3 sur le VPS (Option A ou B).
4. **Relance l'app** sur le PC : elle lit `latest.yml`, voit la v0.0.3, la télécharge en tâche de
   fond, et l'installe au **lancement suivant** (notification « Mise à jour prête »). L'utilisateur
   n'a **rien** à faire.

C'est exactement « je publie une mise à jour → l'app la reçoit ».

### Limites connues (actuelles)
- **Non signé** → SmartScreen à la **1re install** (pas aux MAJ silencieuses). Réglé par la
  **signature** (Azure Trusted Signing), reporté.
- **macOS** : l'auto-update n'applique une MAJ **que si l'app est signée** (Apple). **Windows**
  (NSIS) se met à jour **même non signé** → pleinement opérationnel maintenant.

---

## Récap des fichiers en place

| Fichier | Rôle |
|---|---|
| `lib/maj.js` | Logique auto-update (electron-updater), non bloquante |
| `main.js` (`demarrer`) | Déclenche la vérification au démarrage (packagé uniquement) |
| `package.json` → `build.publish` | Provider **generic** + **URL du VPS** (le feed) |
| `package.json` → `build.win` / `build.nsis` | Installeur NSIS Windows x64, par-utilisateur, sans admin |
| `.github/workflows/build.yml` | CI : build `.exe` + `latest.yml`, artefact, dépôt VPS auto (si secrets) |
| `.gitignore` | Exclut builds, `.xlsx`/`.har`, secrets |
