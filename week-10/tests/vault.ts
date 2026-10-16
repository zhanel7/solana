import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SimpleVault } from "../target/types/simple_vault";
import { expect } from "chai";
import { 
  createMint, 
  getOrCreateAssociatedTokenAccount, 
  mintTo 
} from "@solana/spl-token";

describe("simple_vault week 10: withdraw and cpi", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const payer = provider.wallet as anchor.Wallet;

  const tokenMint = anchor.web3.Keypair.generate();
  let vaultTokenAccount: anchor.web3.PublicKey;
  let shareMint: anchor.web3.PublicKey;

  let userTokenAccount: any;
  let userShareAccount: any;

  // Находим PDA для Vault State
  const [vaultStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), tokenMint.publicKey.toBuffer()],
    program.programId
  );

  // Находим PDA для карточки пользователя
  const [userCardPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_card"), vaultStatePda.toBuffer(), payer.publicKey.toBuffer()],
    program.programId
  );

  it("1. Инициализирует Vault и создает минт базового токена", async () => {
    await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6,
      tokenMint
    );

    [vaultTokenAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), vaultStatePda.toBuffer()],
      program.programId
    );

    [shareMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), vaultStatePda.toBuffer()],
      program.programId
    );

    userTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenMint.publicKey,
      payer.publicKey
    );

    await mintTo(
      provider.connection,
      payer.payer,
      tokenMint.publicKey,
      userTokenAccount.address,
      payer.payer,
      1000 * 10**6
    );

    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePda,
        tokenMint: tokenMint.publicKey,
        vaultTokenAccount: vaultTokenAccount,
        shareMint: shareMint,
        admin: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultStatePda);
    expect(vaultAccount.admin.toBase58()).to.equal(payer.publicKey.toBase58());
    console.log("Vault успешно инициализирован с реальным SPL-токеном!");
  });

  it("2. Создает карточку пользователя", async () => {
    await program.methods
      .createUserCard()
      .accounts({
        userCard: userCardPda,
        vaultState: vaultStatePda,
        user: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const cardAccount = await program.account.userCard.fetch(userCardPda);
    expect(cardAccount.owner.toBase58()).to.equal(payer.publicKey.toBase58());
    console.log("Карточка пользователя успешно создана!");
  });

  it("3. Выполняет депозит и выдает share-токены 1 к 1 (первый вкладчик)", async () => {
    userShareAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      shareMint,
      payer.publicKey
    );

    const depositAmount = new anchor.BN(100 * 10**6); // Вносим 100 токенов

    await program.methods
      .deposit(depositAmount)
      .accounts({
        vaultState: vaultStatePda,
        vaultTokenAccount: vaultTokenAccount,
        shareMint: shareMint,
        userCard: userCardPda,
        userTokenAccount: userTokenAccount.address,
        userShareAccount: userShareAccount.address,
        user: payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultStatePda);
    const cardAccount = await program.account.userCard.fetch(userCardPda);

    expect(vaultAccount.totalShares.toString()).to.equal(depositAmount.toString());
    expect(cardAccount.shares.toString()).to.equal(depositAmount.toString());

    console.log("Депозит успешно выполнен! Выпущено долей:", cardAccount.shares.toString());
  });

  it("4. Выполняет вывод средств (withdraw) и сжигание долей", async () => {
    const withdrawShares = new anchor.BN(50 * 10**6); // Выводим половину долей (50 токенов)

    await program.methods
      .withdraw(withdrawShares)
      .accounts({
        vaultState: vaultStatePda,
        vaultTokenAccount: vaultTokenAccount,
        shareMint: shareMint,
        userCard: userCardPda,
        userTokenAccount: userTokenAccount.address,
        userShareAccount: userShareAccount.address,
        user: payer.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    const cardAccount = await program.account.userCard.fetch(userCardPda);
    expect(cardAccount.shares.toString()).to.equal((50 * 10**6).toString());

    console.log("Вывод средств и сжигание долей успешно выполнены!");
  });
});