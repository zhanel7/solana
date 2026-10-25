# Week 13 — Vault CLMM position

The vault can open a Raydium CLMM position, collect its accrued fees, and
withdraw all position liquidity. The position NFT is owned by the vault-state
PDA; only the configured administrator can ask the vault program to perform
these CPI operations. The administrator is the transaction fee payer, not the
owner of the position NFT.

`open` selects a range around the live pool price (±5% by default), rounds the
limits to valid CLMM ticks, quotes the amounts needed for the configured
maximums, and uses the limiting token as the liquidity base. This avoids
Raydium's `PriceSlippageCheck` when equal token caps would require more of one
token than the other cap permits. Raydium's current `open_position_v2` CPI
also uses its signer `payer` as the transfer authority for both input token
accounts. To retain vault custody, the vault program signs transfers of only
the configured maximums into the admin's token accounts, invokes Raydium, then
returns every unused token in the same atomic instruction. These temporary
balances cannot be withdrawn separately. `close`
calculates the expected principal amounts at the current price and sets
minimums 1% below that quote by default. Override these limits only when you
understand the effect:

- `RANGE_BPS` and `POSITION_MAX_A_RAW` / `POSITION_MAX_B_RAW` for opening.
- `CLOSE_SLIPPAGE_BPS` or `CLOSE_MIN_0_RAW` / `CLOSE_MIN_1_RAW` for closing.
- `AMOUNT_A_RAW` / `AMOUNT_B_RAW` for funding the vault.

The position is not a share-yield system: while liquidity remains in the CLMM
position, this exercise does not let users withdraw those deposited tokens.
Close the position before any future withdrawal flow.

## Addresses used by the devnet configuration

These are the pool and mint addresses already configured from the previous
week's project; the client verifies the pool program, mint pair, and pool vault
addresses before position operations.

| Account | Address |
| --- | --- |
| Week-13 program ID | `DUKMeZre3vZB24zc16oWrRaDcfpqHCdgvF1fPBqEFwoh` |
| Raydium CLMM program | `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH` |
| CLMM pool | `CJHjMSha5MJGXguFz8i2D8uyErvYxGoqddUJYoWS4LfM` |
| Token A mint | `DZo9sTg7DZHWmYeksnd2ToswZQeodoerDhfL2QKijLM` |
| Token B mint | `2gAkMcGpnRHQC19xKrZNPTHgpZsYnbwBaC4U2Xyw9HwR` |
| Pool token A vault | `A8mF25PrLcMJYPYuiYyvYQ8pth2J6GC6oZdt4zt5DVAD` |
| Pool token B vault | `CvF7oQot5nuMbPNteEP7Vh52ocgBGj4RNPsB6fPGTWhC` |

The admin keypair is read from `ANCHOR_WALLET`, or otherwise from
`~/.config/solana/id.json`. Do not paste or commit private keys. The ignored
`target/deploy/simple_vault-keypair.json` determines this workspace's program
ID; retain it and back it up securely.

## Build and deploy

Run these commands from this directory. Use a devnet wallet that has enough
SOL for deployment, rent, and transaction fees. This is a new program ID, so
the deployment needs its own program-account rent (the earlier week-12 deploy
does not cover it). Check the balance first; plan for roughly 2.3 SOL or more
before deployment and vault initialization. Both configured mints are
6-decimal devnet SPL tokens. The default vault funding is 10 of each; if
following the sample trader funding too, the admin needs 15 of each in total.
Reduce the configured funding or trader transfer amount if the wallet has less.

```bash
cd /home/docker_user/raydium-sdk-V2-demo/week-13
npm install
solana config set --url devnet
solana config set --keypair ~/.config/solana/id.json
solana balance
anchor keys sync
npm run build
npm run typecheck
anchor deploy --provider.cluster devnet
```

Stop if a command fails. In particular, an airdrop rate-limit error is not
proof that funds arrived: check `solana balance` and use the official
[Solana Devnet Faucet](https://faucet.solana.com/) if necessary. The program
deployment keypair must not be deleted or regenerated after syncing the ID.

## Open, trade, collect, and close

Initialize and fund the separate week-13 vault. The defaults deposit 10 tokens
of each mint and cap the position at 2 tokens of each mint. Adjust the raw
amounts only after checking the admin wallet's balances.

```bash
npm run position -- init
npm run position -- fund
npm run position -- status
npm run position -- open
npm run position -- status
```

For evidence of fee accrual, make several swaps through the position's price
range from a **different wallet** while the position is open. The trader wallet
must be funded with devnet SOL and the input token. Do not point
`TRADER_WALLET` at the administrator keypair:

```bash
if [ ! -f ~/.config/solana/week13-trader.json ]; then
  solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/week13-trader.json
fi
solana address --keypair ~/.config/solana/week13-trader.json
# Send devnet SOL to the printed address using the faucet.
solana airdrop 1 "$(solana address --keypair ~/.config/solana/week13-trader.json)" --url devnet
# Send small amounts of both configured SPL tokens from the admin wallet:
spl-token transfer DZo9sTg7DZHWmYeksnd2ToswZQeodoerDhfL2QKijLM 5 "$(solana address --keypair ~/.config/solana/week13-trader.json)" --fund-recipient
spl-token transfer 2gAkMcGpnRHQC19xKrZNPTHgpZsYnbwBaC4U2Xyw9HwR 5 "$(solana address --keypair ~/.config/solana/week13-trader.json)" --fund-recipient

export TRADER_WALLET="$HOME/.config/solana/week13-trader.json"
TRADER_INPUT_RAW=5000000 npm run trader -- A
TRADER_INPUT_RAW=5000000 npm run trader -- B
```

Repeat either or both directions if needed. These are real devnet swaps and
each submits a transaction with 1% quote slippage tolerance by default. The
example transfers and swaps 5 tokens per direction; do not repeat a direction
without replenishing its trader balance. The script reports its Explorer link
and the before/after spot price. Ensure trades occur while the price is inside
the selected range; swaps outside the position's active range do not earn its
fees. Use meaningful volume for the pool and position size so token-unit
rounding does not reduce the collected fee to zero.

Collect and close from the admin wallet:

```bash
npm run position -- collect
npm run position -- close
npm run position -- status
```

`collect` reports the vault token balance deltas and transaction link.
`close` reports its computed token0/token1 minimums, then reports the returned
vault token deltas and transaction link. Set `CLOSE_SLIPPAGE_BPS` to adjust
the default 1% tolerance. The optional `CLOSE_MIN_0_RAW` and
`CLOSE_MIN_1_RAW` override the computed minimums in **pool token order**, not
the config's A/B order.

To demonstrate rebalancing, open a new position around the new current price
after the existing one has been fully closed. For a full second-cycle
demonstration, open a position, move the price outside the printed range with
small token-A-input swaps, close that out-of-range position, then open a new
position around the new price. Selling token A moves the configured B-per-A
price down. Check the current spot price without submitting a transaction:

```bash
export TRADER_WALLET="$HOME/.config/solana/week13-trader-safe.json"
npm run trader -- price
npm run position -- open
```

Record the new position's printed price range. If the current price is inside
it, move downward in small, manually checked increments while that position is
open:

```bash
TRADER_INPUT_RAW=100000 npm run trader -- A
npm run trader -- price
```

`100000` raw units is `0.1` token A. Repeat only after reviewing the updated
price and trader balance; stop once price is below the printed lower boundary.
Do not use an automatic loop or a large unverified amount: each swap is a real
devnet transaction and moves the pool price. Then, from the admin wallet,
close the now-out-of-range position and open its replacement:

```bash
unset TRADER_WALLET
npm run position -- close
npm run position -- open
npm run position -- status
```

The new `open` recalculates its ±5% range around the new spot price. Save the
swap, close, and replacement-open transaction links and report the old/new
ranges and prices in the evidence section.

## Submission evidence

The program deployment and vault initialization/funding have been confirmed
on devnet. Position transactions still need to be run; fill in their evidence
only after the corresponding commands confirm successfully. Do not reuse
week-12 transaction links.

- Program deployment:
  [Solana Explorer](https://explorer.solana.com/tx/45Ew2rMVwwMhjdg3cq4rqW4xFzwHeHMK9wYsJjtVz4CCJhjZHmUqFz5yvomMo9JqZTk2L8EZioCF18FiFcAYYMvG?cluster=devnet)
- Vault initialization:
  [Solana Explorer](https://explorer.solana.com/tx/Ma8itYuviPuG1JsUFGGfeWUzLigHq3MvqPQD4npojpFenraVQoaW8BwbatdR3fYYY3ChmovL3GAqAyD3p27nQgg?cluster=devnet)
- Vault funding (10 tokens A and 10 tokens B):
  [Solana Explorer](https://explorer.solana.com/tx/tKv6VXV4xbmc4xWA6oXXumaQt6gqhVuTJkSWftC2NX1mHWihyMtRL7VgRHs6HPsJ4H8wreZw9D1xtfkS5L353f1?cluster=devnet)
- Position open (ticks `[-540, 420]`, approximately ±5% around the pool price):
  [Solana Explorer](https://explorer.solana.com/tx/HdYgZUN3fki6jUveeAZ1EHSwDcfGTvmMw3f6PtePXtgdi45TCyMAaN9yEY4iLET23od8qdGZK82hmyDi7LDYpm1?cluster=devnet)
  Position NFT: `HLLNh51mJwRcuTTUsKXSwHvLqvKBU7h1AE64TY9mEAPA`.
  Deposited: `1.681481` token0 and `2` token1. Remaining vault balances
  reported by `status`: `8.318519` token A and `8` token B.
- External trader swap A:
  [Solana Explorer](https://explorer.solana.com/tx/56UAkjNaXLRBycvs1VeYqKby6k6B45U9kPLtyUe3nYZjgBWNjbYRJtFgekcQ4EUCLE2ZiKB8UunFJMqpJXNcSV9P?cluster=devnet).
  The script reported spot price `0.9982466942786467` before and after its
  swap.
- External trader swap B:
  [Solana Explorer](https://explorer.solana.com/tx/3XSUL24WfgSmkiqiL7QzSFmDXsug4rM7XgUUXiXddXEvW5x99mATL8rzTwAnTvUM81U8Wr9vxTKjRKhesBfpS1z1?cluster=devnet).
  The script reported spot price `0.9940272202942437` before and after its
  swap.
- Fee collection:
  [Solana Explorer](https://explorer.solana.com/tx/24SCsqgFqgMNFvGb3kgPfV8oqgoWfJh57gCU2xsvfvexUBr31BmVDMKXfDhAzyb6zejVroWkDhPbSxdj6cKy2nss?cluster=devnet).
  Vault deltas: `346` raw token A and `346` raw token B (each mint has 6
  decimals; `0.000346` of each).
- Position is confirmed closed by `status` (`No open CLMM position`).
  Final vault balances: `9.999707` token A and `10.000982` token B. The
  close-command deltas were `+1.680842` token A and `+2.000636` token B
  (`1,680,842` and `2,000,636` raw units).
  [Solana Explorer](https://explorer.solana.com/tx/mb5GyjzrTHkxkUPFYXvDeUHpf31KspY3fkSgzrUi8uWJpp3b7WMBpgmWZXfyvtRCfiQMrNRJR6qnZkB8j5vLcQZ?cluster=devnet)
- Rebalance after moving the pool price outside the old range and opening a
  new position: pending. The two recorded trader swaps did not move price
  outside the original approximately ±5% range, so this step is not yet
  demonstrated.

## Self-check

- **Why does the token ratio depend on the current price inside the range?**
  CLMM liquidity is concentrated between two price boundaries. At different
  points in that interval, the formulas require different amounts of token A
  and token B to represent the same liquidity.
- **What happens above the upper boundary?** The position becomes entirely
  token B (for the configured A/B price orientation), stops earning swap fees
  until price re-enters the interval, and cannot add more active liquidity.
- **Why rebalance, and who does it?** The administrator closes the out-of-range
  position and opens another around the new price so the vault can provide
  active liquidity again. This exercise makes that an explicit admin action.
