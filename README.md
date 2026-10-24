# RAYDIUM SDK V2 demo

## About the project

This project is for [RAYDIUM SDK V2](https://github.com/raydium-io/raydium-sdk-V2) demonstration

## Getting Started

### Installation

`yarn install`

this will install the dependencies for running the demo script

### Prerequisites

Modify `config.ts.template` to fit your configuration, and rename it to `config.ts`

- `<YOUR_WALLET_SECRET_KEY>`: replace to your own one
- `<YOUR_RPC_URL>`: replace to your prefer one
- `<API_HOST>`: by default it's no needed to provide raydium api host, only provide it when test on devnet.

### Usage

- `yarn dev src/<FOLDER>/<SCRIPT_NAME>` run the specific demo script, e.g. yarn dev src/cpmm/deposit.ts. **Note: if you want to execute tx, remember to uncomment code in last line**
- `yarn clmm-market 8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj 10 20` run clmm market maker, arguments 0: poolId, 1: create position deviation, 2: close position deviation, remember to uncomment `close position` and `create new position` code part

### Отчёт: AMM и концентрированная ликвидность Raydium CLMM (Devnet)

#### Цель и выполненная работа

Цель задания — на практике изучить автоматический маркет-мейкер (AMM), создать свои тестовые токены, пул Raydium CLMM и открыть в нём позицию ликвидности с выбранным ценовым диапазоном.

Работа выполнена в сети Solana Devnet. Созданы два SPL-токена с точностью 6 знаков, затем из них создан CLMM-пул с начальной ценой 1 Mint B за 1 Mint A. После этого со своего кошелька создана позиция CLMM. Владение позицией представлено NFT.

#### Результаты

| Параметр | Результат |
| --- | --- |
| Сеть | Solana Devnet |
| Mint A | `DZo9sTg7DZHWmYeksnd2ToswZQeodoerDhfL2QKijLM` |
| Mint B | `2gAkMcGpnRHQC19xKrZNPTHgpZsYnbwBaC4U2Xyw9HwR` |
| Адрес CLMM-пула | `CJHjMSha5MJGXguFz8i2D8uyErvYxGoqddUJYoWS4LfM` |
| Vault токена Mint A | `A8mF25PrLcMJYPYuiYyvYQ8pth2J6GC6oZdt4zt5DVAD` |
| Vault токена Mint B | `CvF7oQot5nuMbPNteEP7Vh52ocgBGj4RNPsB6fPGTWhC` |
| Начальная цена | 1 Mint B за 1 Mint A |
| Цена пула после создания позиции | 1 Mint B за 1 Mint A |
| Нижняя граница позиции | 0.9 Mint B за 1 Mint A |
| Верхняя граница позиции | 1.1 Mint B за 1 Mint A |
| NFT позиции | `78Cb5yk5poLZDay4WCeQTq3Es89Hj3VDjNP3q6h5wwTq` |

- [Пул в Solana Explorer (Devnet)](https://explorer.solana.com/address/CJHjMSha5MJGXguFz8i2D8uyErvYxGoqddUJYoWS4LfM?cluster=devnet)
- [NFT позиции в Solana Explorer (Devnet)](https://explorer.solana.com/address/78Cb5yk5poLZDay4WCeQTq3Es89Hj3VDjNP3q6h5wwTq?cluster=devnet)
- [Транзакция создания пула](https://explorer.solana.com/tx/4YXHtRfgKC9LsbFswmQ61L4zwNZoTKy5sxpCAYGDi1hQSwq9pPekR1VJ2Kfc8Tzm7gEvu1Suf5RfFBu9BHrJJ5AL?cluster=devnet)
- [Транзакция открытия позиции](https://explorer.solana.com/tx/4426HbBKc5QksBNoh8SFmmFvNgujK525wMXBBtJ8PqeyowD6SazPe4RhQtWBbi6wp9Biemyknbiho6NgzrdqtWe?cluster=devnet)

#### Как работает AMM

В традиционной бирже покупатели и продавцы размещают заявки в книге ордеров. В AMM обмен происходит с пулом токенов, а не с конкретным встречным продавцом. В простом пуле постоянного произведения действует правило `x × y = k`, где `x` и `y` — количества двух токенов, а `k` — сохраняемое при обмене произведение. Когда трейдер забирает один токен из пула, его количество уменьшается, второго — увеличивается. Поэтому цена меняется вместе с балансом токенов, а крупная относительно пула сделка сильнее сдвигает цену (price impact).

#### Чем CLMM отличается от простого AMM

В простом AMM ликвидность распределена по всему диапазону возможных цен. В CLMM поставщик ликвидности выбирает диапазон, в котором его средства должны участвовать в обменах. В этой работе выбран диапазон `0.9–1.1 Mint B за Mint A` вокруг начальной цены `1`. Пока рыночная цена пула находится внутри диапазона, позиция может участвовать в обменах и получать долю комиссий. Это концентрирует капитал в более узком интервале, вместо распределения по всем ценам.

#### Что происходит за границами диапазона

Если цена выходит за выбранный диапазон, позиция не закрывается: NFT и позиция остаются у владельца. Но ликвидность этой позиции перестаёт участвовать в обменах и не получает торговые комиссии, пока цена не вернётся в диапазон или владелец не переместит ликвидность, открыв позицию для другого диапазона.

#### Почему узкий диапазон требует внимания

При одинаковом капитале узкий диапазон может предоставить больше активной ликвидности около текущей цены и, при наличии достаточного объёма торгов, приносить больше комиссий на вложенную сумму. При этом цена с большей вероятностью покинет узкий интервал, после чего позиция перестанет зарабатывать комиссии. Поэтому провайдеру нужно следить за ценой и при необходимости менять диапазон. Само создание позиции не гарантирует доход: для получения комиссий в пуле должны происходить обмены.

#### Скрипты для повторения

При необходимости повторить демонстрацию настройте `src/config.ts` на Devnet, пополните кошелёк тестовыми SOL и из корня проекта последовательно выполните:

```bash
yarn dev src/clmm/createPool.ts
yarn dev src/clmm/createPosition.ts
```

Каждый запуск `createPool.ts` создаёт новые токены и пул. Не запускайте его повторно, если хотите продолжить работу с уже созданным пулом. Текущие адреса и параметры сохранены в локальном игнорируемом Git файле `src/data/clmm-devnet-pool.json`.

### Sdk Methods

#### Transaction methods return data

all transaction related build function (e.g. await raydium.clmm.openPositionFromBase/ await raydium.cpmm.createPool ..etc) will return all transactions and instructions

```
const { execute, transaction, builder, extInfo } = await raydium.clmm.openPositionFromBase({ xxx })

```

- `transaction or transactions`: all built transactions
- `builder`: all instructions in transaction. e.g. builder.allInstructions, builder.AllTxData
- `extInfo`: transaction related publicKeys. (e.g: extInfo from raydium.cpmm.createPool includes poolId, programId...etc)

#### Fetch pool list by mints (mainnet only)

```
import { PoolFetchType } from '@raydium-io/raydium-sdk-v2'

const list = await raydium.api.fetchPoolByMints({
  mint1: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // required
  mint2: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // optional
  type: PoolFetchType.All, // optional
  sort: 'liquidity', // optional
  order: 'desc', // optional
  page: 1, // optional
})
```

### Fetch Mint info from Api or Rpc

```
await raydium.token.getTokenInfo('<Mint address>')
```

### Fetch token account

```
await raydium.account.fetchWalletTokenAccounts() // if need to force fetching token account, pass param { forceUpdate: true }
```

### More api methods [check here](https://github.com/raydium-io/raydium-sdk-V2?tab=readme-ov-file#api-methods-httpsgithubcomraydium-ioraydium-sdk-v2blobmastersrcapiapits)

### FAQ

#### Error: block height exceeded / exceeded CUs meter at BPF instruction

- transactions were expired, set higher priority fees (computeBudgetConfig) to make it go through smoothly
- if you are testing in devnet, remember to replace programId to devnet one.

#### raydium.api.fetchPoolById/raydium.api.fetchFarmInfoById return null

- currently api doesn't support devnet pool/farm data, please test on mainnet.
- only raydium.xxxx.getRpcPoolInfos support get devnet `rpc` pool info.
- new created pool needs couple minutes to sync data to api, if you want to get info immediately, use raydium.xxxx.getRpcPoolInfos instead.

#### create amm pool error

- `0x10001a9`: you might use https://openbook-tools.dexlab.space/market/create?network=devnet to create devnet market, and they used wrong devnet program id, so please use createMarket.ts in demo to create market
- `lp amount is too less`: please provide more base/quote amount when create pool, if there's SOL/WSOL in your market, it's better provide more than 4 sol(4\*10\*\*9) in initial amount.
