use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    memo::Memo,
    metadata::Metadata,
    token::Token,
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use raydium_clmm_cpi::{
    cpi,
    program::RaydiumClmm,
    states::{
        AmmConfig, ObservationState, PersonalPositionState, PoolState, TickArrayState,
        POSITION_SEED, TICK_ARRAY_SEED,
    },
};

declare_id!("DUKMeZre3vZB24zc16oWrRaDcfpqHCdgvF1fPBqEFwoh");

#[program]
pub mod simple_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        require!(
            ctx.accounts.token_mint_a.key() != ctx.accounts.token_mint_b.key(),
            VaultError::IdenticalMints
        );

        let vault = &mut ctx.accounts.vault_state;
        vault.admin = ctx.accounts.admin.key();
        vault.token_mint_a = ctx.accounts.token_mint_a.key();
        vault.token_mint_b = ctx.accounts.token_mint_b.key();
        vault.vault_token_a = ctx.accounts.vault_token_a.key();
        vault.vault_token_b = ctx.accounts.vault_token_b.key();
        vault.position_nft_mint = Pubkey::default();
        vault.position_pool = Pubkey::default();
        vault.position_tick_lower = 0;
        vault.position_tick_upper = 0;
        vault.bump = ctx.bumps.vault_state;
        Ok(())
    }

    pub fn fund_vault(ctx: Context<FundVault>, amount_a: u64, amount_b: u64) -> Result<()> {
        require!(amount_a > 0 || amount_b > 0, VaultError::ZeroAmount);

        if amount_a > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program_a.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.admin_token_a.to_account_info(),
                        mint: ctx.accounts.token_mint_a.to_account_info(),
                        to: ctx.accounts.vault_token_a.to_account_info(),
                        authority: ctx.accounts.admin.to_account_info(),
                    },
                ),
                amount_a,
                ctx.accounts.token_mint_a.decimals,
            )?;
        }

        if amount_b > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program_b.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.admin_token_b.to_account_info(),
                        mint: ctx.accounts.token_mint_b.to_account_info(),
                        to: ctx.accounts.vault_token_b.to_account_info(),
                        authority: ctx.accounts.admin.to_account_info(),
                    },
                ),
                amount_b,
                ctx.accounts.token_mint_b.decimals,
            )?;
        }

        msg!("Vault funded: token A={}, token B={}", amount_a, amount_b);
        Ok(())
    }

    pub fn swap<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, Swap<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, VaultError::ZeroAmount);
        require!(minimum_amount_out > 0, VaultError::InvalidMinimumOutput);
        require!(
            ctx.accounts.vault_token_a.amount >= amount_in,
            VaultError::InsufficientInputBalance
        );

        let (pool_mint_0, pool_mint_1, pool_vault_0, pool_vault_1) = {
            let pool = ctx.accounts.pool_state.load()?;
            (
                pool.token_mint_0,
                pool.token_mint_1,
                pool.token_vault_0,
                pool.token_vault_1,
            )
        };
        let mint_a = ctx.accounts.vault_state.token_mint_a;
        let mint_b = ctx.accounts.vault_state.token_mint_b;
        let (expected_input_vault, expected_output_vault) = select_pool_vaults(
            pool_mint_0,
            pool_mint_1,
            pool_vault_0,
            pool_vault_1,
            mint_a,
            mint_b,
        )?;

        require_keys_eq!(
            ctx.accounts.input_vault.key(),
            expected_input_vault,
            VaultError::PoolVaultMismatch
        );
        require_keys_eq!(
            ctx.accounts.output_vault.key(),
            expected_output_vault,
            VaultError::PoolVaultMismatch
        );

        let token_mint_a = ctx.accounts.vault_state.token_mint_a;
        let token_mint_b = ctx.accounts.vault_state.token_mint_b;
        let bump = ctx.accounts.vault_state.bump;
        let seeds = &[
            b"vault".as_ref(),
            token_mint_a.as_ref(),
            token_mint_b.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];
        let cpi_accounts = cpi::accounts::SwapSingleV2 {
            payer: ctx.accounts.vault_state.to_account_info(),
            amm_config: ctx.accounts.amm_config.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            input_token_account: ctx.accounts.vault_token_a.to_account_info(),
            output_token_account: ctx.accounts.vault_token_b.to_account_info(),
            input_vault: ctx.accounts.input_vault.to_account_info(),
            output_vault: ctx.accounts.output_vault.to_account_info(),
            observation_state: ctx.accounts.observation_state.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
            memo_program: ctx.accounts.memo_program.to_account_info(),
            input_vault_mint: ctx.accounts.input_vault_mint.to_account_info(),
            output_vault_mint: ctx.accounts.output_vault_mint.to_account_info(),
        };
        let remaining_accounts = ctx.remaining_accounts.to_vec();
        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.clmm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        )
        .with_remaining_accounts(remaining_accounts);

        cpi::swap_v2(cpi_context, amount_in, minimum_amount_out, 0, true)?;
        msg!(
            "Vault swapped token A for token B: amount_in={}, minimum_amount_out={}",
            amount_in,
            minimum_amount_out
        );
        Ok(())
    }

    pub fn open_position<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, OpenPosition<'info>>,
        tick_lower_index: i32,
        tick_upper_index: i32,
        tick_array_lower_start_index: i32,
        tick_array_upper_start_index: i32,
        amount_0_max: u64,
        amount_1_max: u64,
        base_flag: bool,
    ) -> Result<()> {
        require!(
            ctx.accounts.vault_state.position_nft_mint == Pubkey::default(),
            VaultError::PositionAlreadyOpen
        );
        require!(
            tick_lower_index < tick_upper_index,
            VaultError::InvalidTickRange
        );
        require!(amount_0_max > 0 && amount_1_max > 0, VaultError::ZeroAmount);
        let (pool_mint_0, pool_mint_1) = {
            let pool = ctx.accounts.pool_state.load()?;
            (pool.token_mint_0, pool.token_mint_1)
        };
        let mint_a = ctx.accounts.vault_state.token_mint_a;
        let mint_b = ctx.accounts.vault_state.token_mint_b;
        require!(
            (pool_mint_0 == mint_a && pool_mint_1 == mint_b)
                || (pool_mint_0 == mint_b && pool_mint_1 == mint_a),
            VaultError::PoolMintMismatch
        );
        let (source_token_0, source_mint_0) = if pool_mint_0 == mint_a {
            (&ctx.accounts.vault_token_a, &ctx.accounts.vault_0_mint)
        } else {
            (&ctx.accounts.vault_token_b, &ctx.accounts.vault_0_mint)
        };
        let (source_token_1, source_mint_1) = if pool_mint_1 == mint_a {
            (&ctx.accounts.vault_token_a, &ctx.accounts.vault_1_mint)
        } else {
            (&ctx.accounts.vault_token_b, &ctx.accounts.vault_1_mint)
        };
        require_keys_eq!(
            source_token_0.mint,
            pool_mint_0,
            VaultError::PositionTokenAccountMismatch
        );
        require_keys_eq!(
            source_token_1.mint,
            pool_mint_1,
            VaultError::PositionTokenAccountMismatch
        );
        require_keys_eq!(
            source_token_0.owner,
            ctx.accounts.vault_state.key(),
            VaultError::PositionTokenAccountMismatch
        );
        require_keys_eq!(
            source_token_1.owner,
            ctx.accounts.vault_state.key(),
            VaultError::PositionTokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.token_account_0.mint,
            pool_mint_0,
            VaultError::PositionTokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.token_account_1.mint,
            pool_mint_1,
            VaultError::PositionTokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.token_account_0.owner,
            ctx.accounts.admin.key(),
            VaultError::PositionTokenAccountMismatch
        );
        require_keys_eq!(
            ctx.accounts.token_account_1.owner,
            ctx.accounts.admin.key(),
            VaultError::PositionTokenAccountMismatch
        );
        require!(
            source_token_0.amount >= amount_0_max,
            VaultError::InsufficientPositionBalance
        );
        require!(
            source_token_1.amount >= amount_1_max,
            VaultError::InsufficientPositionBalance
        );

        let token_program_0 = token_program_for_owner(
            source_mint_0.to_account_info().owner,
            &ctx.accounts.token_program,
            &ctx.accounts.token_program_2022,
        )?;
        let token_program_1 = token_program_for_owner(
            source_mint_1.to_account_info().owner,
            &ctx.accounts.token_program,
            &ctx.accounts.token_program_2022,
        )?;
        let destination_0_before = ctx.accounts.token_account_0.amount;
        let destination_1_before = ctx.accounts.token_account_1.amount;
        let token_mint_a = ctx.accounts.vault_state.token_mint_a;
        let token_mint_b = ctx.accounts.vault_state.token_mint_b;
        let bump = ctx.accounts.vault_state.bump;
        let seeds = &[
            b"vault".as_ref(),
            token_mint_a.as_ref(),
            token_mint_b.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program_0.clone(),
                TransferChecked {
                    from: source_token_0.to_account_info(),
                    mint: source_mint_0.to_account_info(),
                    to: ctx.accounts.token_account_0.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount_0_max,
            source_mint_0.decimals,
        )?;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program_1.clone(),
                TransferChecked {
                    from: source_token_1.to_account_info(),
                    mint: source_mint_1.to_account_info(),
                    to: ctx.accounts.token_account_1.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount_1_max,
            source_mint_1.decimals,
        )?;
        let cpi_accounts = cpi::accounts::OpenPositionV2 {
            payer: ctx.accounts.admin.to_account_info(),
            position_nft_owner: ctx.accounts.vault_state.to_account_info(),
            position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            metadata_account: ctx.accounts.metadata_account.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            protocol_position: ctx.accounts.protocol_position.to_account_info(),
            tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
            tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
            personal_position: ctx.accounts.personal_position.to_account_info(),
            token_account_0: ctx.accounts.token_account_0.to_account_info(),
            token_account_1: ctx.accounts.token_account_1.to_account_info(),
            token_vault_0: ctx.accounts.token_vault_0.to_account_info(),
            token_vault_1: ctx.accounts.token_vault_1.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            metadata_program: ctx.accounts.metadata_program.to_account_info(),
            token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
            vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
            vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
        };
        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.clmm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());
        cpi::open_position_v2(
            cpi_context,
            tick_lower_index,
            tick_upper_index,
            tick_array_lower_start_index,
            tick_array_upper_start_index,
            0,
            amount_0_max,
            amount_1_max,
            true,
            Some(base_flag),
        )?;
        ctx.accounts.token_account_0.reload()?;
        ctx.accounts.token_account_1.reload()?;
        let unused_0 = ctx
            .accounts
            .token_account_0
            .amount
            .checked_sub(destination_0_before)
            .ok_or(VaultError::PositionTokenAccountMismatch)?;
        let unused_1 = ctx
            .accounts
            .token_account_1
            .amount
            .checked_sub(destination_1_before)
            .ok_or(VaultError::PositionTokenAccountMismatch)?;
        if unused_0 > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    token_program_0,
                    TransferChecked {
                        from: ctx.accounts.token_account_0.to_account_info(),
                        mint: source_mint_0.to_account_info(),
                        to: source_token_0.to_account_info(),
                        authority: ctx.accounts.admin.to_account_info(),
                    },
                ),
                unused_0,
                source_mint_0.decimals,
            )?;
        }
        if unused_1 > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    token_program_1,
                    TransferChecked {
                        from: ctx.accounts.token_account_1.to_account_info(),
                        mint: source_mint_1.to_account_info(),
                        to: source_token_1.to_account_info(),
                        authority: ctx.accounts.admin.to_account_info(),
                    },
                ),
                unused_1,
                source_mint_1.decimals,
            )?;
        }

        let vault = &mut ctx.accounts.vault_state;
        vault.position_nft_mint = ctx.accounts.position_nft_mint.key();
        vault.position_pool = ctx.accounts.pool_state.key();
        vault.position_tick_lower = tick_lower_index;
        vault.position_tick_upper = tick_upper_index;
        msg!(
            "CLMM position opened: nft={}, ticks=[{}, {}], max0={}, max1={}",
            vault.position_nft_mint,
            tick_lower_index,
            tick_upper_index,
            amount_0_max,
            amount_1_max
        );
        Ok(())
    }

    pub fn collect_fees<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, ManagePosition<'info>>,
    ) -> Result<()> {
        validate_position_accounts(&ctx)?;
        let before_0 = ctx.accounts.recipient_token_account_0.amount;
        let before_1 = ctx.accounts.recipient_token_account_1.amount;
        invoke_position_decrease(&ctx, 0, 0, 0)?;
        ctx.accounts.recipient_token_account_0.reload()?;
        ctx.accounts.recipient_token_account_1.reload()?;
        msg!(
            "Position fees collected: token0={}, token1={}",
            ctx.accounts
                .recipient_token_account_0
                .amount
                .saturating_sub(before_0),
            ctx.accounts
                .recipient_token_account_1
                .amount
                .saturating_sub(before_1)
        );
        Ok(())
    }

    pub fn close_position<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, ManagePosition<'info>>,
        amount_0_min: u64,
        amount_1_min: u64,
    ) -> Result<()> {
        validate_position_accounts(&ctx)?;
        let before_0 = ctx.accounts.recipient_token_account_0.amount;
        let before_1 = ctx.accounts.recipient_token_account_1.amount;
        let liquidity = ctx.accounts.personal_position.liquidity;
        invoke_position_decrease(&ctx, liquidity, amount_0_min, amount_1_min)?;

        let token_mint_a = ctx.accounts.vault_state.token_mint_a;
        let token_mint_b = ctx.accounts.vault_state.token_mint_b;
        let bump = ctx.accounts.vault_state.bump;
        let seeds = &[
            b"vault".as_ref(),
            token_mint_a.as_ref(),
            token_mint_b.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];
        let close_accounts = cpi::accounts::ClosePosition {
            nft_owner: ctx.accounts.vault_state.to_account_info(),
            position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            personal_position: ctx.accounts.personal_position.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        cpi::close_position(CpiContext::new_with_signer(
            ctx.accounts.clmm_program.to_account_info(),
            close_accounts,
            signer_seeds,
        ))?;

        let vault = &mut ctx.accounts.vault_state;
        vault.position_nft_mint = Pubkey::default();
        vault.position_pool = Pubkey::default();
        vault.position_tick_lower = 0;
        vault.position_tick_upper = 0;
        ctx.accounts.recipient_token_account_0.reload()?;
        ctx.accounts.recipient_token_account_1.reload()?;
        msg!(
            "CLMM position closed: token0_returned={}, token1_returned={}",
            ctx.accounts
                .recipient_token_account_0
                .amount
                .saturating_sub(before_0),
            ctx.accounts
                .recipient_token_account_1
                .amount
                .saturating_sub(before_1)
        );
        Ok(())
    }
}

#[account]
pub struct VaultState {
    pub admin: Pubkey,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub vault_token_a: Pubkey,
    pub vault_token_b: Pubkey,
    pub position_nft_mint: Pubkey,
    pub position_pool: Pubkey,
    pub position_tick_lower: i32,
    pub position_tick_upper: i32,
    pub bump: u8,
}

impl VaultState {
    pub const LEN: usize = 8 + 32 * 7 + 4 * 2 + 1;
}

fn invoke_position_decrease<'info>(
    ctx: &Context<'_, '_, '_, 'info, ManagePosition<'info>>,
    liquidity: u128,
    amount_0_min: u64,
    amount_1_min: u64,
) -> Result<()> {
    let token_mint_a = ctx.accounts.vault_state.token_mint_a;
    let token_mint_b = ctx.accounts.vault_state.token_mint_b;
    let bump = ctx.accounts.vault_state.bump;
    let seeds = &[
        b"vault".as_ref(),
        token_mint_a.as_ref(),
        token_mint_b.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_accounts = cpi::accounts::DecreaseLiquidityV2 {
        nft_owner: ctx.accounts.vault_state.to_account_info(),
        nft_account: ctx.accounts.position_nft_account.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        protocol_position: ctx.accounts.protocol_position.to_account_info(),
        token_vault_0: ctx.accounts.token_vault_0.to_account_info(),
        token_vault_1: ctx.accounts.token_vault_1.to_account_info(),
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
        recipient_token_account_0: ctx.accounts.recipient_token_account_0.to_account_info(),
        recipient_token_account_1: ctx.accounts.recipient_token_account_1.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
        vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
    };
    let cpi_context = CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    )
    .with_remaining_accounts(ctx.remaining_accounts.to_vec());
    cpi::decrease_liquidity_v2(cpi_context, liquidity, amount_0_min, amount_1_min)
}

fn select_pool_vaults(
    pool_mint_0: Pubkey,
    pool_mint_1: Pubkey,
    pool_vault_0: Pubkey,
    pool_vault_1: Pubkey,
    mint_a: Pubkey,
    mint_b: Pubkey,
) -> Result<(Pubkey, Pubkey)> {
    if pool_mint_0 == mint_a && pool_mint_1 == mint_b {
        Ok((pool_vault_0, pool_vault_1))
    } else if pool_mint_0 == mint_b && pool_mint_1 == mint_a {
        Ok((pool_vault_1, pool_vault_0))
    } else {
        err!(VaultError::PoolMintMismatch)
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_mint_a: InterfaceAccount<'info, Mint>,
    pub token_mint_b: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [
            b"vault",
            token_mint_a.key().as_ref(),
            token_mint_b.key().as_ref()
        ],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init,
        payer = admin,
        seeds = [b"vault_tokens_a", vault_state.key().as_ref()],
        bump,
        token::mint = token_mint_a,
        token::authority = vault_state,
        token::token_program = token_program_a
    )]
    pub vault_token_a: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [b"vault_tokens_b", vault_state.key().as_ref()],
        bump,
        token::mint = token_mint_b,
        token::authority = vault_state,
        token::token_program = token_program_b
    )]
    pub vault_token_b: InterfaceAccount<'info, TokenAccount>,
    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [
            b"vault",
            vault_state.token_mint_a.as_ref(),
            vault_state.token_mint_b.as_ref()
        ],
        bump = vault_state.bump,
        constraint = vault_state.admin == admin.key() @ VaultError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(address = vault_state.token_mint_a)]
    pub token_mint_a: InterfaceAccount<'info, Mint>,
    #[account(address = vault_state.token_mint_b)]
    pub token_mint_b: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        address = vault_state.vault_token_a,
        token::mint = token_mint_a,
        token::authority = vault_state,
        token::token_program = token_program_a
    )]
    pub vault_token_a: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        address = vault_state.vault_token_b,
        token::mint = token_mint_b,
        token::authority = vault_state,
        token::token_program = token_program_b
    )]
    pub vault_token_b: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = token_mint_a,
        token::authority = admin,
        token::token_program = token_program_a
    )]
    pub admin_token_a: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = token_mint_b,
        token::authority = admin,
        token::token_program = token_program_b
    )]
    pub admin_token_b: InterfaceAccount<'info, TokenAccount>,
    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [
            b"vault",
            vault_state.token_mint_a.as_ref(),
            vault_state.token_mint_b.as_ref()
        ],
        bump = vault_state.bump,
        constraint = vault_state.admin == admin.key() @ VaultError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        address = vault_state.vault_token_a,
        token::mint = input_vault_mint,
        token::authority = vault_state
    )]
    pub vault_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = vault_state.vault_token_b,
        token::mint = output_vault_mint,
        token::authority = vault_state
    )]
    pub vault_token_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(address = pool_state.load()?.amm_config)]
    pub amm_config: Box<Account<'info, AmmConfig>>,
    #[account(
        mut,
        token::mint = input_vault_mint
    )]
    pub input_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = output_vault_mint
    )]
    pub output_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = pool_state.load()?.observation_key
    )]
    pub observation_state: AccountLoader<'info, ObservationState>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
    #[account(address = vault_state.token_mint_a)]
    pub input_vault_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault_state.token_mint_b)]
    pub output_vault_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: The CPI target is pinned to the official Raydium CLMM program ID.
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(
    tick_lower_index: i32,
    tick_upper_index: i32,
    tick_array_lower_start_index: i32,
    tick_array_upper_start_index: i32
)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint_a.as_ref(), vault_state.token_mint_b.as_ref()],
        bump = vault_state.bump,
        constraint = vault_state.admin == admin.key() @ VaultError::Unauthorized
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub position_nft_mint: Signer<'info>,
    /// CHECK: Created and initialized by the Raydium CLMM CPI.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: Metaplex metadata PDA is validated by Raydium.
    #[account(mut)]
    pub metadata_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,
    /// CHECK: Raydium protocol-position PDA is validated by the CPI.
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: Raydium tick-array PDA is validated by the CPI.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: Raydium tick-array PDA is validated by the CPI.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: Created and initialized by the Raydium CLMM CPI.
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,
    #[account(mut, address = vault_state.vault_token_a)]
    pub vault_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = vault_state.vault_token_b)]
    pub vault_token_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_account_0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_account_1: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault_0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault_1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub vault_0_mint: Box<InterfaceAccount<'info, Mint>>,
    pub vault_1_mint: Box<InterfaceAccount<'info, Mint>>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub metadata_program: Program<'info, Metadata>,
    pub token_program_2022: Program<'info, Token2022>,
    pub clmm_program: Program<'info, RaydiumClmm>,
}

#[derive(Accounts)]
pub struct ManagePosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint_a.as_ref(), vault_state.token_mint_b.as_ref()],
        bump = vault_state.bump,
        constraint = vault_state.admin == admin.key() @ VaultError::Unauthorized,
        constraint = vault_state.position_nft_mint != Pubkey::default() @ VaultError::NoOpenPosition
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        address = vault_state.position_nft_mint,
        mint::token_program = token_program
    )]
    pub position_nft_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = position_nft_mint,
        associated_token::authority = vault_state,
        constraint = position_nft_account.amount == 1,
        token::token_program = token_program
    )]
    pub position_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = vault_state.position_pool)]
    pub pool_state: AccountLoader<'info, PoolState>,
    /// CHECK: Raydium protocol-position PDA is checked in the handler.
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = personal_position.nft_mint == vault_state.position_nft_mint @ VaultError::PositionOwnerMismatch,
        constraint = personal_position.pool_id == vault_state.position_pool @ VaultError::PoolMintMismatch
    )]
    pub personal_position: Box<Account<'info, PersonalPositionState>>,
    #[account(mut)]
    pub tick_array_lower: AccountLoader<'info, TickArrayState>,
    #[account(mut)]
    pub tick_array_upper: AccountLoader<'info, TickArrayState>,
    #[account(mut, address = vault_state.vault_token_a)]
    pub vault_token_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = vault_state.vault_token_b)]
    pub vault_token_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault_0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub token_vault_1: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub recipient_token_account_0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub recipient_token_account_1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
    pub vault_0_mint: Box<InterfaceAccount<'info, Mint>>,
    pub vault_1_mint: Box<InterfaceAccount<'info, Mint>>,
    pub system_program: Program<'info, System>,
    pub clmm_program: Program<'info, RaydiumClmm>,
}

fn validate_position_accounts<'info>(
    ctx: &Context<'_, '_, '_, 'info, ManagePosition<'info>>,
) -> Result<()> {
    let pool = ctx.accounts.pool_state.load()?;
    let personal_position = &ctx.accounts.personal_position;
    require!(
        (pool.token_mint_0 == ctx.accounts.vault_state.token_mint_a
            && pool.token_mint_1 == ctx.accounts.vault_state.token_mint_b)
            || (pool.token_mint_0 == ctx.accounts.vault_state.token_mint_b
                && pool.token_mint_1 == ctx.accounts.vault_state.token_mint_a),
        VaultError::PoolMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.token_vault_0.key(),
        pool.token_vault_0,
        VaultError::PoolVaultMismatch
    );
    require_keys_eq!(
        ctx.accounts.token_vault_1.key(),
        pool.token_vault_1,
        VaultError::PoolVaultMismatch
    );
    let expected_account_0 = if pool.token_mint_0 == ctx.accounts.vault_state.token_mint_a {
        ctx.accounts.vault_token_a.key()
    } else {
        ctx.accounts.vault_token_b.key()
    };
    let expected_account_1 = if pool.token_mint_1 == ctx.accounts.vault_state.token_mint_a {
        ctx.accounts.vault_token_a.key()
    } else {
        ctx.accounts.vault_token_b.key()
    };
    require_keys_eq!(
        ctx.accounts.recipient_token_account_0.key(),
        expected_account_0,
        VaultError::PositionTokenAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.recipient_token_account_1.key(),
        expected_account_1,
        VaultError::PositionTokenAccountMismatch
    );
    let pool_id = ctx.accounts.pool_state.key();
    let lower = personal_position.tick_lower_index;
    let upper = personal_position.tick_upper_index;
    let protocol_position = Pubkey::find_program_address(
        &[
            POSITION_SEED.as_bytes(),
            pool_id.as_ref(),
            &lower.to_le_bytes(),
            &upper.to_le_bytes(),
        ],
        &raydium_clmm_cpi::id(),
    )
    .0;
    require_keys_eq!(
        ctx.accounts.protocol_position.key(),
        protocol_position,
        VaultError::PositionAccountMismatch
    );
    let tick_spacing = i32::from(pool.tick_spacing);
    let tick_array_width = tick_spacing * raydium_clmm_cpi::states::TICK_ARRAY_SIZE;
    let lower_start = lower.div_euclid(tick_array_width) * tick_array_width;
    let upper_start = upper.div_euclid(tick_array_width) * tick_array_width;
    let lower_array = Pubkey::find_program_address(
        &[
            TICK_ARRAY_SEED.as_bytes(),
            pool_id.as_ref(),
            &lower_start.to_be_bytes(),
        ],
        &raydium_clmm_cpi::id(),
    )
    .0;
    let upper_array = Pubkey::find_program_address(
        &[
            TICK_ARRAY_SEED.as_bytes(),
            pool_id.as_ref(),
            &upper_start.to_be_bytes(),
        ],
        &raydium_clmm_cpi::id(),
    )
    .0;
    require_keys_eq!(
        ctx.accounts.tick_array_lower.key(),
        lower_array,
        VaultError::PositionAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.tick_array_upper.key(),
        upper_array,
        VaultError::PositionAccountMismatch
    );
    Ok(())
}

fn token_program_for_owner<'info>(
    owner: &Pubkey,
    token_program: &Program<'info, Token>,
    token_program_2022: &Program<'info, Token2022>,
) -> Result<AccountInfo<'info>> {
    if *owner == token_program.key() {
        Ok(token_program.to_account_info())
    } else if *owner == token_program_2022.key() {
        Ok(token_program_2022.to_account_info())
    } else {
        err!(VaultError::UnsupportedTokenProgram)
    }
}

#[error_code]
pub enum VaultError {
    #[msg("The administrator signature does not match the vault administrator.")]
    Unauthorized,
    #[msg("Token A and token B must be different mints.")]
    IdenticalMints,
    #[msg("The amount must be greater than zero.")]
    ZeroAmount,
    #[msg("The minimum output amount must be greater than zero.")]
    InvalidMinimumOutput,
    #[msg("The vault does not have enough token A for this swap.")]
    InsufficientInputBalance,
    #[msg("The Raydium pool does not contain this vault's token pair.")]
    PoolMintMismatch,
    #[msg("The supplied pool vault accounts do not match the selected Raydium pool.")]
    PoolVaultMismatch,
    #[msg("A vault position is already open.")]
    PositionAlreadyOpen,
    #[msg("No CLMM position is currently open.")]
    NoOpenPosition,
    #[msg("The lower tick must be below the upper tick.")]
    InvalidTickRange,
    #[msg("The supplied token accounts do not match the vault's pool token order.")]
    PositionTokenAccountMismatch,
    #[msg("The supplied NFT or position accounts do not belong to this vault position.")]
    PositionOwnerMismatch,
    #[msg("A Raydium position, protocol-position or tick-array account does not match.")]
    PositionAccountMismatch,
    #[msg("The vault does not have enough tokens for the position limits.")]
    InsufficientPositionBalance,
    #[msg("The position mint uses an unsupported token program.")]
    UnsupportedTokenProgram,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_pool_vaults_when_token_a_is_mint_zero() {
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        let vault_0 = Pubkey::new_unique();
        let vault_1 = Pubkey::new_unique();

        let result = select_pool_vaults(mint_a, mint_b, vault_0, vault_1, mint_a, mint_b).unwrap();

        assert_eq!(result, (vault_0, vault_1));
    }

    #[test]
    fn selects_pool_vaults_when_token_a_is_mint_one() {
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        let vault_0 = Pubkey::new_unique();
        let vault_1 = Pubkey::new_unique();

        let result = select_pool_vaults(mint_b, mint_a, vault_0, vault_1, mint_a, mint_b).unwrap();

        assert_eq!(result, (vault_1, vault_0));
    }

    #[test]
    fn rejects_a_pool_with_a_different_pair() {
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();

        let result = select_pool_vaults(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            mint_a,
            mint_b,
        );

        assert!(result.is_err());
    }
}
