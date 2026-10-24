import * as anchor from "@coral-xyz/anchor";

console.log("==================================================");
console.log("   WEEK 13: RWA & STABLECOIN PAYMENT GATEWAY     ");
console.log("==================================================");

const merchant = pg.wallet.publicKey;
const orderId = "INV-" + Math.floor(Math.random() * 100000);
const paymentAmountUSDC = 250;

const [invoicePda] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("invoice"), merchant.toBuffer(), Buffer.from(orderId)],
  pg.program.programId
);

console.log("Мерчант (Продавец):", merchant.toBase58());
console.log("Номер заказа (Order ID):", orderId);
console.log("Адрес PDA Инвойса:", invoicePda.toBase58());

async function runGateway() {
  try {
    // 1. Создание ончейн-инвойса
    console.log("\n1. Генерация ончейн-инвойса...");
    const tx1 = await pg.program.methods
      .createInvoice(new anchor.BN(paymentAmountUSDC * 10 ** 6), orderId)
      .accounts({
        invoice: invoicePda,
        merchant: merchant,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    
    console.log("Инвойс создан! Tx:", tx1);

    let invoiceData = await pg.program.account.invoiceState.fetch(invoicePda);
    console.log("Статус инвойса до оплаты:", invoiceData.isPaid ? "ОПЛАЧЕНО" : "ОЖИДАЕТ ОПЛАТЫ");

    // Задержка 2 секунды для финализации блока в Devnet
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 2. Проведение оплаты
    console.log("\n2. Обработка платежа...");
    const tx2 = await pg.program.methods
      .processPayment()
      .accounts({
        invoice: invoicePda,
        payer: merchant,
      })
      .rpc();

    console.log("Транзакция оплаты отправлена! Tx:", tx2);

    // Задержка 2 секунды перед финальной проверкой
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 3. Проверка итогового статуса
    invoiceData = await pg.program.account.invoiceState.fetch(invoicePda);
    console.log("\n==================================================");
    console.log("Итоговый статус инвойса:", invoiceData.isPaid ? "ОПЛАЧЕНО (Paid) ✅" : "ОЖИДАЕТ ОПЛАТЫ ❌");
    console.log("==================================================");
  } catch (err) {
    console.error("Ошибка во время выполнения:", err);
  }
}

await runGateway();
