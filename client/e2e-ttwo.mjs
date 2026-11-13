// ember end to end on a local validator running Meteora's real DBC + DAMM v2 programs (cloned from mainnet):
// config (fee claimer = vault) → coin → trades → collect → buy+burn → attacks → bond → migrate → pool fees → buy+burn on DAMM v2.
import { readFileSync } from 'fs'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { getMint, getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import BN from 'bn.js'
import * as S from '@meteora-ag/dynamic-bonding-curve-sdk'
import * as A from '@meteora-ag/cp-amm-sdk'
import * as E from './ember.mjs'

const conn = new Connection(process.env.RPC || 'http://127.0.0.1:8979', 'confirmed')
// TTWO-paired version
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('../program/deployer.json'))))
const trader = Keypair.generate(), mallory = Keypair.generate()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (c, msg) => { if (!c) throw new Error('FAIL ' + msg); console.log('  ✓', msg) }
const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })
const send = (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(cu, ...ixs), signers, { commitment: 'confirmed' })
const fails = async (ixs, signers, msg, want) => {
  try { await send(ixs, signers) } catch (e) {
    const logs = (e.logs || e.transactionLogs || []).join('\n') + String(e.message)
    if (want && !logs.includes(want)) throw new Error(`FAIL ${msg}: wrong error\n${logs.slice(-1500)}`)
    return ok(true, msg)
  }
  throw new Error('FAIL (succeeded) ' + msg)
}
const sendTx = async (tx, signers) => { tx.feePayer = signers[0].publicKey; return sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' }) }
const supply = async (mint) => (await getMint(conn, mint)).supply
const bal = async (a) => { for (const p of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) { try { return (await getAccount(conn, a, 'confirmed', p)).amount } catch {} } return 0n }
const Q = E.TTWO, VQ = E.vaultQuote(E.TTWO)

for (const k of [admin, trader, mallory]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 500 * LAMPORTS_PER_SOL), 'confirmed')
// local copy of TTWO whose mint authority is the admin, so test wallets can hold TTWO
for (const k of [trader, mallory]) {
  const ata = getAssociatedTokenAddressSync(Q, k.publicKey, false, TOKEN_2022_PROGRAM_ID)
  await send([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, k.publicKey, Q, TOKEN_2022_PROGRAM_ID), createMintToInstruction(Q, ata, admin.publicKey, 100_000n * 1_000_000n, [], TOKEN_2022_PROGRAM_ID)], [admin])
}

// 1) DBC config exactly like mainnet will be: fee claimer + leftover = vault, 0% creator fee, 100% LP locked to partner
const dbc = new S.DynamicBondingCurveClient(conn, 'confirmed')
const curveParams = S.buildCurveWithMarketCap({
  token: { tokenType: S.TokenType.SPLToken, tokenBaseDecimal: 6, tokenQuoteDecimal: 6, tokenUpdateAuthority: 0, tokenAuthorityOption: 0, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: {
    baseFeeParams: { baseFeeMode: S.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false, collectFeeMode: S.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: S.MigrationOption.MET_DAMM_V2, migrationFeeOption: S.MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: S.MigratedCollectFeeMode.QuoteToken, dynamicFee: S.DammV2DynamicFeeMode.Disabled, poolFeeBps: 100 },
  },
  liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: S.ActivationType.Timestamp,
  initialMarketCap: 11, migrationMarketCap: 60,
})
const mintKp = Keypair.generate(), cfgKp = Keypair.generate(), mint = mintKp.publicKey
const ctx = await dbc.partner.createConfigAndPool({
  config: cfgKp.publicKey, feeClaimer: E.VAULT, leftoverReceiver: E.VAULT, payer: admin.publicKey, quoteMint: Q, ...curveParams,
  preCreatePoolParam: { baseMint: mint, name: 'Test', symbol: 'TEST', uri: 'https://example.com/t.json', poolCreator: trader.publicKey },
})
await sendTx(ctx, [admin, cfgKp, mintKp, trader].filter((k, i, a) => a.indexOf(k) === i))
const curve = S.deriveDbcPoolAddress(Q, mint, cfgKp.publicKey)
console.log('coin', mint.toBase58(), 'curve', curve.toBase58(), 'threshold', Number(curveParams.migrationQuoteThreshold) / 1e6, 'SOL')

// 2a) init refuses a config whose fee is below 1% (sandwich economics) even if fees go to the vault
{
  const cheap = S.buildCurveWithMarketCap({ ...JSON.parse('{}'), token: { tokenType: S.TokenType.SPLToken, tokenBaseDecimal: 6, tokenQuoteDecimal: 6, tokenUpdateAuthority: 0, tokenAuthorityOption: 0, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: S.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 50, endingFeeBps: 50, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: S.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: S.MigrationOption.MET_DAMM_V2, migrationFeeOption: S.MigrationFeeOption.Customizable, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, migratedPoolFee: { collectFeeMode: S.MigratedCollectFeeMode.QuoteToken, dynamicFee: S.DammV2DynamicFeeMode.Disabled, poolFeeBps: 100 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: S.ActivationType.Timestamp, initialMarketCap: 11, migrationMarketCap: 60 })
  const m2 = Keypair.generate(), c2 = Keypair.generate()
  await sendTx(await dbc.partner.createConfigAndPool({ config: c2.publicKey, feeClaimer: E.VAULT, leftoverReceiver: E.VAULT, payer: admin.publicKey, quoteMint: Q, ...cheap,
    preCreatePoolParam: { baseMint: m2.publicKey, name: 'Cheap', symbol: 'CHEAP', uri: 'https://example.com/c.json', poolCreator: trader.publicKey } }), [admin, c2, m2, trader])
  await fails([E.initIx(admin.publicKey, m2.publicKey, S.deriveDbcPoolAddress(Q, m2.publicKey, c2.publicKey), c2.publicKey, Q)], [admin], 'init refuses a 0.5% fee config', 'BadConfig')
}

// 2) init: only ADMIN, only once, and only on a config that sends everything to the vault
await fails([E.initIx(mallory.publicKey, mint, curve, cfgKp.publicKey, Q)], [mallory], 'init by anyone but ADMIN refused')
await send([E.initIx(admin.publicKey, mint, curve, cfgKp.publicKey, Q)], [admin])
await fails([E.initIx(admin.publicKey, mint, curve, cfgKp.publicKey, Q)], [admin], 'init a second time refused')
let s = await E.readState(conn)
ok(s.mint.equals(mint) && s.curve.equals(curve) && s.refSqrt > 0n, 'state bound to the coin')

const buy = async (who, sol) => {
  const tx = await dbc.pool.swap({ owner: who.publicKey, pool: curve, amountIn: new BN(Math.round(sol * 1e6)), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null })
  return sendTx(tx, [who])
}
const sell = async (who, raw) => sendTx(await dbc.pool.swap({ owner: who.publicKey, pool: curve, amountIn: new BN(raw.toString()), minimumAmountOut: new BN(0), swapBaseForQuote: true, referralTokenAccount: null }), [who])
for (let i = 0; i < 4; i++) await buy(trader, 1)
const tAta = getAssociatedTokenAddressSync(mint, trader.publicKey)
await sell(trader, (await bal(tAta)) / 4n)

// 3) collect + buy + burn on the curve
let c = await E.readCurve(conn, curve)
await send([E.collectCurveIx(s, c)], [mallory]) // anyone can crank
const q0 = await bal(VQ)
ok(q0 > 0n, `curve fees collected into the vault: ${Number(q0) / 1e6} TTWO`)
const sup0 = await supply(mint)
// the trades pumped the price above the launch reference: cranks step the reference up until it buys
const crankUntilBought = async (cv, pv, tries = 60) => {
  const sp = (await E.readState(conn)).spent
  for (let i = 0; i < tries; i++) {
    try { await send([E.buyBurnIx(s, cv ? await E.readCurve(conn, curve) : c, pv)], [mallory]) }
    catch (e) { if (!String(e.message + (e.transactionLogs || []).join('')).includes('TooSoon')) throw e; await sleep(4000); continue } // validator clock lags wall time
    if ((await E.readState(conn)).spent > sp) return i + 1
    await sleep(15500)
  }
  return 0
}
const steps = await crankUntilBought(true, null)
ok(steps > 0, `reference caught up with the pumped price in ${steps} crank(s), then bought`)
s = await E.readState(conn)
const sup1 = await supply(mint)
ok(sup1 < sup0 && s.burned === sup0 - sup1 && s.spent > 0n, `bought ${Number(s.spent) / 1e6} TTWO of the coin and burned ${Number(sup0 - sup1) / 1e6} (supply down)`)
ok((await bal(E.vaultBase(mint))) === 0n, 'vault holds no coins after the burn')

// 4) attacks
await fails([E.buyBurnIx(s, await E.readCurve(conn, curve), null)], [mallory], 'second buy inside 15 s refused', 'TooSoon')
c = await E.readCurve(conn, curve)
const mQuote = getAssociatedTokenAddressSync(Q, mallory.publicKey, false, TOKEN_2022_PROGRAM_ID)
const steal = E.collectCurveIx(s, c); steal.keys[5].pubkey = mQuote
await fails([steal], [mallory], 'collect into an attacker account refused')
const fakeCurve = E.collectCurveIx(s, c); fakeCurve.keys[6].pubkey = Keypair.generate().publicKey
await fails([fakeCurve], [mallory], 'collect from another pool refused', 'BadPool')
const wrongVenue = E.buyBurnIx(s, c, null); wrongVenue.keys[13].pubkey = E.DAMM2
await sleep(16000)
await fails([wrongVenue], [mallory], 'swap through the wrong program refused', 'BadPool')
// sandwich: pump the price far above the reference, then crank → the program refuses to buy high, only steps its reference
for (let i = 0; i < 2; i++) await buy(mallory, 1)
const spentBefore = (await E.readState(conn)).spent, refBefore = (await E.readState(conn)).refSqrt
await send([E.collectCurveIx(s, await E.readCurve(conn, curve))], [mallory])
const liqPumped = (await E.readCurve(conn, curve)).quoteReserve
await send([E.buyBurnIx(s, await E.readCurve(conn, curve), null)], [mallory])
s = await E.readState(conn)
console.log('    ref', refBefore, '→', s.refSqrt, 'spent', spentBefore, '→', s.spent)
ok(s.spent > spentBefore && s.spent - spentBefore <= liqPumped / 400n, `pumped price: still bought + burned, at half size (${Number(s.spent - spentBefore) / 1e6} TTWO ≤ 0.25% of the pool)`)
ok(s.refSqrt <= refBefore * 13000n / 10000n, 'reference rose only by the time allowance, not to the pumped price')
// a TTWO-paired coin has no use for plain SOL: wrap refuses
await send([SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: E.VAULT, lamports: 50_000_000 })], [trader])
await fails([E.wrapIx()], [mallory], 'wrap refused for a TTWO-paired coin')
await sleep(15500)
ok((await crankUntilBought(true, null, 10)) > 0, 'next buy goes through')

// 5) bond: buy out the curve, migrate to DAMM v2 (on mainnet Meteora's keeper does this)
c = await E.readCurve(conn, curve)
const thr = BigInt(curveParams.migrationQuoteThreshold.toString())
for (let i = 0; i < 20 && (await E.readCurve(conn, curve)).quoteReserve < thr; i++) {
  // partial fill: the last buy takes exactly what is left on the curve
  const tx = await dbc.pool.swap2({ owner: trader.publicKey, pool: curve, swapBaseForQuote: false, referralTokenAccount: null, swapMode: 1, amountIn: new BN(50e6), minimumAmountOut: new BN(0) })
  await sendTx(tx, [trader])
}
ok((await E.readCurve(conn, curve)).quoteReserve >= thr, 'curve filled to its threshold')
await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: E.DBC_AUTH, lamports: 2e9 })], [admin]) // on mainnet Meteora authority holds SOL for pool rent
const mig = await dbc.migration.migrateToDammV2({ payer: admin.publicKey, pool: curve, dammConfig: new PublicKey('A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck') })
mig.transaction.feePayer = admin.publicKey
await sendAndConfirmTransaction(conn, mig.transaction, [admin, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], { commitment: 'confirmed' })
c = await E.readCurve(conn, curve)
ok(c.migrated, 'curve migrated to DAMM v2')
const p = await E.readDamm(conn, s.damm)
ok(p && p.tokenA.equals(mint) && p.tokenB.equals(Q), 'migrated pool is the address the program derived at init')
const pos = await E.vaultPositions(conn)
ok(pos.length >= 1, `vault owns ${pos.length} locked LP position(s)`)

// 6) after migration: leftover curve fees + surplus, pool fees, buy + burn on DAMM v2
await send([E.collectCurveIx(s, c)], [mallory])
try { await send([E.collectSurplusIx(s, c)], [mallory]); console.log('  · surplus collected') } catch (e) { console.log('  · no surplus to collect:', (e.logs || []).slice(-2).join(' ')) }
const amm = new A.CpAmm(conn)
const swapDamm = async (who, inMint, outMint, amountIn) => {
  const b = await amm.swap({ payer: who.publicKey, pool: s.damm, inputTokenMint: inMint, outputTokenMint: outMint, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(0),
    tokenAMint: mint, tokenBMint: Q, tokenAVault: p.vaultA, tokenBVault: p.vaultB, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID, referralTokenAccount: null })
  const tx = b.transaction ? await b.transaction() : await b
  return sendTx(tx, [who])
}
for (let i = 0; i < 3; i++) { await swapDamm(trader, Q, mint, 3e6); await swapDamm(trader, mint, Q, (await bal(tAta)) / 3n) }
const qBefore = await bal(VQ)
for (const x of pos) await send([E.collectPoolIx(s, p, x.position, x.nftAccount)], [mallory])
ok((await bal(VQ)) > qBefore, `DAMM v2 LP fees collected: +${Number((await bal(VQ)) - qBefore) / 1e6} TTWO`)
const stealPool = E.collectPoolIx(s, p, pos[0].position, pos[0].nftAccount); stealPool.keys[5].pubkey = mQuote
await fails([stealPool], [mallory], 'pool fees into an attacker account refused')
await sleep(16000)
const sup2 = await supply(mint)
const bought = (await crankUntilBought(false, p, 80)) > 0
ok(bought && (await supply(mint)) < sup2, `bought + burned on the DAMM v2 pool (supply ${Number(sup2) / 1e6} → ${Number(await supply(mint)) / 1e6})`)
s = await E.readState(conn)
console.log(`E2E PASSED · spent ${Number(s.spent) / 1e6} TTWO · burned ${Number(s.burned) / 1e6} coins · vault TTWO left ${Number(await bal(VQ)) / 1e6}`)
process.exit(0)
