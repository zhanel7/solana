import { TickUtil } from '@raydium-io/raydium-sdk-v2'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { connection, initSdk, txVersion } from '../config'
import { loadDevnetPoolState, saveDevnetPoolState } from './devnetPoolState'

const LOWER_PRICE = new Decimal('0.9')
const UPPER_PRICE = new Decimal('1.1')
const BASE_AMOUNT = new Decimal('100')
const MAX_OTHER_AMOUNT = new Decimal('200')

export const createPosition = async () => {
  const state = loadDevnetPoolState()
  if (!state.poolId) throw new Error('В сохраненном состоянии нет Pool ID. Сначала успешно создайте пул.')

  const raydium = await initSdk({ loadToken: true })
  const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId: state.poolId })
  const mintAAddress = rpcData.mintA.toBase58()
  const mintBAddress = rpcData.mintB.toBase58()
  const mintAccounts = await connection.getMultipleAccountsInfo([rpcData.mintA, rpcData.mintB])
  const mintAccountA = mintAccounts[0]
  const mintAccountB = mintAccounts[1]
  if (!mintAccountA || !mintAccountB) throw new Error('Не удалось загрузить mint-аккаунты пула из devnet RPC.')
  if (!mintAccountA.owner.equals(TOKEN_PROGRAM_ID) || !mintAccountB.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error('Скрипт ожидает два стандартных SPL Token mint, созданных createPool.ts.')
  }

  const expectedMints = new Set([state.mintA, state.mintB])
  if (!expectedMints.has(mintAAddress) || !expectedMints.has(mintBAddress)) {
    throw new Error('Адреса токенов в сохраненном состоянии не совпадают с mint-адресами пула в devnet.')
  }

  const clmmConfigs = await raydium.api.getClmmConfigs()
  const config = clmmConfigs.find((item) => item.id === rpcData.configId.toBase58())
  if (!config) {
    throw new Error(`Не удалось найти CLMM-конфигурацию ${rpcData.configId.toBase58()} через Raydium API.`)
  }

  const poolInfo = {
    id: state.poolId,
    programId: rpcData.programId.toBase58(),
    mintA: {
      address: mintAAddress,
      programId: mintAccountA.owner.toBase58(),
      decimals: rpcData.mintDecimalsA,
    },
    mintB: {
      address: mintBAddress,
      programId: mintAccountB.owner.toBase58(),
      decimals: rpcData.mintDecimalsB,
    },
    config: {
      id: config.id,
      tickSpacing: config.tickSpacing,
    },
  }
  const currentPrice = new Decimal(rpcData.currentPrice)

  if (LOWER_PRICE.gte(currentPrice) || UPPER_PRICE.lte(currentPrice)) {
    throw new Error(
      `Текущая цена ${currentPrice.toString()} не входит в диапазон ${LOWER_PRICE.toString()}–${UPPER_PRICE.toString()}. Измените LOWER_PRICE/UPPER_PRICE в createPosition.ts.`,
    )
  }

  const tickLower = TickUtil.toTickIndex(
    TickUtil.priceToTick(LOWER_PRICE, poolInfo.mintA.decimals, poolInfo.mintB.decimals),
    poolInfo.config.tickSpacing,
  )
  const tickUpper = TickUtil.toTickIndex(
    TickUtil.priceToTick(UPPER_PRICE, poolInfo.mintA.decimals, poolInfo.mintB.decimals),
    poolInfo.config.tickSpacing,
  )
  if (tickLower >= tickUpper) throw new Error('Некорректный диапазон тиков для этой конфигурации пула.')

  const baseAmount = new BN(BASE_AMOUNT.mul(10 ** poolInfo.mintA.decimals).toFixed(0))
  const otherAmountMax = new BN(MAX_OTHER_AMOUNT.mul(10 ** poolInfo.mintB.decimals).toFixed(0))

  console.log(`Pool ID: ${state.poolId}`)
  console.log(`Текущая цена Mint B за Mint A: ${currentPrice.toString()}`)
  console.log(`Диапазон позиции: ${LOWER_PRICE.toString()}–${UPPER_PRICE.toString()}`)
  console.log(`Вносим до ${BASE_AMOUNT.toString()} Mint A и до ${MAX_OTHER_AMOUNT.toString()} Mint B.`)

  const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys: {
      vault: {
        A: rpcData.vaultA.toBase58(),
        B: rpcData.vaultB.toBase58(),
      },
    },
    base: 'MintA',
    ownerInfo: { useSOLBalance: false },
    tickLower,
    tickUpper,
    baseAmount,
    otherAmountMax,
    nft2022: true,
    txVersion,
  })

  const { txId } = await execute({ sendAndConfirm: true })
  const positionNftMint = extInfo.nftMint.toBase58()
  saveDevnetPoolState({
    ...state,
    vaultA: rpcData.vaultA.toBase58(),
    vaultB: rpcData.vaultB.toBase58(),
    currentPrice: currentPrice.toString(),
    lowerPrice: LOWER_PRICE.toString(),
    upperPrice: UPPER_PRICE.toString(),
    positionNftMint,
    positionTxId: txId,
  })

  console.log('Позиция CLMM создана.')
  console.log(`Position NFT: ${positionNftMint}`)
  console.log(`Transaction: https://explorer.solana.com/tx/${txId}?cluster=devnet`)
  console.log(`Position NFT: https://explorer.solana.com/address/${positionNftMint}?cluster=devnet`)
}

createPosition().catch((error: unknown) => {
  console.error('Не удалось открыть CLMM-позицию:', error)
  process.exitCode = 1
})
