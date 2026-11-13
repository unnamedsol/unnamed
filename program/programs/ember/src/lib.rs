//! ember: every fee the coin earns buys the coin back and burns it. Forever.
//!
//! The coin launches on a Meteora Dynamic Bonding Curve config whose fee claimer (and leftover
//! receiver) is this program's `vault` PDA, so every partner fee lands here. Nothing in this
//! program can send the quote token (SOL or TTWO) or coins anywhere else: the only ways out are a swap into the coin and
//! a burn of the coin. Every instruction except `init` can be called by anyone.
//!
//! `init` (ADMIN only, once) binds the program to one coin and checks its config on chain. After
//! that the admin has no powers left, and the upgrade authority is burned.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed, system_instruction};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, SyncNative, Token, TokenAccount};
use anchor_spl::token_interface::{Mint as IMint, TokenAccount as ITokenAccount, TokenInterface};

declare_id!("HnaffaXnZBLvTm5qFrnPMYcCVwqXcVJiNSWgF2ZxdGvz");

/// The only key that may call `init`, once. It can do nothing else.
pub const ADMIN: Pubkey = pubkey!("4xtJWE8UJup8tpa4n9pqVRHgR5TurvELQGDoEnBf1Chj");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const DBC: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DBC_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
pub const DAMM2: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const DAMM2_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DBC_POOL_DISC: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
pub const DBC_CONFIG_DISC: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
pub const DAMM2_POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
/// the DAMM v2 config a DBC coin migrates into, by its migration_fee_option (each only lets
/// Meteora's DBC authority create pools, so the derived address is the coin's one migrated pool)
pub const DAMM2_MIGRATION_CONFIGS: [Pubkey; 7] = [
    pubkey!("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd"),
    pubkey!("2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k"),
    pubkey!("Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp"),
    pubkey!("2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq"),
    pubkey!("AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD"),
    pubkey!("DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u"),
    pubkey!("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck"),
];

// buyback limits (protect the buy from sandwiches and from its own price impact)
pub const MIN_GAP: i64 = 15; // seconds between buys
pub const LIQ_DIV: u64 = 200; // and at most 0.5% of the SOL in the pool (own impact ~1% < the ≥1% fee: sandwiches lose)
pub const MIN_BUY: u64 = 10_000; // below this (raw quote units: 0.01 TTWO / 0.00001 SOL), wait for more
// The reference price may only rise with TIME, never per call: +2% (sqrt, ~4% price) per minute since it was
// last set, at most +30% per update. A buy only happens at a spot at or below that cap, so pumping the price
// inside a transaction (a sandwich) can never make the vault pay more than the cap; holding a fake price
// for minutes costs the attacker the pool fee (≥1%) on every push.
pub const RATE_BPS_PER_MIN: u128 = 200;
pub const MAX_STEP_BPS: u128 = 3_000;
pub const TOL_BPS: u64 = 800; // a buy must get at least 92% of the coins the spot price gives (fee ≤3% + own impact ≤2%)
pub const MIN_FEE_NUM: u64 = 10_000_000; // curve fee at least 1% (sandwiches must cost more than they could take)
pub const MAX_FEE_NUM: u64 = 30_000_000; // and at most 3% (DBC fee denominator 1e9)

#[program]
pub mod ember {
    use super::*;

    /// Bind the program to its coin. ADMIN only, once. Checks the curve's config on chain:
    /// quote token as configured, every partner fee and the leftover go to the vault, creator fee 0%,
    /// all migrated liquidity locked forever to the vault, migrates to DAMM v2.
    pub fn init(ctx: Context<Init>) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let vault = ctx.accounts.vault.key();
        let (sqrt, damm) = {
            let c = &ctx.accounts.curve;
            require!(c.owner == &DBC, E::BadPool);
            let d = c.try_borrow_data()?;
            require!(d.len() >= 424 && d[..8] == DBC_POOL_DISC, E::BadPool);
            require!(pk(&d, 136) == mint, E::BadPool);
            require!(pk(&d, 72) == ctx.accounts.config.key(), E::BadPool);
            require!(d[305] == 0, E::BadPool);
            let g = ctx.accounts.config.try_borrow_data()?;
            require!(ctx.accounts.config.owner == &DBC && g.len() >= 392 && g[..8] == DBC_CONFIG_DISC, E::BadConfig);
            // fees low and fixed, so a buy never fails its slippage check for good
            let cliff = u64::from_le_bytes(g[104..112].try_into().unwrap());
            require!((MIN_FEE_NUM..=MAX_FEE_NUM).contains(&cliff), E::BadConfig); // 1%–3%
            require!(g[130] <= 1 && g[128] == 0 && g[129] == 0 && g[136] == 0, E::BadConfig); // flat (no periods), no rate limiter, no dynamic fee
            require!(g[360] != 2, E::BadConfig); // migrated LP fees claimable (not compounded into the locked position)
            require!(g[246] <= 2, E::BadConfig); // no mint authority kept
            require!(g[368..376].iter().all(|b| *b == 0), E::BadConfig); // no pool creation fee (it could never be claimed)
            require!(g[184] == 0 && g[185] == 0 && g[200] == 0 && g[201] == 0, E::BadConfig); // no liquidity vesting
            require!(pk(&g, 8) == ctx.accounts.quote.key(), E::BadConfig); // the curve's quote token
            require!(pk(&g, 40) == vault && pk(&g, 72) == vault, E::BadConfig); // fee claimer + leftover receiver
            require!(g[232] == 0, E::BadConfig); // curve fees collected in the quote token
            require!(g[233] == 1, E::BadConfig); // migrates to DAMM v2
            require!(g[237] == 0, E::BadConfig); // plain SPL token
            require!(g[239] == 100 && g[240] == 0 && g[241] == 0 && g[242] == 0, E::BadConfig); // 100% of LP locked forever, to the vault
            require!(g[245] == 0, E::BadConfig); // creator trading fee 0%
            require!(g[247] == 0 && g[248] == 0, E::BadConfig); // no migration fee
            let opt = g[243] as usize;
            require!(opt == 2 || opt == 3 || opt == 6, E::BadConfig); // migrated pool fee 1% or 2%, or customizable:
            if opt == 6 {
                let bps = u16::from_le_bytes(g[362..364].try_into().unwrap());
                require!((100..=300).contains(&bps) && g[361] == 0 && g[364] == 0 && g[376..392].iter().all(|b| *b == 0), E::BadConfig); // 1–3% flat, no dynamic fee
            }
            let q = ctx.accounts.quote.key();
            let (a, b) = if mint > q { (mint, q) } else { (q, mint) };
            let damm = Pubkey::find_program_address(&[b"pool", DAMM2_MIGRATION_CONFIGS[opt].as_ref(), a.as_ref(), b.as_ref()], &DAMM2).0;
            (u128::from_le_bytes(d[280..296].try_into().unwrap()), damm)
        };
        require!(sqrt > 0, E::BadPool);
        require!(ctx.accounts.mint.mint_authority.is_none() && ctx.accounts.mint.freeze_authority.is_none(), E::BadConfig);
        let s = &mut ctx.accounts.state;
        s.mint = mint;
        s.curve = ctx.accounts.curve.key();
        s.damm = damm;
        s.quote = ctx.accounts.quote.key();
        s.ref_sqrt = sqrt;
        s.last = 0;
        s.ref_at = Clock::get()?.unix_timestamp;
        s.spent = 0;
        s.burned = 0;
        s.bump = ctx.bumps.state;
        s.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Plain SOL sent to the vault → wrapped SOL, ready to buy with.
    pub fn wrap(ctx: Context<Wrap>) -> Result<()> {
        require!(ctx.accounts.state.quote == WSOL, E::BadPool); // only for a SOL-paired coin
        let n = ctx.accounts.vault.lamports();
        if n == 0 { return Ok(()) }
        let seeds: &[&[u8]] = &[b"vault", &[ctx.accounts.state.vault_bump]];
        invoke_signed(&system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.vault_quote.key(), n),
            &[ctx.accounts.vault.to_account_info(), ctx.accounts.vault_quote.to_account_info(), ctx.accounts.system_program.to_account_info()], &[seeds])?;
        token::sync_native(CpiContext::new(ctx.accounts.token_program.to_account_info(), SyncNative { account: ctx.accounts.vault_quote.to_account_info() }))
    }

    /// Claim the partner fees from the bonding curve into the vault (also works after migration).
    pub fn collect_curve(ctx: Context<CollectCurve>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.curve.key() == a.state.curve, E::BadPool);
        let mut data = vec![8, 236, 89, 49, 152, 125, 177, 81];
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        let metas = vec![
            ro(&a.dbc_authority), ro(&a.config), rw(&a.curve), rw(&a.vault_base.to_account_info()), rw(&a.vault_quote.to_account_info()),
            rw(&a.base_vault), rw(&a.quote_vault), ro(&a.mint.to_account_info()), ro(&a.quote.to_account_info()), signer(&a.vault),
            ro(&a.token_program), ro(&a.quote_program), ro(&a.event_authority), ro(&a.dbc),
        ];
        let infos = [a.dbc_authority.clone(), a.config.clone(), a.curve.clone(), a.vault_base.to_account_info(), a.vault_quote.to_account_info(),
            a.base_vault.clone(), a.quote_vault.clone(), a.mint.to_account_info(), a.quote.to_account_info(), a.vault.clone(),
            a.token_program.to_account_info(), a.quote_program.to_account_info(), a.event_authority.clone(), a.dbc.clone()];
        call(DBC, data, metas, &infos, a.state.vault_bump)
    }

    /// After migration: the SOL the curve raised above its threshold → the vault.
    pub fn collect_surplus(ctx: Context<CollectSurplus>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.curve.key() == a.state.curve, E::BadPool);
        let data = vec![168, 173, 72, 100, 201, 98, 38, 92];
        let metas = vec![
            ro(&a.dbc_authority), ro(&a.config), rw(&a.curve), rw(&a.vault_quote.to_account_info()), rw(&a.quote_vault),
            ro(&a.quote.to_account_info()), signer(&a.vault), ro(&a.quote_program), ro(&a.event_authority), ro(&a.dbc),
        ];
        let infos = [a.dbc_authority.clone(), a.config.clone(), a.curve.clone(), a.vault_quote.to_account_info(), a.quote_vault.clone(),
            a.quote.to_account_info(), a.vault.clone(), a.quote_program.to_account_info(), a.event_authority.clone(), a.dbc.clone()];
        call(DBC, data, metas, &infos, a.state.vault_bump)
    }

    /// After migration: claim the locked LP position's fees from the DAMM v2 pool into the vault.
    pub fn collect_pool(ctx: Context<CollectPool>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.pool.key() == a.state.damm, E::BadPool);
        let data = vec![180, 38, 154, 17, 133, 33, 162, 211];
        let metas = vec![
            ro(&a.damm_authority), ro(&a.pool), rw(&a.position), rw(&a.vault_base.to_account_info()), rw(&a.vault_quote.to_account_info()),
            rw(&a.token_a_vault), rw(&a.token_b_vault), ro(&a.mint.to_account_info()), ro(&a.quote.to_account_info()), ro(&a.position_nft_account),
            signer(&a.vault), ro(&a.token_program), ro(&a.quote_program), ro(&a.event_authority), ro(&a.damm),
        ];
        let infos = [a.damm_authority.clone(), a.pool.clone(), a.position.clone(), a.vault_base.to_account_info(), a.vault_quote.to_account_info(),
            a.token_a_vault.clone(), a.token_b_vault.clone(), a.mint.to_account_info(), a.quote.to_account_info(), a.position_nft_account.clone(),
            a.vault.clone(), a.token_program.to_account_info(), a.quote_program.to_account_info(), a.event_authority.clone(), a.damm.clone()];
        call(DAMM2, data, metas, &infos, a.state.vault_bump)
    }

    /// Buy the coin with the vault's SOL (on the curve, or on the DAMM v2 pool after migration)
    /// and burn every coin the vault holds.
    pub fn buy_burn(ctx: Context<BuyBurn>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        require!(a.curve.key() == a.state.curve, E::BadPool);
        require!(now - a.state.last >= MIN_GAP, E::TooSoon);
        let migrated = {
            require!(a.curve.owner == &DBC, E::BadPool);
            let d = a.curve.try_borrow_data()?;
            require!(d.len() >= 424 && d[..8] == DBC_POOL_DISC, E::BadPool);
            d[305] != 0
        };
        let (spot, liq) = if !migrated {
            let d = a.curve.try_borrow_data()?;
            require!(pk(&d, 168) == a.base_vault.key() && pk(&d, 200) == a.quote_vault.key(), E::BadPool);
            (u128::from_le_bytes(d[280..296].try_into().unwrap()), u64::from_le_bytes(d[240..248].try_into().unwrap()))
        } else {
            require!(a.pool.key() == a.state.damm && a.pool.owner == &DAMM2, E::BadPool);
            let p = a.pool.try_borrow_data()?;
            require!(p.len() >= 568 && p[..8] == DAMM2_POOL_DISC, E::BadPool);
            require!(pk(&p, 168) == a.state.mint && pk(&p, 200) == a.state.quote && p[481] == 0, E::BadPool);
            require!(pk(&p, 232) == a.base_vault.key() && pk(&p, 264) == a.quote_vault.key(), E::BadPool);
            (u128::from_le_bytes(p[456..472].try_into().unwrap()), vault_amount(&a.quote_vault)?)
        };
        require!(spot > 0, E::BadPool);
        let r = a.state.ref_sqrt;
        let elapsed = (now - a.state.ref_at).max(0) as u128;
        let cap = r.checked_mul(10_000 + (RATE_BPS_PER_MIN * elapsed / 60).min(MAX_STEP_BPS)).ok_or(E::Math)? / 10_000;
        // Above the time-limited reference (a real pump, or someone pumping around this buy) it still buys,
        // at half size: with buys ≤0.5% of the pool and a fee ≥1%, pumping around a buy always costs more
        // than it could take, so the buyback never has to stop.
        let over = spot > cap;
        let amount = a.vault_quote.amount.min(liq / if over { LIQ_DIV * 2 } else { LIQ_DIV });
        let next_ref = spot.min(cap);
        if amount < MIN_BUY {
            // idle: keep the reference fresh (time-limited upward) and burn any coins the vault holds
            { let st = &mut ctx.accounts.state; if next_ref != st.ref_sqrt { st.ref_sqrt = next_ref; st.ref_at = now; } }
            let a = &ctx.accounts;
            let n = a.vault_base.amount;
            burn_from_vault(&a.token_program.to_account_info(), &a.mint.to_account_info(), &a.vault_base.to_account_info(), &a.vault, a.state.vault_bump, n)?;
            if n > 0 { let st = &mut ctx.accounts.state; st.burned = st.burned.saturating_add(n); emit!(Burned { amount: n, total: st.burned }); }
            return Ok(())
        }
        // coins the spot price gives for `amount` (amount * 2^128 / spot^2), less the tolerance
        let at_spot = ((amount as u128) << 64).checked_div(spot).ok_or(E::Math)?;
        require!(at_spot < (1u128 << 64), E::Math);
        let at_spot = (at_spot << 64) / spot;
        let min_out = u64::try_from(at_spot.checked_mul((10_000 - TOL_BPS) as u128).ok_or(E::Math)? / 10_000).map_err(|_| E::Math)?;
        require!(min_out > 0, E::Math);

        let a = &ctx.accounts;
        let mut data = vec![248, 198, 158, 145, 225, 117, 135, 200]; // swap (exact in), same discriminator on both
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        let before = a.vault_base.amount;
        if !migrated {
            require!(a.venue.key() == DBC && a.venue_authority.key() == DBC_AUTHORITY, E::BadPool);
            let metas = vec![
                ro(&a.venue_authority), ro(&a.config), rw(&a.curve), rw(&a.vault_quote.to_account_info()), rw(&a.vault_base.to_account_info()),
                rw(&a.base_vault), rw(&a.quote_vault), ro(&a.mint.to_account_info()), ro(&a.quote.to_account_info()), signer(&a.vault),
                ro(&a.token_program), ro(&a.quote_program), ro(&a.venue), ro(&a.event_authority), ro(&a.venue),
            ];
            let infos = [a.venue_authority.clone(), a.config.clone(), a.curve.clone(), a.vault_quote.to_account_info(), a.vault_base.to_account_info(),
                a.base_vault.clone(), a.quote_vault.clone(), a.mint.to_account_info(), a.quote.to_account_info(), a.vault.clone(),
                a.token_program.to_account_info(), a.quote_program.to_account_info(), a.event_authority.clone(), a.venue.clone()];
            call(DBC, data, metas, &infos, a.state.vault_bump)?;
        } else {
            require!(a.venue.key() == DAMM2 && a.venue_authority.key() == DAMM2_AUTHORITY, E::BadPool);
            let metas = vec![
                ro(&a.venue_authority), rw(&a.pool), rw(&a.vault_quote.to_account_info()), rw(&a.vault_base.to_account_info()),
                rw(&a.base_vault), rw(&a.quote_vault), ro(&a.mint.to_account_info()), ro(&a.quote.to_account_info()), signer(&a.vault),
                ro(&a.token_program), ro(&a.quote_program), ro(&a.venue), ro(&a.event_authority), ro(&a.venue),
            ];
            let infos = [a.venue_authority.clone(), a.pool.clone(), a.vault_quote.to_account_info(), a.vault_base.to_account_info(),
                a.base_vault.clone(), a.quote_vault.clone(), a.mint.to_account_info(), a.quote.to_account_info(), a.vault.clone(),
                a.token_program.to_account_info(), a.quote_program.to_account_info(), a.event_authority.clone(), a.venue.clone()];
            call(DAMM2, data, metas, &infos, a.state.vault_bump)?;
        }
        ctx.accounts.vault_base.reload()?;
        ctx.accounts.vault_quote.reload()?;
        let got = ctx.accounts.vault_base.amount.checked_sub(before).ok_or(E::Math)?;
        require!(got >= min_out, E::Slippage);
        let a = &ctx.accounts;
        let n = a.vault_base.amount;
        burn_from_vault(&a.token_program.to_account_info(), &a.mint.to_account_info(), &a.vault_base.to_account_info(), &a.vault, a.state.vault_bump, n)?;
        let st = &mut ctx.accounts.state;
        st.ref_sqrt = next_ref; // never above what time allows; an honest buy brings it back down to the real price
        st.ref_at = now;
        st.last = now;
        st.spent = st.spent.saturating_add(amount);
        st.burned = st.burned.saturating_add(n);
        emit!(Bought { spent: amount, got, sqrt: spot });
        emit!(Burned { amount: n, total: st.burned });
        Ok(())
    }

    /// Burn every coin the vault holds (from pool fees or the leftover). Anyone can call it.
    pub fn burn(ctx: Context<BurnAll>) -> Result<()> {
        let a = &ctx.accounts;
        let n = a.vault_base.amount;
        if n == 0 { return Ok(()) }
        burn_from_vault(&a.token_program.to_account_info(), &a.mint.to_account_info(), &a.vault_base.to_account_info(), &a.vault, a.state.vault_bump, n)?;
        let st = &mut ctx.accounts.state;
        st.burned = st.burned.saturating_add(n);
        emit!(Burned { amount: n, total: st.burned });
        Ok(())
    }
}

/// Burn `n` coins from the vault's coin account (vault signs).
fn burn_from_vault<'a>(token_program: &AccountInfo<'a>, mint: &AccountInfo<'a>, from: &AccountInfo<'a>, vault: &AccountInfo<'a>, bump: u8, n: u64) -> Result<()> {
    if n == 0 { return Ok(()) }
    let seeds: &[&[u8]] = &[b"vault", &[bump]];
    token::burn(CpiContext::new_with_signer(token_program.clone(), Burn { mint: mint.clone(), from: from.clone(), authority: vault.clone() }, &[seeds]), n)
}

fn pk(d: &[u8], o: usize) -> Pubkey { Pubkey::try_from(&d[o..o + 32]).unwrap() }
fn ro(a: &AccountInfo) -> AccountMeta { AccountMeta::new_readonly(a.key(), false) }
fn rw(a: &AccountInfo) -> AccountMeta { AccountMeta::new(a.key(), false) }
fn signer(a: &AccountInfo) -> AccountMeta { AccountMeta::new_readonly(a.key(), true) }
fn call(program: Pubkey, data: Vec<u8>, accounts: Vec<AccountMeta>, infos: &[AccountInfo], bump: u8) -> Result<()> {
    let seeds: &[&[u8]] = &[b"vault", &[bump]];
    invoke_signed(&Instruction { program_id: program, accounts, data }, infos, &[seeds]).map_err(Into::into)
}
fn vault_amount(a: &AccountInfo) -> Result<u64> {
    require!(a.owner == &token::ID || a.owner == &anchor_spl::token_2022::ID, E::BadPool);
    let d = a.try_borrow_data()?;
    require!(d.len() >= 72, E::BadPool);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

#[account]
pub struct State {
    pub mint: Pubkey,
    pub curve: Pubkey,
    pub damm: Pubkey,
    pub ref_sqrt: u128,
    pub last: i64,
    pub spent: u64,
    pub burned: u64,
    pub ref_at: i64,
    pub quote: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

#[event]
pub struct Bought { pub spent: u64, pub got: u64, pub sqrt: u128 }
#[event]
pub struct Burned { pub amount: u64, pub total: u64 }

#[error_code]
pub enum E {
    #[msg("not this coin's pool")] BadPool,
    #[msg("config does not send every fee to the burn")] BadConfig,
    #[msg("too soon since the last buy")] TooSoon,
    #[msg("got fewer coins than the reference price allows")] Slippage,
    #[msg("math")] Math,
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + std::mem::size_of::<State>() + 16, seeds = [b"state"], bump)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: PDA, holds nothing but signs for the vault token accounts
    #[account(seeds = [b"vault"], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mint::token_program = quote_program)]
    pub quote: Box<InterfaceAccount<'info, IMint>>,
    /// CHECK: the coin's DBC pool (owner, discriminator, mint, config checked)
    pub curve: UncheckedAccount<'info>,
    /// CHECK: the pool's DBC config (checked byte by byte)
    pub config: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = admin, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_base: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = admin, associated_token::mint = quote, associated_token::authority = vault, associated_token::token_program = quote_program)]
    pub vault_quote: Box<InterfaceAccount<'info, ITokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub quote_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = WSOL, associated_token::authority = vault)]
    pub vault_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectCurve<'info> {
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: PDA, signs the claim
    #[account(seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: AccountInfo<'info>,
    #[account(address = state.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(address = state.quote, mint::token_program = quote_program)]
    pub quote: Box<InterfaceAccount<'info, IMint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote, associated_token::authority = vault, associated_token::token_program = quote_program)]
    pub vault_quote: Box<InterfaceAccount<'info, ITokenAccount>>,
    /// CHECK: == state.curve
    #[account(mut)]
    pub curve: AccountInfo<'info>,
    /// CHECK: checked by DBC (pool has_one config)
    pub config: AccountInfo<'info>,
    /// CHECK: checked by DBC
    #[account(mut)]
    pub base_vault: AccountInfo<'info>,
    /// CHECK: checked by DBC
    #[account(mut)]
    pub quote_vault: AccountInfo<'info>,
    /// CHECK: address
    #[account(address = DBC_AUTHORITY)]
    pub dbc_authority: AccountInfo<'info>,
    /// CHECK: checked by DBC
    pub event_authority: AccountInfo<'info>,
    /// CHECK: address
    #[account(address = DBC)]
    pub dbc: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub quote_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CollectSurplus<'info> {
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: PDA
    #[account(seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: AccountInfo<'info>,
    #[account(address = state.quote, mint::token_program = quote_program)]
    pub quote: Box<InterfaceAccount<'info, IMint>>,
    #[account(mut, associated_token::mint = quote, associated_token::authority = vault, associated_token::token_program = quote_program)]
    pub vault_quote: Box<InterfaceAccount<'info, ITokenAccount>>,
    /// CHECK: == state.curve
    #[account(mut)]
    pub curve: AccountInfo<'info>,
    /// CHECK: checked by DBC
    pub config: AccountInfo<'info>,
    /// CHECK: checked by DBC
    #[account(mut)]
    pub quote_vault: AccountInfo<'info>,
    /// CHECK: address
    #[account(address = DBC_AUTHORITY)]
    pub dbc_authority: AccountInfo<'info>,
    /// CHECK: checked by DBC
    pub event_authority: AccountInfo<'info>,
    /// CHECK: address
    #[account(address = DBC)]
    pub dbc: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub quote_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CollectPool<'info> {
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: PDA, owns the locked LP position
    #[account(seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: AccountInfo<'info>,
    #[account(address = state.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(address = state.quote, mint::token_program = quote_program)]
    pub quote: Box<InterfaceAccount<'info, IMint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote, associated_token::authority = vault, associated_token::token_program = quote_program)]
    pub vault_quote: Box<InterfaceAccount<'info, ITokenAccount>>,
    /// CHECK: == state.damm
    pub pool: AccountInfo<'info>,
    /// CHECK: checked by DAMM v2 (owned through position_nft_account by the vault)
    #[account(mut)]
    pub position: AccountInfo<'info>,
    /// CHECK: checked by DAMM v2
    pub position_nft_account: AccountInfo<'info>,
    /// CHECK: checked by DAMM v2
    #[account(mut)]
    pub token_a_vault: AccountInfo<'info>,
    /// CHECK: checked by DAMM v2
    #[account(mut)]
    pub token_b_vault: AccountInfo<'info>,
    /// CHECK: address
    #[account(address = DAMM2_AUTHORITY)]
    pub damm_authority: AccountInfo<'info>,
    /// CHECK: checked by DAMM v2
    pub event_authority: AccountInfo<'info>,
    /// CHECK: address
    #[account(address = DAMM2)]
    pub damm: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub quote_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BuyBurn<'info> {
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: PDA, signs the swap and the burn
    #[account(seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: AccountInfo<'info>,
    #[account(mut, address = state.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(address = state.quote, mint::token_program = quote_program)]
    pub quote: Box<InterfaceAccount<'info, IMint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote, associated_token::authority = vault, associated_token::token_program = quote_program)]
    pub vault_quote: Box<InterfaceAccount<'info, ITokenAccount>>,
    /// CHECK: == state.curve (read for price, migration flag, vaults)
    #[account(mut)]
    pub curve: AccountInfo<'info>,
    /// CHECK: the curve's config (checked by DBC on the curve swap; unused after migration)
    pub config: AccountInfo<'info>,
    /// CHECK: == state.damm after migration (unused before)
    #[account(mut)]
    pub pool: AccountInfo<'info>,
    /// CHECK: the venue's coin vault (checked against the curve / pool data)
    #[account(mut)]
    pub base_vault: AccountInfo<'info>,
    /// CHECK: the venue's SOL vault (checked against the curve / pool data)
    #[account(mut)]
    pub quote_vault: AccountInfo<'info>,
    /// CHECK: DBC_AUTHORITY or DAMM2_AUTHORITY (checked)
    pub venue_authority: AccountInfo<'info>,
    /// CHECK: the venue's event authority (checked by the venue)
    pub event_authority: AccountInfo<'info>,
    /// CHECK: DBC or DAMM2 (checked)
    pub venue: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub quote_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BurnAll<'info> {
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: PDA
    #[account(seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: AccountInfo<'info>,
    #[account(mut, address = state.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_base: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}
