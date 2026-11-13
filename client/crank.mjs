// ember crank: anyone can run this. It only presses the program's public buttons:
// wrap stray SOL → collect fees (curve, surplus, locked LP) → buy the coin → burn it.
// The program decides everything; this key only pays network fees and can't touch the money.
//   RPC=… CRANK_KEY=path/to/key.json [LOOP=1] node crank.mjs
import { readFileSync, appendFileSync, mkdirSync } from 'fs'
import { Connection, Keypair, Transaction, ComputeBudgetProgram } from '@solana/web3.js'
import { getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import * as E from './ember.mjs'

const conn = new Connection(process.env.RPC || 'http://127.0.0.1:8979', 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.CRANK_KEY || './crank.json'))))
const EVERY = Number(process.env.EVERY || 20) * 1000
const COLLECT_EVERY = Number(process.env.COLLECT_EVERY || 60) * 1000
mkdirSync('./data', { recursive: true })
const log = (o) => { const l = JSON.stringify({ at: new Date().toISOString(), ...o }); console.log(l); appendFileSync('./data/crank.jsonl', l + '\n') }
const bal = async (a) => { for (const p of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) { try { return (await getAccount(conn, a, 'confirmed', p)).amount } catch {} } return 0n }
const cu = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.PRIORITY || 20000) })]

/** simulate first; only send what would succeed (a failed crank costs a fee for nothing) */
async function run(name, ixs) {
  const tx = new Transaction().add(...cu, ...ixs)
  tx.feePayer = payer.publicKey
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.sign(payer)
  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) { const why = (sim.value.logs || []).find((l) => l.includes('Error Message')) || JSON.stringify(sim.value.err); return { name, skipped: why.replace(/.*Error Message: /, '') } }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 })
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return { name, sig }
}

let lastCollect = 0, surplusDone = false
async function tick() {
  const s = await E.readState(conn)
  if (!s) return log({ waiting: 'program not initialised yet' })
  const c = await E.readCurve(conn, s.curve)
  const out = []
  if (s.quote.equals(E.WSOL) && (await conn.getBalance(E.VAULT)) > 0) out.push(await run('wrap', [E.wrapIx()]))
  if (Date.now() - lastCollect > COLLECT_EVERY) {
    lastCollect = Date.now()
    out.push(await run('collect_curve', [E.collectCurveIx(s, c)]))
    if (c.migrated) {
      if (!surplusDone) { const r = await run('collect_surplus', [E.collectSurplusIx(s, c)]); if (r.sig || /already|Surplus/i.test(r.skipped || '')) surplusDone = true; out.push(r) }
      const p = await E.readDamm(conn, s.damm)
      for (const x of await E.vaultPositions(conn)) out.push(await run('collect_pool', [E.collectPoolIx(s, p, x.position, x.nftAccount)]))
    }
  }
  const sol = await bal(E.vaultQuote(s.quote)), coins = await bal(E.vaultBase(s.mint))
  const now = Math.floor(Date.now() / 1000)
  if ((sol >= 10_000n || coins > 0n) && now - s.last >= 16) {
    const p = c.migrated ? await E.readDamm(conn, s.damm) : null
    out.push(await run('buy_burn', [E.buyBurnIx(s, c, p)]))
  }
  const after = await E.readState(conn)
  const done = out.filter((o) => o.sig)
  if (done.length || process.env.VERBOSE) log({ migrated: c.migrated, vaultQuote: Number(await bal(E.vaultQuote(s.quote))) / 1e6, spent: Number(after.spent) / 1e6, burned: after.burned.toString(), steps: out })
}

if (process.env.LOOP === '1') {
  for (;;) { try { await tick() } catch (e) { log({ error: String(e.message || e).slice(0, 300) }) } await new Promise((r) => setTimeout(r, EVERY)) }
} else { await tick(); process.exit(0) }
