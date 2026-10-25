import {
  AnchorProvider,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getPdaExBitmapAccount,
  MEMO_PROGRAM_ID,
  Raydium,
  swapInternal,
  TickArrayBitmapExtensionLayout,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "./config.json";

type Action = "init" | "fund" | "quote" | "swap" | "slippage-reject";

const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
const COMMITMENT = "confirmed";

function configuredAddress(name: string, fallback: string): PublicKey {
  return new PublicKey(process.env[name] ?? fallback);
}

function formatRawAmount(amount: BN, decimals: number): string {
  if (decimals === 0) {
    return amount.toString();
  }
  const raw = amount.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals) || "0";
  const fraction = raw.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function loadIdl(): Idl {
  const idlPath = path.resolve("target/idl/simple_vault.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error("IDL not found; run `anchor build` first.");
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
}

function loadWallet(): Keypair {
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }
  const secretKey = JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function getTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const account = await connection.getAccountInfo(mint);
  if (!account) {
    throw new Error(`Mint account does not exist: ${mint.toBase58()}`);
  }
  if (!TOKEN_PROGRAMS.some((programId) => programId.equals(account.owner))) {
    throw new Error(`Unsupported token program for mint ${mint.toBase58()}`);
  }
  return account.owner;
}

async function run(): Promise<void> {
  const action = (process.argv[2] ?? "quote") as Action;
  if (!["init", "fund", "quote", "swap", "slippage-reject"].includes(action)) {
    throw new Error("Usage: npm run swap -- <init|fund|quote|swap|slippage-reject>");
  }

  const wallet = loadWallet();
  if (config.cluster !== "devnet") {
    throw new Error("This demo is configured for devnet only.");
  }
  const connection = new Connection(clusterApiUrl("devnet"), COMMITMENT);
  const provider = new AnchorProvider(
    connection,
    new Wallet(wallet),
    { commitment: COMMITMENT, preflightCommitment: COMMITMENT },
  );
  const idl = loadIdl();
  if (idl.address !== config.programId) {
    throw new Error(
      `Program ID mismatch: config=${config.programId}, IDL=${idl.address}. Run \`anchor keys sync\` and \`npm run build\`.`,
    );
  }
  const program = new Program(idl, provider);
  const tokenMintA = configuredAddress("TOKEN_MINT_A", config.tokenA.mint);
  const tokenMintB = configuredAddress("TOKEN_MINT_B", config.tokenB.mint);
  if (tokenMintA.equals(tokenMintB)) {
    throw new Error("TOKEN_MINT_A and TOKEN_MINT_B must be different.");
  }

  const [vaultState] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      tokenMintA.toBuffer(),
      tokenMintB.toBuffer(),
    ],
    program.programId,
  );
  const [vaultTokenA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_tokens_a"), vaultState.toBuffer()],
    program.programId,
  );
  const [vaultTokenB] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_tokens_b"), vaultState.toBuffer()],
    program.programId,
  );
  if (
    vaultState.toBase58() !== config.vault.state ||
    vaultTokenA.toBase58() !== config.vault.tokenA ||
    vaultTokenB.toBase58() !== config.vault.tokenB
  ) {
    throw new Error(
      "The vault PDAs do not match config.json. Verify the program ID and mint addresses.",
    );
  }
  console.log(`Admin wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Token A mint: ${tokenMintA.toBase58()}`);
  console.log(`Token B mint: ${tokenMintB.toBase58()}`);
  console.log(`Raydium pool: ${config.poolId}`);
  console.log(`Vault state: ${vaultState.toBase58()}`);
  console.log(`Vault token A: ${vaultTokenA.toBase58()}`);
  console.log(`Vault token B: ${vaultTokenB.toBase58()}`);
  if (action !== "quote") {
    const programAccount = await connection.getAccountInfo(program.programId);
    if (!programAccount?.executable) {
      throw new Error(
        `Vault program ${program.programId.toBase58()} is not deployed on devnet. ` +
        "Fund the deploy wallet, then run `anchor deploy --provider.cluster devnet`.",
      );
    }
    if (action !== "init") {
      const vaultAccount = await connection.getAccountInfo(vaultState);
      if (!vaultAccount || !vaultAccount.owner.equals(program.programId)) {
        throw new Error(
          `Vault ${vaultState.toBase58()} is not initialized. Run \`npm run swap -- init\` first.`,
        );
      }
    }
  }
  const [tokenProgramA, tokenProgramB] = await Promise.all([
    getTokenProgram(connection, tokenMintA),
    getTokenProgram(connection, tokenMintB),
  ]);
  const expectedTokenProgram = new PublicKey(config.tokenProgramId);
  if (
    !tokenProgramA.equals(expectedTokenProgram) ||
    !tokenProgramB.equals(expectedTokenProgram)
  ) {
    throw new Error(
      "The configured week-11 mints are not owned by the expected SPL Token program.",
    );
  }

  if (action === "init") {
    const existingVault = await connection.getAccountInfo(vaultState);
    if (existingVault) {
      throw new Error(`Vault already exists: ${vaultState.toBase58()}`);
    }
    const signature = await program.methods
      .initializeVault()
      .accounts({
        admin: wallet.publicKey,
        tokenMintA,
        tokenMintB,
        vaultState,
        vaultTokenA,
        vaultTokenB,
        tokenProgramA,
        tokenProgramB,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log(`Vault initialized: ${vaultState.toBase58()}`);
    console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    return;
  }

  if (action === "fund") {
    const amountA = new BN(process.env.AMOUNT_A_RAW ?? config.amounts.depositA);
    const amountB = new BN(process.env.AMOUNT_B_RAW ?? config.amounts.depositB);
    if (amountA.isNeg() || amountB.isNeg()) {
      throw new Error("AMOUNT_A_RAW and AMOUNT_B_RAW cannot be negative.");
    }
    if (amountA.isZero() && amountB.isZero()) {
      throw new Error("Set AMOUNT_A_RAW or AMOUNT_B_RAW to a positive base-unit amount.");
    }
    const adminTokenA = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      tokenMintA,
      wallet.publicKey,
      false,
      COMMITMENT,
      undefined,
      tokenProgramA,
    );
    const adminTokenB = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      tokenMintB,
      wallet.publicKey,
      false,
      COMMITMENT,
      undefined,
      tokenProgramB,
    );
    const signature = await program.methods
      .fundVault(amountA, amountB)
      .accounts({
        admin: wallet.publicKey,
        vaultState,
        tokenMintA,
        tokenMintB,
        vaultTokenA,
        vaultTokenB,
        adminTokenA: adminTokenA.address,
        adminTokenB: adminTokenB.address,
        tokenProgramA,
        tokenProgramB,
      })
      .rpc();
    console.log(`Vault funded: A=${amountA.toString()} raw, B=${amountB.toString()} raw`);
    console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    return;
  }

  const poolId = configuredAddress("CLMM_POOL_ID", config.poolId);
  const amountIn = new BN(process.env.AMOUNT_IN_RAW ?? config.amounts.swapInA);
  if (amountIn.isZero() || amountIn.isNeg()) {
    throw new Error("AMOUNT_IN_RAW must be a positive base-unit amount.");
  }

  const raydium = await Raydium.load({
    owner: wallet,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
  });
  const initialPoolRead = await raydium.clmm.getPoolInfoFromRpc(
    poolId.toBase58(),
  );
  const initialPoolInfo = initialPoolRead.computePoolInfo;
  const mintAInPool = new PublicKey(initialPoolInfo.mintA.address);
  const mintBInPool = new PublicKey(initialPoolInfo.mintB.address);
  const zeroForOne = mintAInPool.equals(tokenMintA);
  if (
    (!zeroForOne && !mintBInPool.equals(tokenMintA)) ||
    (zeroForOne && !mintBInPool.equals(tokenMintB)) ||
    (!zeroForOne && !mintAInPool.equals(tokenMintB))
  ) {
    throw new Error("The selected CLMM pool does not contain TOKEN_MINT_A and TOKEN_MINT_B.");
  }

  const { poolInfo: swapPoolInfo, rpcData, configInfo, tickArrays } =
    await raydium.clmm.getSwapPoolInfo(poolId, zeroForOne);
  const programId = new PublicKey(swapPoolInfo.programId);
  if (!programId.equals(new PublicKey(config.raydiumClmmProgramId))) {
    throw new Error("The configured pool is not owned by the expected devnet Raydium CLMM program.");
  }
  const poolVaultIn = zeroForOne ? initialPoolInfo.vaultA : initialPoolInfo.vaultB;
  const poolVaultOut = zeroForOne ? initialPoolInfo.vaultB : initialPoolInfo.vaultA;
  const expectedPoolVaultIn = zeroForOne
    ? config.tokenA.poolVault
    : config.tokenB.poolVault;
  const expectedPoolVaultOut = zeroForOne
    ? config.tokenB.poolVault
    : config.tokenA.poolVault;
  if (
    poolVaultIn.toBase58() !== expectedPoolVaultIn ||
    poolVaultOut.toBase58() !== expectedPoolVaultOut
  ) {
    throw new Error(
      "The selected pool vaults differ from week-11 config. Re-read week-11/src/data/clmm-devnet-pool.json before swapping.",
    );
  }
  const bitmapAddress = getPdaExBitmapAccount(programId, poolId).publicKey;
  const bitmapAccount = await connection.getAccountInfo(bitmapAddress);
  if (!bitmapAccount) {
    throw new Error(`Raydium tick-array bitmap account is missing: ${bitmapAddress.toBase58()}`);
  }
  const simulation = swapInternal({
    programId,
    poolId,
    poolInfo: rpcData,
    tickArrays,
    configInfo,
    tickarrayBitmapExtension: TickArrayBitmapExtensionLayout.decode(bitmapAccount.data),
    amountSpecified: amountIn,
    sqrtPriceLimitX64: new BN(0),
    zeroForOne,
    isBaseInput: true,
    blockTimestamp: Math.floor(Date.now() / 1000),
    includeExtraTickArrays: true,
  });
  if (!simulation.allTrade || simulation.amountCalculated.isZero()) {
    throw new Error("The pool cannot fill this entire input amount; no transaction was submitted.");
  }

  const slippageBps = Number(
    process.env.SLIPPAGE_BPS ?? config.slippageBps,
  );
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10_000
  ) {
    throw new Error("SLIPPAGE_BPS must be an integer from 0 through 9999.");
  }
  const minimumAmountOut =
    action === "slippage-reject"
      ? simulation.amountCalculated.addn(1)
      : simulation.amountCalculated
          .mul(new BN(10_000 - slippageBps))
          .div(new BN(10_000));
  const outputDecimals = zeroForOne
    ? swapPoolInfo.mintB.decimals
    : swapPoolInfo.mintA.decimals;
  const currentPrice = Number(initialPoolInfo.currentPrice.toString());
  const priceAToB = zeroForOne ? currentPrice : 1 / currentPrice;

  console.log(`Pool: ${poolId.toBase58()}`);
  console.log(`Vault: ${vaultState.toBase58()}`);
  console.log(`Spot price before (token B per token A): ${priceAToB}`);
  console.log(`Expected output: ${formatRawAmount(simulation.amountCalculated, outputDecimals)} token B`);
  const minimumOutputReason = action === "slippage-reject"
    ? "deliberately 1 base unit above the quote"
    : `${slippageBps} bps slippage`;
  console.log(`Minimum output: ${formatRawAmount(minimumAmountOut, outputDecimals)} token B (${minimumOutputReason})`);
  if (action === "quote") {
    console.log("Quote only; no transaction was submitted.");
    return;
  }

  const method = program.methods.swap(amountIn, minimumAmountOut);
  const transaction = method
    .accounts({
      admin: wallet.publicKey,
      vaultState,
      vaultTokenA,
      vaultTokenB,
      poolState: poolId,
      ammConfig: swapPoolInfo.config.id,
      inputVault: poolVaultIn,
      outputVault: poolVaultOut,
      observationState: rpcData.observationId,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      inputVaultMint: tokenMintA,
      outputVaultMint: tokenMintB,
      clmmProgram: programId,
    })
    .remainingAccounts(
      simulation.accounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    )
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ]);

  if (action === "slippage-reject") {
    const rejectionTransaction = await transaction.transaction();
    const blockhash = await connection.getLatestBlockhash(COMMITMENT);
    rejectionTransaction.feePayer = wallet.publicKey;
    rejectionTransaction.recentBlockhash = blockhash.blockhash;
    rejectionTransaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    rejectionTransaction.sign(wallet);
    const signature = await connection.sendRawTransaction(
      rejectionTransaction.serialize(),
      { skipPreflight: true },
    );
    let confirmationError: unknown;
    try {
      await connection.confirmTransaction(
        { signature, ...blockhash },
        COMMITMENT,
      );
    } catch (error: unknown) {
      confirmationError = error;
    }
    const result = await connection.getTransaction(signature, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 0,
    });
    if (!result?.meta) {
      const confirmationErrorText = confirmationError
        ? JSON.stringify(confirmationError)
        : "";
      if (/Custom["': ]+6018|0x1782/i.test(confirmationErrorText)) {
        console.log("Raydium rejected the swap because minimum output was not met.");
        console.log(`Failed transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
        console.log(`On-chain error: ${confirmationErrorText}`);
        return;
      }
      throw new Error(
        `Could not load confirmed transaction details. Review ` +
        `https://explorer.solana.com/tx/${signature}?cluster=devnet` +
        (confirmationErrorText ? `\nConfirmation error: ${confirmationErrorText}` : ""),
      );
    }
    const logs = (result.meta.logMessages ?? []).join("\n");
    const transactionError = JSON.stringify(result.meta.err);
    if (!result.meta.err) {
      throw new Error(
        `The deliberately excessive minimum output unexpectedly succeeded: https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      );
    }
    const isMinimumOutputRejection =
      /too little output|minimum.*output|slippage|exceed.*output/i.test(logs) ||
      /Custom["': ]+6018|0x1782/i.test(transactionError);
    if (!isMinimumOutputRejection) {
      throw new Error(
        `Transaction failed for a reason other than a recognizable slippage error. ` +
        `Review https://explorer.solana.com/tx/${signature}?cluster=devnet\n` +
        `Transaction error: ${transactionError}\n${logs}`,
      );
    }
    console.log("Raydium rejected the swap because minimum output was not met.");
    console.log(`Failed transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    console.log(`On-chain error: ${transactionError}`);
    console.log(logs);
    return;
  }

  const signature = await transaction.rpc();
  console.log(`Swap confirmed: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  const updated = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());
  const updatedPrice = Number(updated.computePoolInfo.currentPrice.toString());
  const updatedAToB = zeroForOne ? updatedPrice : 1 / updatedPrice;
  const changePercent = ((updatedAToB / priceAToB) - 1) * 100;
  console.log(`Spot price after (token B per token A): ${updatedAToB}`);
  console.log(`Spot price change: ${changePercent.toFixed(6)}%`);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
