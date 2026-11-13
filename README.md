# $███

This coin has no name yet. The ticker is a censor bar.

The **name, ticker and image** can be updated: when it's revealed they change once, and then the update authority is revoked for good.

**The 1% tax and where it goes can never change.** It's enforced by the on-chain program in this repo.

## What the program does

The coin launches on a Meteora Dynamic Bonding Curve, paired with TTWO. Its config sends **100% of the trading fee** to this program's vault, never to a wallet:

| | |
|---|---|
| Program | `HnaffaXnZBLvTm5qFrnPMYcCVwqXcVJiNSWgF2ZxdGvz` |
| Vault (fee claimer) | `8bWXLQZEvi7PYik6AdK7WoaspTuFTbNr2ZeCA2mtnvCm` |
| Meteora config | `AAfFt8kgizkUnH84EvkAxXKWpqNmAaZ5Vfvrz5yW5mx1` |
| CA | `6uNZfLVgz6uw3ZD3P3VQ5c9CDYo3YDQyddwUvvGKRK2s` |
| Upgrade authority | **none** (burned 2026-11-13, immutable) |

The vault can only do these things. Every one of them can be called by anyone:

- `collect_curve` / `collect_surplus` / `collect_pool`: claim the coin's fees into the vault's own accounts. Pre-bond, the fees come from the curve. Post-bond, they come from the LP position, which is locked forever.
- `buy_burn`: swap the vault's TTWO into the coin and **burn every coin bought**. One buy every 15 s. Each buy is at most 0.5% of the pool, so it can never fail its own slippage check, and a sandwich costs more than it can take. During a pump it keeps buying at half size.
- `burn`: burn any coin the vault holds.

There is **no instruction that sends TTWO, SOL or coins anywhere else.**

`init` is the only admin call. It can run once, and it only binds the program to the coin, after checking the Meteora config byte by byte:
- the fee claimer is the vault;
- the creator fee is 0%;
- the fee is 1–3% and flat;
- 100% of LP is permanently locked to the vault;
- there is no mint authority.

After that the admin has no powers, and the upgrade authority is burned.

## Verify it yourself

```bash
# 1. upgrade authority must be "none"
solana program show HnaffaXnZBLvTm5qFrnPMYcCVwqXcVJiNSWgF2ZxdGvz

# 2. the code on chain is this code
solana program dump HnaffaXnZBLvTm5qFrnPMYcCVwqXcVJiNSWgF2ZxdGvz onchain.so && sha256sum onchain.so
cd program && cargo build-sbf --tools-version v1.41 && sha256sum target/deploy/ember.so
```

Deployed build sha256: `47e343e7926bc132c8fa35b6d99408139c8582093815507f5cb4cb178cc93ac1`

## Run the burn bot (anyone can)

```bash
cd client && npm i @solana/web3.js @solana/spl-token @meteora-ag/dynamic-bonding-curve-sdk @meteora-ag/cp-amm-sdk bn.js
RPC=<your rpc> CRANK_KEY=<key with a little SOL for tx fees> LOOP=1 node crank.mjs
```

The bot only pays network fees. The program decides everything.

## Tests

`client/e2e-ttwo.mjs` runs end to end on a local validator with Meteora's real DBC and DAMM v2 programs and TTWO cloned from mainnet. It covers:
- fees, buy, burn;
- attacks: stealing fees, a fake pool, the wrong venue, a sandwich pump, a second init;
- bonding, migration, then LP fees and buy+burn on DAMM v2.

```bash
node make-fixture.mjs <test admin pubkey> && MAINNET_RPC=<rpc> bash validator-ttwo.sh   # then: node e2e-ttwo.mjs
```

Notes:
- TTWO is a tokenized stock. Its issuer controls TTWO itself (it can pause or freeze it). That is outside this program.
- Meteora controls its own pool programs.
