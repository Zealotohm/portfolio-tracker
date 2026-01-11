```ts
export async function getPrice(symbol: string, type: string): Promise<number> {
if (type === 'CRYPTO') {
const idMap: Record<string, string> = {
BTC: 'bitcoin',
ETH: 'ethereum'
}

const id = idMap[symbol]
const res = await fetch(
`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=thb`
)
const json = await res.json()
return json[id].thb
}

// placeholder for TH_STOCK / TH_FUND
return 0
}
```
