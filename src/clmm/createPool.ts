import { DEVNET_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2'
import type { ApiV3Token } from '@raydium-io/raydium-sdk-v2'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import Decimal from 'decimal.js'
import { connection, owner, txVersion, initSdk } from '../config'
import { devnetPoolStatePath, saveDevnetPoolState } from './devnetPoolState'

const TOKEN_DECIMALS = 6
const TOKEN_SUPPLY = 10_000
const INITIAL_PRICE = new Decimal(1)

export const createPoolWithNewTokens = async () => {
  const raydium = await initSdk({ loadToken: true })
  const balance = await connection.getBalance(owner.publicKey)

  console.log(`Кошелек: ${owner.publicKey.toBase58()}`)
  console.log(`Баланс SOL в devnet: ${(balance / 1e9).toFixed(4)}`)

  if (balance < 0.5 * 1e9) {
    throw new Error('Недостаточно devnet SOL. Пополните кошелек через Solana devnet faucet и запустите скрипт снова.')
  }

  console.log('Создаем два SPL-токена и выпускаем по 10 000 токенов...')
  const mintOne = await createMint(connection, owner, owner.publicKey, null, TOKEN_DECIMALS)
  const mintTwo = await createMint(connection, owner, owner.publicKey, null, TOKEN_DECIMALS)
  const [mintA, mintB] = [mintOne, mintTwo].sort((a, b) => {
    const bytesA = a.toBytes()
    const bytesB = b.toBytes()
    for (let i = 0; i < bytesA.length; i++) {
      if (bytesA[i] !== bytesB[i]) return bytesA[i] - bytesB[i]
    }
    return 0
  })
  console.log(`Mint A: ${mintA.toBase58()}`)
  console.log(`Mint B: ${mintB.toBase58()}`)
  saveDevnetPoolState({
    cluster: 'devnet',
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    initialPrice: INITIAL_PRICE.toString(),
  })

  const tokenAccountA = await getOrCreateAssociatedTokenAccount(connection, owner, mintA, owner.publicKey)
  const tokenAccountB = await getOrCreateAssociatedTokenAccount(connection, owner, mintB, owner.publicKey)
  const tokenAmount = new Decimal(TOKEN_SUPPLY).mul(10 ** TOKEN_DECIMALS).toFixed(0)
  await mintTo(connection, owner, mintA, tokenAccountA.address, owner, Number(tokenAmount))
  await mintTo(connection, owner, mintB, tokenAccountB.address, owner, Number(tokenAmount))

  console.log('Загружаем CLMM-конфигурации devnet...')
  const clmmConfigs = await raydium.api.getClmmConfigs()
  const clmmConfig = clmmConfigs[0]
  if (!clmmConfig) throw new Error('Raydium API не вернул CLMM-конфигурацию для devnet.')

  const tokenInfo = (mint: PublicKey): ApiV3Token => ({
    chainId: 103,
    address: mint.toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(),
    logoURI: '',
    symbol: 'TEST',
    name: 'Devnet Test Token',
    decimals: TOKEN_DECIMALS,
    tags: [],
    extensions: {},
  })

  console.log(`Создаем CLMM-пул с начальной ценой ${INITIAL_PRICE.toString()}...`)
  const { execute, extInfo } = await raydium.clmm.createPool({
    programId: DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID,
    mint1: tokenInfo(mintA),
    mint2: tokenInfo(mintB),
    ammConfig: {
      ...clmmConfig,
      id: new PublicKey(clmmConfig.id),
      fundOwner: '',
      description: '',
    },
    initialPrice: INITIAL_PRICE,
    txVersion,
  })

  const { txId } = await execute({ sendAndConfirm: true })
  const poolId = extInfo.address.id

  saveDevnetPoolState({
    cluster: 'devnet',
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    poolId,
    initialPrice: INITIAL_PRICE.toString(),
    poolTxId: txId,
  })

  console.log('Пул создан.')
  console.log(`Pool ID: ${poolId}`)
  console.log(`Transaction: https://explorer.solana.com/tx/${txId}?cluster=devnet`)
  console.log(`Pool: https://explorer.solana.com/address/${poolId}?cluster=devnet`)
  console.log(`Адреса сохранены в ${devnetPoolStatePath}`)
}

createPoolWithNewTokens().catch((error: unknown) => {
  console.error('Не удалось создать devnet CLMM-пул:', error)
  process.exitCode = 1
})
