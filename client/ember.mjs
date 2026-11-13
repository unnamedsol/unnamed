// ember client: instruction builders for the buyback-and-burn program + the crank step.
import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token'
import { createHash } from 'crypto'

export const PROGRAM = new PublicKey(process.env.EMBER_PROGRAM || 'HnaffaXnZBLvTm5qFrnPMYcCVwqXcVJiNSWgF2ZxdGvz')
export const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const DBC_AUTH = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
export const DAMM2 = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
export const DAMM2_AUTH = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC')
export const WSOL = NATIVE_MINT
export const TTWO = new PublicKey('TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo')
/** the quote token's program (TTWO is Token-2022, wSOL is classic) */
export const qprog = (quote) => (quote.equals(WSOL) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID)
const ev = (p) => PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], p)[0]
export const DBC_EVENT = ev(DBC), DAMM2_EVENT = ev(DAMM2)
export const STATE = PublicKey.findProgramAddressSync([Buffer.from('state')], PROGRAM)[0]
export const VAULT = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM)[0]
export const vaultQuote = (quote) => getAssociatedTokenAddressSync(quote, VAULT, true, qprog(quote))
export const vaultBase = (mint) => getAssociatedTokenAddressSync(mint, VAULT, true)
const disc = (n) => createHash('sha256').update('global:' + n).digest().subarray(0, 8)
const m = (pubkey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s })
const ix = (name, keys) => new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.from(disc(name)) })
const pk = (d, o) => new PublicKey(d.subarray(o, o + 32))

export async function readState(conn) {
  const a = await conn.getAccountInfo(STATE)
  if (!a) return null
  const d = a.data; let o = 8
  const r = { mint: pk(d, o), curve: pk(d, o + 32), damm: pk(d, o + 64) }; o += 96
  r.refSqrt = d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n); o += 16
  r.last = Number(d.readBigInt64LE(o)); r.spent = d.readBigUInt64LE(o + 8); r.burned = d.readBigUInt64LE(o + 16); r.refAt = Number(d.readBigInt64LE(o + 24)); r.quote = pk(d, o + 32)
  return r
}
export async function readCurve(conn, curve) {
  const d = (await conn.getAccountInfo(curve)).data
  return { config: pk(d, 72), creator: pk(d, 104), mint: pk(d, 136), baseVault: pk(d, 168), quoteVault: pk(d, 200), quoteReserve: d.readBigUInt64LE(240), migrated: d[305] !== 0 }
}
export async function readDamm(conn, pool) {
  const a = await conn.getAccountInfo(pool); if (!a) return null
  const d = a.data
  return { tokenA: pk(d, 168), tokenB: pk(d, 200), vaultA: pk(d, 232), vaultB: pk(d, 264) }
}

export const initIx = (admin, mint, curve, config, quote) => ix('init', [
  m(admin, true, true), m(STATE, true), m(VAULT), m(mint), m(quote), m(curve), m(config), m(vaultBase(mint), true), m(vaultQuote(quote), true),
  m(TOKEN_PROGRAM_ID), m(qprog(quote)), m(ASSOCIATED_TOKEN_PROGRAM_ID), m(SystemProgram.programId),
])
export const wrapIx = () => ix('wrap', [m(STATE), m(VAULT, true), m(vaultQuote(WSOL), true), m(TOKEN_PROGRAM_ID), m(SystemProgram.programId)])
export const collectCurveIx = (s, c) => ix('collect_curve', [
  m(STATE), m(VAULT), m(s.mint), m(s.quote), m(vaultBase(s.mint), true), m(vaultQuote(s.quote), true), m(s.curve, true), m(c.config),
  m(c.baseVault, true), m(c.quoteVault, true), m(DBC_AUTH), m(DBC_EVENT), m(DBC), m(TOKEN_PROGRAM_ID), m(qprog(s.quote)),
])
export const collectSurplusIx = (s, c) => ix('collect_surplus', [
  m(STATE), m(VAULT), m(s.quote), m(vaultQuote(s.quote), true), m(s.curve, true), m(c.config), m(c.quoteVault, true), m(DBC_AUTH), m(DBC_EVENT), m(DBC), m(TOKEN_PROGRAM_ID), m(qprog(s.quote)),
])
export const collectPoolIx = (s, p, position, nftAccount) => ix('collect_pool', [
  m(STATE), m(VAULT), m(s.mint), m(s.quote), m(vaultBase(s.mint), true), m(vaultQuote(s.quote), true), m(s.damm), m(position, true), m(nftAccount),
  m(p.vaultA, true), m(p.vaultB, true), m(DAMM2_AUTH), m(DAMM2_EVENT), m(DAMM2), m(TOKEN_PROGRAM_ID), m(qprog(s.quote)),
])
/** c = curve info, p = damm info or null (pre-migration) */
export const buyBurnIx = (s, c, p) => {
  const mig = c.migrated
  return ix('buy_burn', [
    m(STATE, true), m(VAULT), m(s.mint, true), m(s.quote), m(vaultBase(s.mint), true), m(vaultQuote(s.quote), true), m(s.curve, true), m(c.config), m(s.damm, true),
    m(mig ? p.vaultA : c.baseVault, true), m(mig ? p.vaultB : c.quoteVault, true),
    m(mig ? DAMM2_AUTH : DBC_AUTH), m(mig ? DAMM2_EVENT : DBC_EVENT), m(mig ? DAMM2 : DBC), m(TOKEN_PROGRAM_ID), m(qprog(s.quote)),
  ])
}
export const burnIx = (s) => ix('burn', [m(STATE, true), m(VAULT), m(s.mint, true), m(vaultBase(s.mint), true), m(TOKEN_PROGRAM_ID)])

/** The vault's locked LP positions on the DAMM v2 pool (NFT accounts owned by the vault). */
export async function vaultPositions(conn) {
  const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token')
  const r = await conn.getParsedTokenAccountsByOwner(VAULT, { programId: TOKEN_2022_PROGRAM_ID })
  const out = []
  for (const t of r.value) {
    const i = t.account.data.parsed.info
    if (i.tokenAmount.amount !== '1') continue
    const nft = new PublicKey(i.mint)
    out.push({ nftAccount: t.pubkey, position: PublicKey.findProgramAddressSync([Buffer.from('position'), nft.toBuffer()], DAMM2)[0] })
  }
  return out
}
