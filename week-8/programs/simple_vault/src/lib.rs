use anchor_lang::prelude::*;

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
        vault_state.paused = false; // Изначально vault не на паузе
        vault_state.bump = ctx.bumps.vault_state;
        Ok(())
    }

    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        let vault_state = &ctx.accounts.vault_state;
        
        // Задание 3: Проверяем, не поставлен ли vault на паузу
        require!(!vault_state.paused, VaultError::VaultPaused);

        let user_card = &mut ctx.accounts.user_card;
        user_card.vault = vault_state.key();
        user_card.owner = ctx.accounts.user.key();
        // Задание 1: Записываем текущую временную метку (timestamp)
        user_card.created_at = Clock::get()?.unix_timestamp;
        user_card.bump = ctx.bumps.user_card;
        Ok(())
    }

    // Задание 2: Инструкция для закрытия карточки пользователя и возврата ренты
    pub fn close_user_card(_ctx: Context<CloseUserCard>) -> Result<()> {
        // Рента автоматически возвращается владельцу (user), так как указано #[account(mut, close = user)]
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
    pub paused: bool, // Флаг паузы
    pub bump: u8,
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1;
}

#[account]
pub struct UserCard {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub created_at: i64, // Поле с временем создания
    pub bump: u8,
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
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
    pub token_mint: SystemAccount<'info>,
    /// CHECK: safe
    #[account(mut)]
    pub vault_token_account: SystemAccount<'info>,
    /// CHECK: safe
    #[account(mut)]
    pub share_mint: SystemAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
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

// Контекст для закрытия карточки (Задание 2)
#[derive(Accounts)]
pub struct CloseUserCard<'info> {
    #[account(
        mut,
        close = user, // Закрывает аккаунт и переводит оставшуюся ренту на кошелек пользователя
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
}