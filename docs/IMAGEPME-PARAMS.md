# Paramètres de téléchargement ImagePME — référence

Décodé depuis la **capture réelle** du 2026-10-27 (mode apprentissage, secteur `43.91A`,
région Normandie, département Seine-Maritime). Toutes les URL générées par `lib/imagepme.js`
ont été vérifiées **identiques** aux URL captées. Rien n'est deviné.

Base : `https://node9.datakkod.com/webapp/45205`
Auth du download : en-tête **Referer** = URL node9 avec `secHASH` (node9 est stateless côté cookie).

## Endpoint TVA — `download_tva_excel` (mensuel)

```
?croec=0&declaration=MENS&niveau_geographique=<Nat|Reg|Dep>&territoire=<All|codeRégion|codeDép>
 &territoire_label=<libellé>&niveau_secteur=NAF732&code_secteur=<APE>&date=<période>&profile=private
```

## Endpoint TDFC — `download_tdfc_excel` (liasses, annuel)

```
?croec=0&niveau_geographique=<Nat|Reg|Dep>&territoire=<All|codeRégion|codeDép>
 &niveau_secteur=NAF732&code_secteur=<APE>&profile=private&trancheca=<0..6>
```

> TDFC : **pas** de `date` ni de `declaration` ni de `territoire_label`.

## Dimension géographique — codes **INSEE standard**

| Niveau | `niveau_geographique` | `territoire` | Exemple capté |
|---|---|---|---|
| National | `Nat` | `All` | — |
| Régional | `Reg` | **code INSEE région** | `28` = Normandie |
| Départemental | `Dep` | **code département** | `76` = Seine-Maritime |

➡️ **Point clé** : ces codes sont ceux du référentiel INSEE. Côté copilotage, `deptFromCommune()`
donne le **département** ; une table figée **département → région INSEE** donne le **code région**.
Aucune correspondance propriétaire à construire — les codes correspondent directement.

`territoire_label` (TVA uniquement) est **cosmétique** : l'app peut l'omettre (chaîne vide).

## Tranche de CA (TDFC) — `trancheca`

| `trancheca` | Tranche | Dérivation depuis `data.fin.ca` |
|---|---|---|
| `0` | Toutes tranches | (valeur agrégée) |
| `1` | < 150 000 € | `ca < 150000` |
| `2` | 150 000 – 250 000 € | `150000 ≤ ca < 250000` |
| `3` | 250 000 – 500 000 € | `250000 ≤ ca < 500000` |
| `4` | 500 000 € – 1 M€ | `500000 ≤ ca < 1000000` |
| `5` | 1 – 5 M€ | `1000000 ≤ ca < 5000000` |
| `6` | 5 – 50 M€ | `5000000 ≤ ca < 50000000` |

> `ca ≥ 50 000 000` : hors barème → repli sur `6` (ou `0` = toutes). Cas rare.
> Dérivation **côté serveur** (il détient `fin.ca`) ; l'app reçoit `trancheca` tout prêt.

## Période TVA (`date`) — POINT OUVERT

- Format : `AAAA-MM` (mois simple, ex. `2026-06`) **ou combiné** `AAAA-M1M2` (ex. `2026-78`
  = juillet+août). ImagePME **agrège 2 mois** quand le secteur a peu de déclarants (secret
  statistique), donc la dernière période dispo est **décidée par ImagePME, secteur par secteur**.
- On ne peut **pas** la calculer : il faut **lire** la période que l'appli sélectionne par défaut
  (la dernière dispo) au chargement du requêteur pour le secteur visé.
- Mécanisme : fixée côté appli via les callbacks `_dash-update-component` (Plotly Dash).
- **À finaliser** quand on câblera le vrai flux (la fenêtre companion charge déjà l'appli →
  on y lira la période). Non bloquant pour le reste.

## Constantes

`croec=0`, `niveau_secteur=NAF732`, `profile=private` — constants sur toutes les requêtes.

## Mention légale (obligatoire à la restitution)

Chaque donnée remontée doit être étiquetée **« Source : Image PME – CNOEC, <date> »**.
