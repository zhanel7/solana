import {
  AnchorProvider,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
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
  getPdaMetadataKey,
  getPdaPersonalPositionAddress,
  getPdaProtocolPositionAddress,
  getPdaTickArrayAddress,
  LiquidityMathUtil,
  MEMO_PROGRAM_ID,
  PersonalPositionLayout,
  PoolUtil,
  Raydium,
  TickArrayUtil,
  TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "./config.json";

type Action = "init" | "fund" | "open" | "collect" | "close" | "status";
type PositionState = {
  positionNftMint: PublicKey;
  positionPool: PublicKey;
  positionTickLower: number;
  positionTickUpper: number;
};

const COMMITMENT = "confirmed";
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

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

function loadIdl(): Idl {
  const idlPath = path.resolve("target/idl/simple_vault.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error("IDL not found; run `npm run build` first.");
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
}

function rawAmount(envName: string, fallback: string): BN {
  const value = process.env[envName] ?? fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${envName} must be a non-negative integer in base units.`);
  }
  return new BN(value);
}

function formatAmount(amount: bigint | number | string, decimals: number): string {
  const raw = amount.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals) || "0";
  const fraction = raw.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function deriveVault(programId: PublicKey, mintA: PublicKey, mintB: PublicKey) {
  const [vaultState] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mintA.toBuffer(), mintB.toBuffer()],
    programId,
  );
  const [vaultTokenA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_tokens_a"), vaultState.toBuffer()],
    programId,
  );
  const [vaultTokenB] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_tokens_b"), vaultState.toBuffer()],
    programId,
  );
  return { vaultState, vaultTokenA, vaultTokenB };
}

async function tokenProgramForMint(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const account = await connection.getAccountInfo(mint);
  if (!account) {
    throw new Error(`Mint does not exist: ${mint.toBase58()}`);
  }
  if (!TOKEN_PROGRAMS.some((programId) => programId.equals(account.owner))) {
    throw new Error(`Unsupported token program for mint ${mint.toBase58()}`);
  }
  return account.owner;
}

function getTickArrayStart(tick: number, tickSpacing: number): number {
  return TickArrayUtil.getTickArrayStartIndex(tick, tickSpacing);
}

async function run(): Promise<void> {
  const action = (process.argv[2] ?? "status") as Action;
  if (!["init", "fund", "open", "collect", "close", "status"].includes(action)) {
    throw new Error("Usage: npm run position -- <init|fund|open|collect|close|status>");
  }
  if (config.cluster !== "devnet") {
    throw new Error("This exercise is configured for devnet only.");
  }

  const wallet = loadWallet();
  const connection = new Connection(clusterApiUrl("devnet"), COMMITMENT);
  const provider = new AnchorProvider(
    connection,
    new Wallet(wallet),
    { commitment: COMMITMENT, preflightCommitment: COMMITMENT },
  );
  const program = new Program(loadIdl(), provider);
  if (program.programId.toBase58() !== config.programId) {
    throw new Error("Program ID mismatch; run `anchor keys sync` and rebuild.");
  }
  const vault = deriveVault(
    program.programId,
    new PublicKey(config.tokenA.mint),
    new PublicKey(config.tokenB.mint),
  );
  const mintA = new PublicKey(config.tokenA.mint);
  const mintB = new PublicKey(config.tokenB.mint);
  console.log(`Admin wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`CLMM pool: ${config.poolId}`);
  console.log(`Vault state: ${vault.vaultState.toBase58()}`);
  console.log(`Vault token A: ${vault.vaultTokenA.toBase58()}`);
  console.log(`Vault token B: ${vault.vaultTokenB.toBase58()}`);

  const programAccount = await connection.getAccountInfo(program.programId);
  if (action !== "init" && !programAccount?.executable) {
    throw new Error(
      `Program ${program.programId.toBase58()} is not deployed on devnet. ` +
      "Run `anchor deploy --provider.cluster devnet` first.",
    );
  }
  if (action === "init") {
    if (!programAccount?.executable) {
      throw new Error("Deploy the week-13 program before initializing its vault.");
    }
    const existing = await connection.getAccountInfo(vault.vaultState);
    if (existing) {
      throw new Error(`Vault already initialized: ${vault.vaultState.toBase58()}`);
    }
    const [tokenProgramA, tokenProgramB] = await Promise.all([
      tokenProgramForMint(connection, mintA),
      tokenProgramForMint(connection, mintB),
    ]);
    const signature = await program.methods
      .initializeVault()
      .accounts({
        admin: wallet.publicKey,
        tokenMintA: mintA,
        tokenMintB: mintB,
        vaultState: vault.vaultState,
        vaultTokenA: vault.vaultTokenA,
        vaultTokenB: vault.vaultTokenB,
        tokenProgramA,
        tokenProgramB,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log(`Vault initialized: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    return;
  }

  const [tokenProgramA, tokenProgramB] = await Promise.all([
    tokenProgramForMint(connection, mintA),
    tokenProgramForMint(connection, mintB),
  ]);
  const vaultAccountInfo = await connection.getAccountInfo(vault.vaultState);
  if (!vaultAccountInfo || !vaultAccountInfo.owner.equals(program.programId)) {
    throw new Error(`Vault is not initialized: ${vault.vaultState.toBase58()}`);
  }

  if (action === "fund") {
    const amountA = rawAmount("AMOUNT_A_RAW", config.amounts.depositA);
    const amountB = rawAmount("AMOUNT_B_RAW", config.amounts.depositB);
    if (amountA.isZero() && amountB.isZero()) {
      throw new Error("Set a positive AMOUNT_A_RAW or AMOUNT_B_RAW.");
    }
    const adminTokenA = await getOrCreateAssociatedTokenAccount(
      connection, wallet, mintA, wallet.publicKey, false, COMMITMENT, undefined, tokenProgramA,
    );
    const adminTokenB = await getOrCreateAssociatedTokenAccount(
      connection, wallet, mintB, wallet.publicKey, false, COMMITMENT, undefined, tokenProgramB,
    );
    const signature = await program.methods
      .fundVault(amountA, amountB)
      .accounts({
        admin: wallet.publicKey,
        vaultState: vault.vaultState,
        tokenMintA: mintA,
        tokenMintB: mintB,
        vaultTokenA: vault.vaultTokenA,
        vaultTokenB: vault.vaultTokenB,
        adminTokenA: adminTokenA.address,
        adminTokenB: adminTokenB.address,
        tokenProgramA,
        tokenProgramB,
      })
      .rpc();
    console.log(`Vault funded: A=${amountA.toString()}, B=${amountB.toString()} raw`);
    console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    return;
  }

  const raydium = await Raydium.load({
    owner: wallet,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
  });
  const poolId = new PublicKey(config.poolId);
  const poolRead = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());
  const { poolInfo, poolKeys, computePoolInfo } = poolRead;
  const clmmProgram = new PublicKey(poolInfo.programId);
  if (clmmProgram.toBase58() !== config.raydiumClmmProgramId) {
    throw new Error("The configured pool does not use the expected devnet Raydium CLMM program.");
  }
  const poolMintA = new PublicKey(poolInfo.mintA.address);
  const poolMintB = new PublicKey(poolInfo.mintB.address);
  if (
    !(poolMintA.equals(mintA) && poolMintB.equals(mintB)) &&
    !(poolMintA.equals(mintB) && poolMintB.equals(mintA))
  ) {
    throw new Error("The selected CLMM pool does not contain the configured mint pair.");
  }
  const poolVaultForTokenA = poolMintA.equals(mintA) ? poolKeys.vault.A : poolKeys.vault.B;
  const poolVaultForTokenB = poolMintA.equals(mintA) ? poolKeys.vault.B : poolKeys.vault.A;
  if (
    poolVaultForTokenA !== config.tokenA.poolVault ||
    poolVaultForTokenB !== config.tokenB.poolVault
  ) {
    throw new Error("Pool vaults differ from the verified week-11 devnet pool configuration.");
  }
  const tickSpacing = poolInfo.config.tickSpacing;
  const vaultStateData =
    program.coder.accounts.decode("vaultState", vaultAccountInfo.data) as PositionState;

  if (action === "open") {
    if (!vaultStateData.positionNftMint.equals(PublicKey.default)) {
      throw new Error(`Position already open: ${vaultStateData.positionNftMint.toBase58()}`);
    }
    const rangeBps = Number(process.env.RANGE_BPS ?? config.rangeBps);
    if (!Number.isInteger(rangeBps) || rangeBps <= 0 || rangeBps >= 5000) {
      throw new Error("RANGE_BPS must be an integer from 1 to 4999.");
    }
    const amountMaxA = rawAmount("POSITION_MAX_A_RAW", config.amounts.positionMaxA);
    const amountMaxB = rawAmount("POSITION_MAX_B_RAW", config.amounts.positionMaxB);
    const currentPrice = new Decimal(computePoolInfo.currentPrice.toString());
    const lowerPrice = currentPrice.mul(10_000 - rangeBps).div(10_000);
    const upperPrice = currentPrice.mul(10_000 + rangeBps).div(10_000);
    const tickLower = TickUtil.toTickIndex(
      TickUtil.priceToTick(lowerPrice, poolInfo.mintA.decimals, poolInfo.mintB.decimals),
      tickSpacing,
    );
    const tickUpper = TickUtil.toTickIndex(
      TickUtil.priceToTick(upperPrice, poolInfo.mintA.decimals, poolInfo.mintB.decimals),
      tickSpacing,
    );
    if (tickLower >= tickUpper) {
      throw new Error("The selected range does not produce a valid pair of CLMM ticks.");
    }
    const startLower = getTickArrayStart(tickLower, tickSpacing);
    const startUpper = getTickArrayStart(tickUpper, tickSpacing);
    const nftMint = Keypair.generate();
    const positionNftAccount = getAssociatedTokenAddressSync(
      nftMint.publicKey,
      vault.vaultState,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const positionAddresses = {
      protocolPosition: getPdaProtocolPositionAddress(
        clmmProgram, poolId, tickLower, tickUpper,
      ).publicKey,
      tickArrayLower: getPdaTickArrayAddress(
        clmmProgram, poolId, startLower,
      ).publicKey,
      tickArrayUpper: getPdaTickArrayAddress(
        clmmProgram, poolId, startUpper,
      ).publicKey,
      personalPosition: getPdaPersonalPositionAddress(
        clmmProgram, nftMint.publicKey,
      ).publicKey,
      metadataAccount: getPdaMetadataKey(nftMint.publicKey).publicKey,
    };
    const max0 = poolMintA.equals(mintA) ? amountMaxA : amountMaxB;
    const max1 = poolMintB.equals(mintA) ? amountMaxA : amountMaxB;
    const sqrtLower = TickUtil.getSqrtPriceAtTick(tickLower);
    const sqrtUpper = TickUtil.getSqrtPriceAtTick(tickUpper);
    const sqrtCurrent = computePoolInfo.sqrtPriceX64;
    const liquidityFrom0 = sqrtCurrent.gte(sqrtUpper)
      ? new BN(0)
      : LiquidityMathUtil.getLiquidityFromAmountA(
          sqrtCurrent.lte(sqrtLower) ? sqrtLower : sqrtCurrent,
          sqrtUpper,
          max0,
        );
    const liquidityFrom1 = sqrtCurrent.lte(sqrtLower)
      ? new BN(0)
      : LiquidityMathUtil.getLiquidityFromAmountB(
          sqrtLower,
          sqrtCurrent.gte(sqrtUpper) ? sqrtUpper : sqrtCurrent,
          max1,
        );
    const baseFlag = sqrtCurrent.lte(sqrtLower)
      ? true
      : sqrtCurrent.gte(sqrtUpper)
        ? false
        : liquidityFrom0.lte(liquidityFrom1);
    const selectedLiquidity = baseFlag ? liquidityFrom0 : liquidityFrom1;
    if (selectedLiquidity.isZero()) {
      throw new Error("The configured position range and token limits produce zero liquidity.");
    }
    const expectedDeposit = LiquidityMathUtil.getAmountsForLiquidity(
      computePoolInfo.sqrtPriceX64,
      sqrtLower,
      sqrtUpper,
      selectedLiquidity,
      true,
    );
    if (expectedDeposit.amountA.gt(max0) || expectedDeposit.amountB.gt(max1)) {
      throw new Error(
        "Position limits are too small for the current price and range. " +
        "Increase both token maximums or choose a wider range.",
      );
    }
    const tokenProgram0 = poolMintA.equals(mintA) ? tokenProgramA : tokenProgramB;
    const tokenProgram1 = poolMintB.equals(mintA) ? tokenProgramA : tokenProgramB;
    const adminToken0 = await getOrCreateAssociatedTokenAccount(
      connection, wallet, poolMintA, wallet.publicKey, false,
      COMMITMENT, undefined, tokenProgram0,
    );
    const adminToken1 = await getOrCreateAssociatedTokenAccount(
      connection, wallet, poolMintB, wallet.publicKey, false,
      COMMITMENT, undefined, tokenProgram1,
    );
    const bitmapAccounts = PoolUtil.isOverflowDefaultTickarrayBitmap({
      tickSpacing,
      tickIndexs: [startLower, startUpper],
    })
      ? [{
          pubkey: getPdaExBitmapAccount(clmmProgram, poolId).publicKey,
          isSigner: false,
          isWritable: true,
        }]
      : [];
    const beforeA = await getAccount(connection, vault.vaultTokenA, COMMITMENT, tokenProgramA);
    const beforeB = await getAccount(connection, vault.vaultTokenB, COMMITMENT, tokenProgramB);
    console.log(
      `Estimated position deposit (pool order): token0=${expectedDeposit.amountA.toString()} raw, ` +
      `token1=${expectedDeposit.amountB.toString()} raw`,
    );
    console.log(`Liquidity base: token${baseFlag ? "0" : "1"} (limiting token balance)`);
    const signature = await program.methods
      .openPosition(
        tickLower,
        tickUpper,
        startLower,
        startUpper,
        max0,
        max1,
        baseFlag,
      )
      .accounts({
        admin: wallet.publicKey,
        vaultState: vault.vaultState,
        positionNftMint: nftMint.publicKey,
        positionNftAccount,
        metadataAccount: positionAddresses.metadataAccount,
        poolState: poolId,
        protocolPosition: positionAddresses.protocolPosition,
        tickArrayLower: positionAddresses.tickArrayLower,
        tickArrayUpper: positionAddresses.tickArrayUpper,
        personalPosition: positionAddresses.personalPosition,
        vaultTokenA: vault.vaultTokenA,
        vaultTokenB: vault.vaultTokenB,
        tokenAccount0: adminToken0.address,
        tokenAccount1: adminToken1.address,
        tokenVault0: poolKeys.vault.A,
        tokenVault1: poolKeys.vault.B,
        vault0Mint: poolMintA,
        vault1Mint: poolMintB,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        clmmProgram,
      })
      .remainingAccounts(bitmapAccounts)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
      .signers([nftMint])
      .rpc();
    const afterA = await getAccount(connection, vault.vaultTokenA, COMMITMENT, tokenProgramA);
    const afterB = await getAccount(connection, vault.vaultTokenB, COMMITMENT, tokenProgramB);
    console.log(`Position opened: ticks [${tickLower}, ${tickUpper}]`);
    console.log(`Price range: ${lowerPrice.toSignificantDigits(8)}–${upperPrice.toSignificantDigits(8)} ${poolInfo.mintB.symbol}/${poolInfo.mintA.symbol}`);
    console.log(`Maximums (pool token order): token0=${formatAmount(max0.toString(), poolInfo.mintA.decimals)}, token1=${formatAmount(max1.toString(), poolInfo.mintB.decimals)}`);
    console.log(`Vault amounts deposited: A=${beforeA.amount - afterA.amount}, B=${beforeB.amount - afterB.amount} raw`);
    console.log(`Position NFT: ${nftMint.publicKey.toBase58()}`);
    console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    return;
  }

  if (action === "status") {
    if (vaultStateData.positionNftMint.equals(PublicKey.default)) {
      console.log("No open CLMM position.");
    } else {
      console.log(`Position NFT: ${vaultStateData.positionNftMint.toBase58()}`);
      console.log(`Pool: ${vaultStateData.positionPool.toBase58()}`);
      console.log(`Tick range: [${vaultStateData.positionTickLower}, ${vaultStateData.positionTickUpper}]`);
    }
    const tokenA = await getAccount(connection, vault.vaultTokenA, COMMITMENT, tokenProgramA);
    const tokenB = await getAccount(connection, vault.vaultTokenB, COMMITMENT, tokenProgramB);
    console.log(`Vault balances: A=${tokenA.amount}, B=${tokenB.amount} raw`);
    return;
  }

  if (vaultStateData.positionNftMint.equals(PublicKey.default)) {
    throw new Error("No open position. Run `npm run position -- open` first.");
  }
  if (!vaultStateData.positionPool.equals(poolId)) {
    throw new Error("The stored position belongs to a different CLMM pool.");
  }
  const tickLower = vaultStateData.positionTickLower;
  const tickUpper = vaultStateData.positionTickUpper;
  const startLower = getTickArrayStart(tickLower, tickSpacing);
  const startUpper = getTickArrayStart(tickUpper, tickSpacing);
  const positionAddresses = {
    positionNftAccount: getAssociatedTokenAddressSync(
      vaultStateData.positionNftMint, vault.vaultState, true, TOKEN_PROGRAM_ID,
    ),
    personalPosition: getPdaPersonalPositionAddress(
      clmmProgram, vaultStateData.positionNftMint,
    ).publicKey,
    protocolPosition: getPdaProtocolPositionAddress(
      clmmProgram, poolId, tickLower, tickUpper,
    ).publicKey,
    tickArrayLower: getPdaTickArrayAddress(clmmProgram, poolId, startLower).publicKey,
    tickArrayUpper: getPdaTickArrayAddress(clmmProgram, poolId, startUpper).publicKey,
  };
  const recipient0 = poolMintA.equals(mintA) ? vault.vaultTokenA : vault.vaultTokenB;
  const recipient1 = poolMintB.equals(mintA) ? vault.vaultTokenA : vault.vaultTokenB;
  const bitmapAccounts = PoolUtil.isOverflowDefaultTickarrayBitmap({
    tickSpacing,
    tickIndexs: [startLower, startUpper],
  })
    ? [{
        pubkey: getPdaExBitmapAccount(clmmProgram, poolId).publicKey,
        isSigner: false,
        isWritable: true,
      }]
    : [];
  const remainingAccounts = [...bitmapAccounts];
  for (const reward of poolKeys.rewardInfos) {
    const rewardMint = new PublicKey(reward.mint.address);
    if (rewardMint.equals(PublicKey.default)) {
      continue;
    }
    const rewardTokenProgram = await tokenProgramForMint(connection, rewardMint);
    const rewardAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      rewardMint,
      vault.vaultState,
      true,
      COMMITMENT,
      undefined,
      rewardTokenProgram,
    );
    remainingAccounts.push(
      { pubkey: new PublicKey(reward.vault), isSigner: false, isWritable: true },
      { pubkey: rewardAccount.address, isSigner: false, isWritable: true },
      { pubkey: rewardMint, isSigner: false, isWritable: false },
    );
  }
  const manageAccounts = {
    admin: wallet.publicKey,
    vaultState: vault.vaultState,
    positionNftMint: vaultStateData.positionNftMint,
    positionNftAccount: positionAddresses.positionNftAccount,
    poolState: poolId,
    protocolPosition: positionAddresses.protocolPosition,
    personalPosition: positionAddresses.personalPosition,
    tickArrayLower: positionAddresses.tickArrayLower,
    tickArrayUpper: positionAddresses.tickArrayUpper,
    vaultTokenA: vault.vaultTokenA,
    vaultTokenB: vault.vaultTokenB,
    tokenVault0: poolKeys.vault.A,
    tokenVault1: poolKeys.vault.B,
    recipientTokenAccount0: recipient0,
    recipientTokenAccount1: recipient1,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram2022: TOKEN_2022_PROGRAM_ID,
    memoProgram: MEMO_PROGRAM_ID,
    vault0Mint: poolMintA,
    vault1Mint: poolMintB,
    systemProgram: SystemProgram.programId,
    clmmProgram,
  };
  const beforeA = await getAccount(connection, vault.vaultTokenA, COMMITMENT, tokenProgramA);
  const beforeB = await getAccount(connection, vault.vaultTokenB, COMMITMENT, tokenProgramB);
  let builder;
  if (action === "collect") {
    builder = program.methods.collectFees();
  } else {
    const positionInfo = await connection.getAccountInfo(positionAddresses.personalPosition);
    if (!positionInfo || !positionInfo.owner.equals(clmmProgram)) {
      throw new Error("Raydium personal position account is missing or has the wrong owner.");
    }
    const positionData = PersonalPositionLayout.decode(positionInfo.data);
    const closeSlippageBps = Number(
      process.env.CLOSE_SLIPPAGE_BPS ?? config.closeSlippageBps,
    );
    if (
      !Number.isInteger(closeSlippageBps) ||
      closeSlippageBps < 0 ||
      closeSlippageBps >= 10_000
    ) {
      throw new Error("CLOSE_SLIPPAGE_BPS must be an integer from 0 through 9999.");
    }
    const expected = LiquidityMathUtil.getAmountsForLiquidity(
      computePoolInfo.sqrtPriceX64,
      TickUtil.getSqrtPriceAtTick(tickLower),
      TickUtil.getSqrtPriceAtTick(tickUpper),
      positionData.liquidity,
      false,
    );
    const minimum0 = rawAmount(
      "CLOSE_MIN_0_RAW",
      expected.amountA.mul(new BN(10_000 - closeSlippageBps)).div(new BN(10_000)).toString(),
    );
    const minimum1 = rawAmount(
      "CLOSE_MIN_1_RAW",
      expected.amountB.mul(new BN(10_000 - closeSlippageBps)).div(new BN(10_000)).toString(),
    );
    console.log(
      `Close minimums: token0=${minimum0.toString()} raw, token1=${minimum1.toString()} raw ` +
      `(${closeSlippageBps} bps below the current liquidity quote)`,
    );
    builder = program.methods.closePosition(minimum0, minimum1);
  }
  const signature = await builder
    .accounts(manageAccounts)
    .remainingAccounts(remainingAccounts)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .rpc();
  const afterA = await getAccount(connection, vault.vaultTokenA, COMMITMENT, tokenProgramA);
  const afterB = await getAccount(connection, vault.vaultTokenB, COMMITMENT, tokenProgramB);
  console.log(action === "collect" ? "Position fees collected." : "Position liquidity withdrawn and NFT closed.");
  console.log(`Vault delta: A=${afterA.amount - beforeA.amount}, B=${afterB.amount - beforeB.amount} raw`);
  console.log(`Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
