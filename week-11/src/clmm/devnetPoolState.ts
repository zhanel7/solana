import fs from 'fs'
import path from 'path'

export interface DevnetPoolState {
  cluster: 'devnet'
  mintA: string
  mintB: string
  poolId?: string
  vaultA?: string
  vaultB?: string
  initialPrice: string
  currentPrice?: string
  poolTxId?: string
  positionNftMint?: string
  positionTxId?: string
  lowerPrice?: string
  upperPrice?: string
}

export const devnetPoolStatePath = path.resolve(process.cwd(), 'src/data/clmm-devnet-pool.json')

export const saveDevnetPoolState = (state: DevnetPoolState) => {
  fs.mkdirSync(path.dirname(devnetPoolStatePath), { recursive: true })
  fs.writeFileSync(devnetPoolStatePath, `${JSON.stringify(state, null, 2)}\n`)
}

export const loadDevnetPoolState = (): DevnetPoolState => {
  if (!fs.existsSync(devnetPoolStatePath)) {
    throw new Error(`Не найден файл ${devnetPoolStatePath}. Сначала запустите yarn dev src/clmm/createPool.ts.`)
  }

  const state: unknown = JSON.parse(fs.readFileSync(devnetPoolStatePath, 'utf8'))
  if (
    typeof state !== 'object' ||
    state === null ||
    !('cluster' in state) ||
    state.cluster !== 'devnet' ||
    !('mintA' in state) ||
    typeof state.mintA !== 'string' ||
    !('mintB' in state) ||
    typeof state.mintB !== 'string' ||
    !('initialPrice' in state) ||
    typeof state.initialPrice !== 'string'
  ) {
    throw new Error(`Файл ${devnetPoolStatePath} поврежден или не содержит адрес созданного devnet-пула.`)
  }

  return state as DevnetPoolState
}
