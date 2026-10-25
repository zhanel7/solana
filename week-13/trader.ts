import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  getPdaExBitmapAccount,
  Raydium,
  swapInternal,
  TickArrayBitmapExtensionLayout,
  TxVersion,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import config from "./config.json";

const COMMITMENT = "confirmed";

function readKeypair(filePath: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function run(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== "A" && direction !== "B" && direction !== "price") {
    throw new Error("Usage: npm run trader -- <A|B|price>");
  }
  const defaultWalletPath = path.join(os.homedir(), ".config/solana/id.json");
  const traderPath =
    process.env.TRADER_WALLET ??
    (direction === "price"
      ? process.env.ANCHOR_WALLET ?? defaultWalletPath
      : undefined);
  if (!traderPath) {
    throw new Error("Set TRADER_WALLET to a different wallet's keypair path.");
  }
  const wallet = readKeypair(path.resolve(traderPath));
  const adminPath = process.env.ANCHOR_WALLET ?? defaultWalletPath;
  if (
    direction !== "price" &&
    fs.existsSync(adminPath) &&
    readKeypair(adminPath).publicKey.equals(wallet.publicKey)
  ) {
    throw new Error("TRADER_WALLET must be different from the vault administrator wallet.");
  }
  const amountIn = process.env.TRADER_INPUT_RAW;
  if (direction !== "price" && (!amountIn || !/^[1-9]\d*$/.test(amountIn))) {
    throw new Error("TRADER_INPUT_RAW must be a positive integer in token base units.");
  }
  const slippageBps = Number(process.env.TRADER_SLIPPAGE_BPS ?? 100);
  if (
    direction !== "price" &&
    (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000)
  ) {
    throw new Error("TRADER_SLIPPAGE_BPS must be an integer from 0 through 9999.");
  }

  const connection = new Connection(clusterApiUrl("devnet"), COMMITMENT);
  const raydium = await Raydium.load({
    owner: wallet,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
  });
  const poolId = new PublicKey(config.poolId);
  const initial = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());
  const poolInfo = initial.poolInfo;
  if (direction === "price") {
    console.log(`Pool: ${poolId.toBase58()}`);
    console.log(`Spot price (token B per token A): ${initial.computePoolInfo.currentPrice}`);
    return;
  }
  const configuredMint = new PublicKey(
    direction === "A" ? config.tokenA.mint : config.tokenB.mint,
  );
  const poolMintA = new PublicKey(poolInfo.mintA.address);
  const poolMintB = new PublicKey(poolInfo.mintB.address);
  if (!configuredMint.equals(poolMintA) && !configuredMint.equals(poolMintB)) {
    throw new Error(`Token ${direction} is not in the configured CLMM pool.`);
  }
  if (!amountIn) {
    throw new Error("TRADER_INPUT_RAW must be set for swap actions.");
  }
  const inputMint = configuredMint;
  const zeroForOne = inputMint.equals(poolMintA);
  const tokenAccount = getAssociatedTokenAddressSync(inputMint, wallet.publicKey);
  const balance = await getAccount(connection, tokenAccount, COMMITMENT, TOKEN_PROGRAM_ID);
  const amount = new BN(amountIn);
  if (balance.amount < BigInt(amountIn)) {
    throw new Error(
      `Trader ATA ${tokenAccount.toBase58()} has ${balance.amount} raw; ` +
      `${amountIn} raw is required.`,
    );
  }

  const { rpcData, configInfo, tickArrays } = await raydium.clmm.getSwapPoolInfo(
    poolId.toBase58(),
    zeroForOne,
  );
  const bitmapAddress = getPdaExBitmapAccount(
    new PublicKey(poolInfo.programId),
    poolId,
  ).publicKey;
  const bitmapInfo = await connection.getAccountInfo(bitmapAddress, COMMITMENT);
  if (!bitmapInfo) {
    throw new Error(`Raydium tick-array bitmap account is missing: ${bitmapAddress.toBase58()}`);
  }
  const simulation = swapInternal({
    programId: new PublicKey(poolInfo.programId),
    poolId,
    poolInfo: rpcData,
    tickArrays,
    configInfo,
    tickarrayBitmapExtension: TickArrayBitmapExtensionLayout.decode(bitmapInfo.data),
    amountSpecified: amount,
    sqrtPriceLimitX64: new BN(0),
    zeroForOne,
    isBaseInput: true,
    blockTimestamp: Math.floor(Date.now() / 1000),
    includeExtraTickArrays: true,
  });
  const minimumOutput = simulation.amountCalculated
    .mul(new BN(10_000 - slippageBps))
    .div(new BN(10_000));
  console.log(`Trader wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Pool: ${poolId.toBase58()}`);
  console.log(
    `Quote: ${amountIn} raw ${direction} -> ${simulation.amountCalculated.toString()} raw output`,
  );
  console.log(`Minimum output: ${minimumOutput.toString()} raw (${slippageBps} bps slippage)`);
  const { execute } = await raydium.clmm.swap({
    poolInfo,
    inputMint: inputMint.toBase58(),
    amountIn: amount,
    amountOutMin: minimumOutput,
    observationId: rpcData.observationId,
    ownerInfo: { useSOLBalance: false },
    remainingAccounts: simulation.accounts,
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600_000 },
  });
  const { txId } = await execute();
  const updated = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());
  console.log(`Swap confirmed: https://explorer.solana.com/tx/${txId}?cluster=devnet`);
  console.log(`Spot price before (token B per token A): ${initial.computePoolInfo.currentPrice}`);
  console.log(`Spot price after (token B per token A): ${updated.computePoolInfo.currentPrice}`);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
