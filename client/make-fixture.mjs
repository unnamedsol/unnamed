// Local tests only: copy of TTWO's mint with the mint authority swapped to the test admin,
// so test wallets can hold TTWO on a local validator. Never used on mainnet.
import { readFileSync, writeFileSync } from 'fs'
import { PublicKey } from '@solana/web3.js'
const raw = readFileSync('fixtures/ttwo-mainnet.json', 'utf8'), old = JSON.parse(raw).account.data[0]
const d = Buffer.from(old, 'base64'); new PublicKey(process.argv[2]).toBuffer().copy(d, 4)
writeFileSync('fixtures/ttwo-local.json', raw.replace(old, d.toString('base64')))
