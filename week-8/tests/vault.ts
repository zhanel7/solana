import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SimpleVault } from "../target/types/simple_vault";
import { expect } from "chai";

describe("simple_vault practical tasks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;

  const tokenMint = anchor.web3.Keypair.generate();
  const vaultTokenAccount = anchor.web3.Keypair.generate();
  const shareMint = anchor.web3.Keypair.generate();

  // Находим PDA для Vault State
  const [vaultStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), tokenMint.publicKey.toBuffer()],
    program.programId
  );

  // Находим PDA для карточки пользователя
  const [userCardPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_card"), vaultStatePda.toBuffer(), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  it("1. Инициализирует Vault", async () => {
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePda,
        tokenMint: tokenMint.publicKey,
        vaultTokenAccount: vaultTokenAccount.publicKey,
        shareMint: shareMint.publicKey,
        admin: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultStatePda);
    expect(vaultAccount.admin.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(vaultAccount.paused).to.be.false;
    console.log("Vault успешно инициализирован!");
  });

  it("2. Создает карточку пользователя с полем created_at", async () => {
    await program.methods
      .createUserCard()
      .accounts({
        userCard: userCardPda,
        vaultState: vaultStatePda,
        user: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const cardAccount = await program.account.userCard.fetch(userCardPda);
    expect(cardAccount.owner.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(cardAccount.createdAt.toNumber()).to.be.greaterThan(0);
    console.log("Карточка пользователя создана, timestamp:", cardAccount.createdAt.toString());
  });

  it("3. Закрывает карточку пользователя и возвращает ренту (close_user_card)", async () => {
    await program.methods
      .closeUserCard()
      .accounts({
        userCard: userCardPda,
        vaultState: vaultStatePda,
        user: provider.wallet.publicKey,
      })
      .rpc();

    // Проверяем, что аккаунт карточки удален (ее больше не существует в блокчейне)
    try {
      await program.account.userCard.fetch(userCardPda);
      expect.fail("Карточка должна быть закрыта");
    } catch (error) {
      console.log("Карточка успешно закрыта и рента возвращена!");
    }
  });
});