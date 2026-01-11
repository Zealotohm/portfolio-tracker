```ts
import { getPrice } from './price'

export default {
async fetch(req: Request, env: any) {
const url = new URL(req.url)

if (url.pathname === '/api/portfolio') {
const data = await env.DB.prepare(`
SELECT h.units, h.avg_cost, a.symbol, a.type
FROM holdings h
JOIN assets a ON h.asset_id = a.id
`).all()

const result = await Promise.all(data.results.map(async (h: any) => {
const price = await getPrice(h.symbol, h.type)
const cost = h.units * h.avg_cost
const value = h.units * price

return {
symbol: h.symbol,
type: h.type,
units: h.units,
avg_cost: h.avg_cost,
current_price: price,
market_value: value,
pnl_amount: value - cost,
pnl_percent: ((value - cost) / cost) * 100
}
}))

return Response.json(result)
}

return new Response('Not Found', { status: 404 })
}
}
```

