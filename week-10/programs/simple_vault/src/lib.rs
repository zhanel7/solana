use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};

declare_id!("5F8LDWfwGdDS997rnZVwLrH4XTjphrdjSpZRJe3vT5dn");

#[program]
pub mod simple_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.admin = ctx.accounts.admin.key();
        vault_state.token_mint = ctx.accounts.token_mint.key();
        vault_state.vault_token_account = ctx.accounts.vault_token_account.key();
        vault_state.share_mint = ctx.accounts.share_mint.key();
        vault_state.total_shares = 0;
        vault_state.paused = false;
        vault_state.bump = ctx.bumps.vault_state;
        Ok(())
    }

    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        let vault_state = &ctx.accounts.vault_state;
        require!(!vault_state.paused, VaultError::VaultPaused);

        let user_card = &mut ctx.accounts.user_card;
        user_card.vault = vault_state.key();
        user_card.owner = ctx.accounts.user.key();
        user_card.shares = 0;
        user_card.created_at = Clock::get()?.unix_timestamp;
        user_card.bump = ctx.bumps.user_card;
        Ok(())
    }

    // Инструкция депозита (Неделя 9)
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let vault_state = &mut ctx.accounts.vault_state;
        require!(!vault_state.paused, VaultError::VaultPaused);

        let vault_balance = ctx.accounts.vault_token_account.amount;

        let shares_to_mint = if vault_state.total_shares == 0 || vault_balance == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(vault_state.total_shares as u128)
                .unwrap()
                .checked_div(vault_balance as u128)
                .unwrap() as u64
        };

        require!(shares_to_mint > 0, VaultError::ZeroSharesMinted);

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        let token_mint_key = vault_state.token_mint;
        let bump = vault_state.bump;
        let seeds = &[b"vault", token_mint_key.as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        let mint_cpi_accounts = MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.user_share_account.to_account_info(),
            authority: vault_state.to_account_info(),
        };
        let mint_cpi_program = ctx.accounts.token_program.to_account_info();
        let mint_cpi_ctx = CpiContext::new_with_signer(mint_cpi_program, mint_cpi_accounts, signer_seeds);
        token::mint_to(mint_cpi_ctx, shares_to_mint)?;

        vault_state.total_shares = vault_state.total_shares.checked_add(shares_to_mint).unwrap();
        
        let user_card = &mut ctx.accounts.user_card;
        user_card.shares = user_card.shares.checked_add(shares_to_mint).unwrap();

        msg!("Депозит успешно выполнен! Выпущено share-токенов: {}", shares_to_mint);
        Ok(())
    }

    // Инструкция вывода средств (Неделя 10)
    pub fn withdraw(ctx: Context<Withdraw>, share_amount: u64) -> Result<()> {
        require!(share_amount > 0, VaultError::ZeroAmount);

        let vault_state = &mut ctx.accounts.vault_state;
        require!(!vault_state.paused, VaultError::VaultPaused);

        let user_card = &mut ctx.accounts.user_card;
        require!(user_card.shares >= share_amount, VaultError::InsufficientShares);

        let vault_token_balance = ctx.accounts.vault_token_account.amount;
        let total_shares = vault_state.total_shares;

        let tokens_to_return = (share_amount as u128)
            .checked_mul(vault_token_balance as u128)
            .unwrap()
            .checked_div(total_shares as u128)
            .unwrap() as u64;

        require!(tokens_to_return > 0, VaultError::ZeroTokensToReturn);

        // Шаг А: Сжигание долей пользователя (подписывает пользователь)
        let burn_cpi_accounts = Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.user_share_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let burn_cpi_ctx = CpiContext::new(cpi_program.clone(), burn_cpi_accounts);
        token::burn(burn_cpi_ctx, share_amount)?;

        // Шаг Б: Перевод базовых токенов из Vault пользователю (подписывает программа от имени PDA vault)
        let token_mint_key = vault_state.token_mint;
        let bump = vault_state.bump;
        let seeds = &[b"vault", token_mint_key.as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        let transfer_cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: vault_state.to_account_info(),
        };
        let transfer_cpi_ctx = CpiContext::new_with_signer(cpi_program, transfer_cpi_accounts, signer_seeds);
        token::transfer(transfer_cpi_ctx, tokens_to_return)?;

        vault_state.total_shares = vault_state.total_shares.checked_sub(share_amount).unwrap();
        user_card.shares = user_card.shares.checked_sub(share_amount).unwrap();

        msg!("Успешный вывод! Возвращено токенов: {}, сожжено долей: {}", tokens_to_return, share_amount);
        Ok(())
    }

    pub fn close_user_card(_ctx: Context<CloseUserCard>) -> Result<()> {
        Ok(())
    }
}

#[account]
pub struct VaultState {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub share_mint: Pubkey,
    pub total_shares: u64,
    pub paused: bool,
    pub bump: u8,
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1;
}

#[account]
pub struct UserCard {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens", vault_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = vault_state,
        seeds = [b"share_mint", vault_state.key().as_ref()],
        bump
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    #[account(
        init,
        payer = user,
        space = UserCard::LEN,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_card: Account<'info, UserCard>,
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"share_mint", vault_state.key().as_ref()],
        bump
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump
    )]
    pub user_card: Account<'info, UserCard>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_share_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"share_mint", vault_state.key().as_ref()],
        bump
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump
    )]
    pub user_card: Account<'info, UserCard>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_share_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseUserCard<'info> {
    #[account(
        mut,
        close = user,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump
    )]
    pub user_card: Account<'info, UserCard>,
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[error_code]
pub enum VaultError {
    #[msg("Vault is currently paused by admin.")]
    VaultPaused,
    #[msg("Cannot deposit zero tokens.")]
    ZeroAmount,
    #[msg("Calculated shares to mint is zero.")]
    ZeroSharesMinted,
    #[msg("Insufficient shares to withdraw.")]
    InsufficientShares,
    #[msg("Calculated tokens to return is zero.")]
    ZeroTokensToReturn,
}