# Week 12 — Swap from the vault through Raydium CLMM

The Anchor program keeps two SPL token accounts owned by the vault PDA. Only
the configured admin can fund the vault and request an exact-input swap of
token A for token B. The program signs the Raydium CLMM `swap_v2` CPI with the
vault PDA; the admin signs only as transaction authority and fee payer.

The official Raydium CPI adapter is used from
[raydium-cpi, Anchor 0.31.1 branch](https://github.com/raydium-io/raydium-cpi/tree/anchor-0.31.1),
following the CLMM examples in
[raydium-cpi-example](https://github.com/raydium-io/raydium-cpi-example/tree/anchor-0.31.0).
The swap uses exact input and passes `minimum_amount_out` to Raydium. The SDK
client simulates the CLMM swap first and applies the configured slippage
tolerance (1% by default).

## Setup and devnet run

Commands below use the existing week-11 devnet pool and the wallet at
`~/.config/solana/id.json`. The wallet needs devnet SOL and token A. At the
time this config was prepared, the configured wallet had enough tokens A and
B; `fund` only transfers 10 token A.

1. Install Node dependencies and select the existing devnet wallet:

   ```bash
   cd /home/docker_user/raydium-sdk-V2-demo/week-12
   npm install
   solana config set --url devnet
   solana config set --keypair ~/.config/solana/id.json
   ```

   Request devnet SOL and verify the new balance as a separate step:

   ```bash
   solana airdrop 2 && solana balance
   ```

   The deploy error `insufficient funds for spend (1.84686956 SOL) + fee
   (0.001915 SOL)` means this wallet needs more devnet SOL before deployment.
   The pasted run had `1.78130384 SOL`, so it was short by at least
   `0.06748072 SOL` for deployment alone, before initialization and transaction
   fees. Aim for at least `2.5 SOL` to leave room for the remaining devnet
   transactions. If the airdrop command fails or reports a rate limit, stop
   here: the `&&` prevents the balance check from running, and do not run
   `anchor deploy` or any vault write command. Retry later or request funds
   from the official [Solana Devnet Faucet](https://faucet.solana.com/), then
   verify with `solana balance`.

2. A program keypair is already present in `target/deploy` in this workspace.
   Keep it: it determines the program ID `9ThMT3LeCTCmzX5npavcdsbqDSSPGYuL93E7cctpqYgU`.
   Sync the ID before rebuilding:

   ```bash
   anchor keys sync
   ```

   Do not delete or replace `target/deploy/simple_vault-keypair.json`; it is
   ignored by Git because it contains a private key. Back it up securely.

3. Build and deploy the devnet program:

   ```bash
   npm run build && anchor deploy --provider.cluster devnet
   ```

   Do not run the vault commands if build or deploy failed. A failed deploy
   leaves the program absent from devnet; client writes will then fail because
   the program account does not exist.

4. The addresses, mint decimals, and default amounts from week 11 are
   already in [config.json](./config.json). The configuration points at the
   existing devnet pool and checks its mint, program, and pool-vault accounts
   before quoting or submitting a swap. Amounts are `10` token A to fund and
   `1` token A to swap (each token has 6 decimals). Check the quote before
   sending the swap. Optional overrides are `AMOUNT_A_RAW`, `AMOUNT_B_RAW`,
   `AMOUNT_IN_RAW`, and `SLIPPAGE_BPS`.

   Addresses found in the week-11 pool state and verified on devnet:

   | Account | Address |
   | --- | --- |
   | Program ID | `9ThMT3LeCTCmzX5npavcdsbqDSSPGYuL93E7cctpqYgU` |
   | Token A mint | `DZo9sTg7DZHWmYeksnd2ToswZQeodoerDhfL2QKijLM` |
   | Token B mint | `2gAkMcGpnRHQC19xKrZNPTHgpZsYnbwBaC4U2Xyw9HwR` |
   | Raydium CLMM pool | `CJHjMSha5MJGXguFz8i2D8uyErvYxGoqddUJYoWS4LfM` |
   | Raydium pool vault A | `A8mF25PrLcMJYPYuiYyvYQ8pth2J6GC6oZdt4zt5DVAD` |
   | Raydium pool vault B | `CvF7oQot5nuMbPNteEP7Vh52ocgBGj4RNPsB6fPGTWhC` |
   | Vault state PDA | `HG9g1TR95Hqg9fWzF9PkRZXeQpoVqbtkQ4x6HgyQ5Uh4` |
   | Vault token A PDA | `Cnoe7g9DJK6nEdxRfoBZonGHi2fpes2QYhgA52GnEGqR` |
   | Vault token B PDA | `yCMpapoqB2dTvPFAorZBnsoEJqZ4fTznW3E3tawRw6x` |

5. Initialize and fund the vault. These commands submit devnet transactions:

   ```bash
   npm run swap -- init && npm run swap -- fund
   ```

6. Calculate the expected output without sending a swap, then perform the
   swap with 1% slippage tolerance:

   ```bash
   npm run swap -- quote && npm run swap -- swap
   ```

   The successful run prints its Solana Explorer link and the pool's spot
   price before and after the transaction.

7. Demonstrate slippage protection. This intentionally submits a transaction
   whose minimum output is one base unit greater than the SDK quote (not the
   normal 1% tolerance). It should fail on-chain and incurs a devnet
   transaction fee:

   ```bash
   npm run swap -- slippage-reject
   ```

   The script prints the failed transaction's Explorer link only if the
   confirmed transaction identifies a minimum-output/slippage rejection
   (including Raydium's `Custom: 6018` error). The confirmation RPC can report
   this expected on-chain failure as an instruction error; the script still
   retrieves the transaction and prints its signature. Do not run this command
   against a funded mainnet wallet.

   All four transaction commands can be run directly from the `week-12`
   directory; no address exports or manual address lookup are required.

## Evidence to submit

Verified devnet transactions:

- Successful swap: [Solana Explorer](https://explorer.solana.com/tx/rcNQE1TtpE1p7XkQxpLzZYCZiyY9ENkBrDWipn46g2MJmmFizMW9RS9NfwQTXNxhb3Lg4XLqeFsGtSFeEthzj5r?cluster=devnet)
- Slippage-rejected swap (`Custom: 6018`, TooLittleOutputReceived):
  [Solana Explorer](https://explorer.solana.com/tx/4qfBX6bwt3RVvfgDbVaaEisr1mjMKcteaTxzxS3AMqr6VHkBszFbyL2Fs1S23nYXFwEwVTQbv98xkvsGMAeK6kMr?cluster=devnet)
- Swap input/output: `1` token A for `0.997062` token B.
- Latest swap spot price: `0.9991227702` to `0.9982466943` token B per
  token A, a change of `-0.087685%`.

The failed slippage transaction requested `0.996188` token B while Raydium's
calculation produced `0.996187` token B, so the transaction was rejected as
intended. The failed transaction changed no pool balances.

## Self-check

- **What is slippage and how is it limited?** It is the difference between the
  expected and executed exchange rate while a transaction is pending. The SDK
  computes a quote, lowers it by the chosen tolerance (1% by default), and the
  Raydium CPI rejects the transaction if the actual output is below
  `minimum_amount_out`.
- **Why does low liquidity move the price more?** An input of a given size
  consumes a larger share of the available liquidity, so the CLMM crosses
  more ticks and moves its marginal price farther.
- **Why does the program sign the swap?** The input tokens belong to a PDA
  controlled by the vault program. The administrator has no private key for
  that address; the program can authorize only the CPI logic it implements by
  signing with the PDA seeds.