# ForteL2 bridge

Sepolia to ForteL2 (chain 852) native-ETH deposit page. MetaMask signs `OptimismPortal.depositTransaction` on Sepolia. The page then tracks that deposit with public reads. There is no bridge server, no database, and no secret.

## Build

From `gateway/bridge/`, on Node 22:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run check:bundle
```

`npm run build` writes `dist/index.html` plus one hashed JavaScript file and one hashed CSS file in `dist/assets/`. The HTML references those files with absolute `/bridge/assets/…` URLs, because the page is served at `/bridge` (no trailing slash). The gateway image runs this build in its Node stage and copies `dist/` into nginx. `npm run check:bundle` refuses `eval`, `new Function`, inline script, inline style, and token-shaped strings. Those checks run on the real bundle.

## Browser support

Desktop Chrome or Brave, with the MetaMask extension installed. In Brave, set MetaMask as the default wallet or the page will not see it. There is no mobile deep link and no WalletConnect path. The page never asks for a seed phrase or a private key.

## Network and contracts

Chain ids, RPC URLs, the OptimismPortal address, the system config address, the deposit cap, the amount presets, and the explorer templates are in [`bridge-config.json`](bridge-config.json). That file is generated from `config/rollup.json`. The page loads it from `/bridge-config.json` and checks the live chains before Review or Approve can run.

The replica client is this origin (`/`). The sequencer URL and the Sepolia URL are the ones named in `bridge-config.json`.

## Journal

History stays in this browser, under `localStorage`, scoped to the connected account and this chain pair. A stored row is a hint until the tracker reads the chain again in this page session.

- **Export JSON** downloads the journal from a Blob URL.
- **Import JSON** reports how many rows were accepted and how many were refused. Imported rows stay pending until the tracker proves them.
- **Clear history** asks for confirmation. On-chain transactions remain visible by hash.
- **Recover by L1 hash** asks the tracker to read that Sepolia transaction.
- **Link replacement** attaches a replacement hash to a deposit already in the journal.

If the wallet prompt ends in an uncertain result, paste the Sepolia hash into the recovery field. The page does not offer a resend for that case.

## Rollback

Redeploy the previous gateway commit. Deposits already sent stay traceable by their Sepolia hash. Rollup state is not part of the gateway image.
