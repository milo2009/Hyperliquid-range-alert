# Hyperliquid range alert

Notification sur ton téléphone (via [ntfy](https://ntfy.sh)) quand :

- une **LP concentrée** HyperSwap V3 (HyperEVM) sort de sa range, ou s'approche d'un bord (défaut : à moins de 3 %) ;
- une **position perp** Hyperliquid s'approche de son prix de liquidation (défaut : alerte à 15 %, urgent à 7 %), ou sort d'une range de prix que tu définis.

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

C'est tout : le workflow tourne ensuite toutes les ~5 minutes. GitHub peut retarder certaines exécutions de quelques minutes aux heures chargées.

> ⚠️ GitHub désactive les workflows planifiés d'un dépôt public après **60 jours sans commit**. Tu reçois un e-mail avant ; il suffit de cliquer « Enable workflow » dans l'onglet Actions (ou de faire un commit).

## Réglages (`config.json`)

| Clé | Rôle | Défaut |
|---|---|---|
| `lp.nearEdgePct` | alerte « proche du bord » si le prix est à moins de X % d'une borne | `3` |
| `lp.positionManagers[].extraTokenIds` | IDs de positions à suivre même si le NFT n'est pas dans ton wallet (ex. stakée dans une farm) | `[]` |
| `lp.positionManagers[].ignoreTokenIds` | IDs à ignorer | `[]` |
| `perps.liqWarnPct` / `perps.liqDangerPct` | distance au prix de liquidation pour ⚠️ / 🚨 | `15` / `7` |
| `perps.ranges` | range de prix perso par coin, ex. `{"HYPE": {"min": 50, "max": 70}}` | `{}` |
| `remindEveryHours` | rappel tant que c'est hors range (`0` = jamais) | `4` |

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
- Perps : API publique `api.hyperliquid.xyz/info` (`clearinghouseState` + `allMids`).
