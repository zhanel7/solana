use anchor_lang::prelude::*;

declare_id!("Gu7xt63mKXHKhs5vrnkGo44E5fkGCDw2upWwjbtBeJSo");

#[program]
pub mod stablecoin_payment {
    use super::*;

    pub fn create_invoice(
        ctx: Context<CreateInvoice>, 
        amount: u64, 
        order_id: String
    ) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        invoice.merchant = ctx.accounts.merchant.key();
        invoice.amount = amount;
        invoice.order_id = order_id;
        invoice.is_paid = false;

        msg!("Invoice Created: Order ID = {}, Amount = {} USDC units", invoice.order_id, invoice.amount);
        Ok(())
    }

    pub fn process_payment(ctx: Context<ProcessPayment>) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        invoice.is_paid = true;
        msg!("Payment Received! Status updated to Paid.");
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(amount: u64, order_id: String)]
pub struct CreateInvoice<'info> {
    #[account(
        init,
        payer = merchant,
        space = 8 + 32 + 8 + (4 + 32) + 1,
        seeds = [b"invoice", merchant.key().as_ref(), order_id.as_bytes()],
        bump
    )]
    pub invoice: Account<'info, InvoiceState>,
    #[account(mut)]
    pub merchant: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessPayment<'info> {
    #[account(mut)]
    pub invoice: Account<'info, InvoiceState>,
    pub payer: Signer<'info>,
}

#[account]
pub struct InvoiceState {
    pub merchant: Pubkey,
    pub amount: u64,
    pub order_id: String,
    pub is_paid: bool,
}
