// ember launch steps (dry run unless EXECUTE=1):
//   STEP=config  create the Meteora DBC config: fee claimer + leftover = the burn vault, 0% creator fee,
//                100% of the migrated LP locked forever to the vault. Paid by the deployer. Prints the config.
//   STEP=pool    create the coin on that config. CREATOR_KEY = launch wallet (pays, becomes creator =
//                holds the metadata update authority, so name/ticker/image can change later).
//                NAME, SYMBOL, URI (metadata JSON), optional DEV_BUY.
//   STEP=init    bind the burn program to the coin (deployer = ADMIN, once).
//   STEP=show    print everything anyone can check on chain.
// Curve: START_MCAP_SOL (default 30), BOND_MCAP_SOL (default 300), FEE_BPS curve fee (default 100, max 300),
//        POOL_FEE_BPS fee after bonding (default 100, max 300).
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import BN from 'bn.js'
import * as S from '@meteora-ag/dynamic-bonding-curve-sdk'
import * as E from './ember.mjs'
const QUOTE = process.env.QUOTE === 'SOL' ? E.WSOL : E.TTWO // paired with TTWO unless QUOTE=SOL
const QDEC = QUOTE.equals(E.WSOL) ? 9 : 6

const RPC = process.env.RPC || 'http://127.0.0.1:8979'
const conn = new Connection(RPC, 'confirmed')
const EXEC = process.env.EXECUTE === '1'
const STEP = process.env.STEP || 'show'
const FILE = process.env.LAUNCH_FILE || './data/launch.json'
const L = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
const save = () => writeFileSync(FILE, JSON.stringify(L, null, 1))
const key = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p))))
const deployer = () => key(process.env.DEPLOYER_KEY || '../program/deployer.json')
const dbc = new S.DynamicBondingCurveClient(conn, 'confirmed')
const num = (k, d) => Number(process.env[k] ?? d)

async function go(tx, signers, label) {
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const sim = await conn.simulateTransaction(tx)
  console.log(label, 'simulation', sim.value.err ? 'FAILED ' + JSON.stringify(sim.value.err) : 'ok')
  if (sim.value.err) { console.log((sim.value.logs || []).slice(-8).join('\n')); process.exit(1) }
  if (!EXEC) { console.log('dry run (EXECUTE=1 to send)'); return null }
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' })
  console.log(label, 'sent', sig)
  return sig
}

if (STEP === 'config') {
  const fee = num('FEE_BPS', 100), poolFee = num('POOL_FEE_BPS', 100)
  if (fee > 300 || poolFee > 300) throw new Error('fees above 3% are refused by the program')
  const curve = S.buildCurveWithMarketCap({
    token: { tokenType: S.TokenType.SPLToken, tokenBaseDecimal: 6, tokenQuoteDecimal: QDEC, tokenUpdateAuthority: 0, tokenAuthorityOption: 0, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: S.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: fee, endingFeeBps: fee, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: S.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: S.MigrationOption.MET_DAMM_V2, migrationFeeOption: S.MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: S.MigratedCollectFeeMode.QuoteToken, dynamicFee: S.DammV2DynamicFeeMode.Disabled, poolFeeBps: poolFee },
    },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: S.ActivationType.Timestamp,
    initialMarketCap: num('START_MCAP', 11), migrationMarketCap: num('BOND_MCAP', 200),
  })
  const cfg = Keypair.generate(), d = deployer()
  const tx = await dbc.partner.createConfig({ config: cfg.publicKey, feeClaimer: E.VAULT, leftoverReceiver: E.VAULT, payer: d.publicKey, quoteMint: QUOTE, ...curve })
  console.log(`config ${cfg.publicKey.toBase58()} | fee claimer + leftover = vault ${E.VAULT.toBase58()} | curve fee ${fee / 100}% → pool fee ${poolFee / 100}% | paired with ${QUOTE.equals(E.WSOL) ? 'SOL' : 'TTWO'} | start ${num('START_MCAP', 11)} mcap, bonds at ${num('BOND_MCAP', 200)} mcap (raise ${Number(curve.migrationQuoteThreshold) / 10 ** QDEC})`)
  if (await go(tx, [d, cfg], 'config')) { L.config = cfg.publicKey.toBase58(); save() }
} else if (STEP === 'pool') {
  if (!L.config) throw new Error('no config yet (STEP=config)')
  const creator = key(process.env.CREATOR_KEY)
  const mint = process.env.MINT_KEY ? key(process.env.MINT_KEY) : Keypair.generate()
  const dev = num('DEV_BUY', 0)
  const tx = await dbc.creator.createPoolWithFirstBuy({
    createPoolParam: { config: new PublicKey(L.config), baseMint: mint.publicKey, name: process.env.NAME, symbol: process.env.SYMBOL, uri: process.env.URI, payer: creator.publicKey, poolCreator: creator.publicKey },
    firstBuyParam: dev > 0 ? { buyer: creator.publicKey, buyAmount: new BN(Math.round(dev * 10 ** QDEC)), minimumAmountOut: new BN(1), referralTokenAccount: null } : undefined,
  })
  console.log(`coin ${process.env.NAME} $${process.env.SYMBOL} mint ${mint.publicKey.toBase58()} creator ${creator.publicKey.toBase58()} dev buy ${dev} SOL`)
  if (await go(tx, [creator, mint], 'pool')) { L.mint = mint.publicKey.toBase58(); L.curve = S.deriveDbcPoolAddress(QUOTE, mint.publicKey, new PublicKey(L.config)).toBase58(); save() }
} else if (STEP === 'init') {
  const d = deployer()
  if (!L.mint) throw new Error('no coin yet (STEP=pool, or set mint/curve/config in launch.json)')
  await go(new Transaction().add(E.initIx(d.publicKey, new PublicKey(L.mint), new PublicKey(L.curve), new PublicKey(L.config), QUOTE)), [d], 'init')
} else {
  const s = await E.readState(conn)
  const prog = await conn.getParsedAccountInfo(E.PROGRAM)
  const pd = prog.value && new PublicKey(prog.value.data.parsed.info.programData)
  const pdi = pd && (await conn.getParsedAccountInfo(pd)).value?.data.parsed.info
  console.log(JSON.stringify({ program: E.PROGRAM.toBase58(), upgradeAuthority: pdi ? (pdi.authority ?? 'NONE (immutable)') : 'not deployed', vault: E.VAULT.toBase58(), vaultQuote: E.vaultQuote(QUOTE).toBase58(), ...L,
    state: s && { mint: s.mint.toBase58(), curve: s.curve.toBase58(), damm: s.damm.toBase58(), spent: Number(s.spent) / 10 ** QDEC, burned: s.burned.toString() } }, null, 1))
}
process.exit(0)
