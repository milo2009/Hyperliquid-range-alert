# Hyperliquid range alert

Notification sur ton téléphone (via [ntfy](https://ntfy.sh)) quand :

- une **LP concentrée** HyperSwap V3 (HyperEVM) sort de sa range, ou s'approche d'un bord (défaut : à moins de 3 %) ;
- une **position perp** Hyperliquid s'approche de son prix de liquidation (défaut : alerte à 15 %, urgent à 7 %), ou sort d'une range de prix que tu définis ;
- une **position sur une autre plateforme** (ex. Variational Omni, sans API publique) voit le prix atteindre son **prix d'entrée** (short : le prix remonte à l'entrée ; long : il redescend à l'entrée). Ces positions sont saisies à la main (voir `manual` ci-dessous) ; le prix utilisé est celui d'Hyperliquid, qui peut différer de quelques dollars du mark Variational.

Le script est **en lecture seule** : il n'utilise que ton adresse publique, jamais de clé privée, et ne touche pas à Rabby.
Les positions sont détectées automatiquement (NFT LP détenus par l'adresse + positions perp ouvertes), donc les nouvelles positions sont suivies sans rien modifier.

## Quand reçoit-on une notif ?

| Événement | Notif |
|---|---|
| Position qui passe « proche du bord » | ⚠️ priorité haute |
| Position qui sort de la range / liquidation proche | 🚨 priorité max |
| Toujours hors range | rappel toutes les 4 h |
| Retour dans la range | ✅ normale |
| Le script échoue 3 fois de suite (RPC en panne…) | ❗ une fois |

Pas de spam : une alerte n'est envoyée qu'au changement d'état (l'état est mémorisé entre deux exécutions).

Un tap sur une alerte (ou son bouton **Tableau de bord**) ouvre la web-app. Une alerte LP propose aussi une nouvelle range de même largeur, recentrée sur le prix actuel.

**Heures calmes** (par défaut 23:00 → 08:00, heure de Paris) : seule la première alerte 🚨 passe. Les ⚠️, rappels et retours à la normale sont retenus puis envoyés à la fin de la plage si la situation dure.

## Web-app mobile

Le dossier `docs/` contient une web-app installable (tableau de bord + réglages), servie par GitHub Pages.

- **Tableau de bord** : prix, état de chaque range (barre visuelle avec zones « proche du bord »), valeur des positions, frais non réclamés, perps.
- **Réglages** : modifie `config.json` directement dans le dépôt (commit). Les changements s'appliquent au passage suivant du workflow.

Mise en route :
1. **Settings → Pages** → Source « Deploy from a branch » → Branch `main`, dossier `/docs` → Save. L'app est servie sur `https://<toi>.github.io/<depot>/` après 1 à 2 minutes.
2. Sur le téléphone, ouvre `https://<toi>.github.io/<depot>/#address=0xTON_ADRESSE` dans Chrome, puis menu ⋮ → **Ajouter à l'écran d'accueil**.
3. Pour enregistrer des réglages depuis l'app, crée un token GitHub **fine-grained** limité à ce dépôt avec la seule permission **Contents : Read and write**, puis colle-le dans Réglages → « Cet appareil ». Il reste stocké uniquement dans le navigateur du téléphone.

L'adresse, le token et le topic ntfy saisis dans l'app ne sont jamais publiés.

## Mise en route

### 1. Téléphone : ntfy

1. Installe l'app **ntfy** (Play Store / App Store).
2. Choisis un nom de topic **long et impossible à deviner**, par ex. `hl-range-7f3k9q2xw8`. Toute personne qui connaît le nom peut lire tes alertes.
3. Dans l'app : **+** → abonne-toi à ce topic (serveur `ntfy.sh`).

### 2. GitHub

1. Crée un dépôt **public** sur GitHub et pousse ce dossier :
   ```powershell
   git init
   git add .
   git commit -m "Hyperliquid range alert"
   git branch -M main
   git remote add origin https://github.com/<toi>/<depot>.git
   git push -u origin main
   ```
   Pourquoi public ? Les minutes GitHub Actions sont illimitées sur un dépôt public. Sur un privé, le quota gratuit (2000 min/mois) ne couvre pas une exécution toutes les 5 min. Ton adresse et ton topic ne sont **pas** dans le code : ce sont des secrets.
2. Dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret** :
   - `WALLET_ADDRESS` = ton adresse `0x…` (celle affichée dans Rabby)
   - `NTFY_TOPIC` = le nom du topic choisi à l'étape 1
3. **Actions → Surveillance positions → Run workflow**, coche « Envoyer une notification de test ». Tu dois recevoir la notif sur ton téléphone.

4. Déclenchement toutes les 5 min par **cron-job.org** (le cron intégré de GitHub saute des exécutions pendant des heures, inutilisable pour des alertes) :
   1. Crée un token GitHub : **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
      - *Repository access* : **Only select repositories** → ce dépôt uniquement
      - *Permissions* → *Repository permissions* → **Actions : Read and write** (rien d'autre)
   2. Sur [cron-job.org](https://cron-job.org) (compte gratuit) → **Create cronjob** :
      - *URL* : `https://api.github.com/repos/<toi>/<depot>/actions/workflows/monitor.yml/dispatches`
      - *Execution schedule* : peu importe, il sera remplacé par le rythme choisi dans les réglages (étape 5)
      - onglet *Advanced* → *Request method* : **POST**
      - *Headers* :
        - `Authorization` : `Bearer <le token>`
        - `Accept` : `application/vnd.github+json`
        - `X-GitHub-Api-Version` : `2022-11-28`
        - `Content-Type` : `application/json`
      - *Request body* : `{"ref":"main"}`
      - active la notification par e-mail en cas d'échec
   3. **Test run** : la réponse doit être `204 No Content`, et une exécution « workflow_dispatch » apparaît dans l'onglet Actions.

5. Rythme réglable depuis l'app : le workflow **Synchro rythme cron-job.org** reporte `schedule.cron` de `config.json` sur ce job à chaque modification.
   1. Sur cron-job.org : **Settings → API** → crée une clé API (sans restriction d'IP : les serveurs GitHub changent d'adresse).
   2. Dans le dépôt : secret `CRONJOB_API_KEY` = cette clé. Le job est retrouvé tout seul via son URL (`…/monitor.yml/dispatches`) ; si tu en as plusieurs, ajoute aussi le secret `CRONJOB_JOB_ID` (n° visible dans l'URL du job sur cron-job.org).
   3. **Actions → Synchro rythme cron-job.org → Run workflow** pour vérifier : le log affiche « mis à jour ✓ » et le prochain passage.

   Quota de l'API cron-job.org : 100 requêtes/jour, chaque enregistrement des réglages en consomme 2 à 3.

> ⚠️ Le token expire à la date choisie à sa création : pense à le renouveler (et à le remplacer dans cron-job.org) avant. Une erreur 401 dans cron-job.org = token expiré.

## Réglages (`config.json`)

| Clé | Rôle | Défaut |
|---|---|---|
| `schedule.cron` | rythme de vérification, cron à 5 champs (heure de Paris), ex. `*/5 * * * *` = toutes les 5 min, `*/2 8-23 * * *` = toutes les 2 min de 8 h à minuit. Reporté sur cron-job.org (étape 5) | `0 * * * *` |
| `notifyNear` | `false` = notifier seulement les 🚨 (sortie de range, liquidation proche) ; les 🟠 restent visibles sur le tableau de bord | `true` |
| `notifyAfterConsecutiveFailures` | alerte « Surveillance en échec » après N exécutions ratées d'affilée | `3` |
| `lp.nearEdgePct` | seuil 🟠 « proche du bord » : prix à moins de X % d'une borne | `3` |
| `lp.positionManagers[].extraTokenIds` | IDs de positions à suivre même si le NFT n'est pas dans ton wallet (ex. stakée dans une farm) | `[]` |
| `lp.positionManagers[].ignoreTokenIds` | IDs à ignorer | `[]` |
| `perps.liqWarnPct` / `perps.liqDangerPct` | distance au prix de liquidation pour ⚠️ / 🚨 | `15` / `7` |
| `perps.ranges` | range de prix perso par coin, ex. `{"HYPE": {"min": 50, "max": 70}}` | `{}` |
| `manual.positions` | positions saisies à la main : `venue`, `coin`, `side` (`short`/`long`), `entry`, et en option `size`, `liq`, `url`. À mettre à jour si tu modifies la position | `[]` |
| `manual.nearEntryPct` | seuil 🟠 « proche de l'entrée » (affiché sur le tableau de bord ; notifié seulement si `notifyNear` vaut `true`) | `3` |
| `remindEveryHours` | rappel tant que c'est hors range (`0` = jamais) | `4` |
| `quietHours` | heures calmes : `enabled`, `start`, `end`, `timezone` | 23:00 → 08:00 Europe/Paris |
| `dashboardUrl` | lien « Tableau de bord » dans les notifs | URL GitHub Pages |
| `lp.positionManagers[].url` | lien du bouton DEX dans les notifs | page Portfolio HyperSwap |

Pour ajouter un autre DEX HyperEVM de type Uniswap V3, ajoute son contrat « NonfungiblePositionManager » dans `lp.positionManagers`.

## Tester en local (Windows PowerShell)

```powershell
npm install
$env:WALLET_ADDRESS = "0x..."
node src/monitor.mjs --status      # affiche l'état, n'envoie rien
$env:NTFY_TOPIC = "ton-topic"
node src/monitor.mjs --test        # envoie une notif de test
```

## Détails techniques

- LP : lecture on-chain sur HyperEVM (`rpc.hyperliquid.xyz/evm`) du contrat HyperSwap V3 NonfungiblePositionManager `0x6eDA206207c09e5428F281761DdC0D300851fBC8` (`positions()`), puis du `slot0()` du pool. La position est dans la range si `tickLower ≤ tick < tickUpper`, la même règle que l'interface HyperSwap.
- Frais non réclamés (web-app) : simulation de `collect()` (eth_call, aucune transaction).
- Perps : API publique `api.hyperliquid.xyz/info` (`clearinghouseState` + `allMids`).
