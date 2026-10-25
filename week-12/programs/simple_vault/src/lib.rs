use anchor_lang::prelude::*;
use anchor_spl::{
    memo::Memo,
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use raydium_clmm_cpi::{
    cpi,
    states::{AmmConfig, ObservationState, PoolState},
};

declare_id!("9ThMT3LeCTCmzX5npavcdsbqDSSPGYuL93E7cctpqYgU");

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
}

#[account]
pub struct VaultState {
    pub admin: Pubkey,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub vault_token_a: Pubkey,
    pub vault_token_b: Pubkey,
    pub bump: u8,
}

impl VaultState {
    pub const LEN: usize = 8 + 32 * 5 + 1;
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
