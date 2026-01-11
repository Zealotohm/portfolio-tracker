```js
export async function fetchPortfolio() {
const res = await fetch('/api/portfolio')
return res.json()
}
```
