```jsx
import { useEffect, useState } from 'react'
import { fetchPortfolio } from './api'

export default function App() {
const [data, setData] = useState([])

useEffect(() => {
fetchPortfolio().then(setData)
}, [])

return (
<div style={{ padding: 24 }}>
<h1>Portfolio Tracker</h1>
<table border="1" cellPadding="8">
<thead>
<tr>
<th>Asset</th>
<th>Units</th>
<th>Avg Cost</th>
<th>Price</th>
<th>P/L</th>
<th>P/L %</th>
</tr>
</thead>
<tbody>
{data.map((d, i) => (
<tr key={i}>
<td>{d.symbol}</td>
<td>{d.units}</td>
<td>{d.avg_cost}</td>
<td>{d.current_price}</td>
<td>{d.pnl_amount.toFixed(2)}</td>
<td>{d.pnl_percent.toFixed(2)}%</td>
</tr>
))}
</tbody>
</table>
</div>
)
}
```
