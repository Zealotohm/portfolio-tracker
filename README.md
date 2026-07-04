# Ledger — Personal Portfolio Tracker (Cloudflare Workers + R2)

แอปติดตามพอร์ตการลงทุน (หุ้น / ETF / กองทุน / Crypto) รันบน Cloudflare ทั้งหมด — ไม่มี server อื่นให้ดูแล
ข้อมูลทั้งหมด (portfolio, transaction, cache ราคา) เก็บใน **R2** เป็นไฟล์ JSON

## ฟีเจอร์
- ดึงราคาสินทรัพย์อัตโนมัติทุกวัน (Cron Trigger) + ปุ่ม "อัปเดตราคา" กดเองได้ทันที
- บันทึก transaction (ซื้อ/ขาย/ปันผล) คำนวณ **ต้นทุนเฉลี่ยแบบถ่วงน้ำหนัก (weighted-average cost)** ซึ่งรองรับการทำ DCA โดยอัตโนมัติ — ทุกครั้งที่ซื้อเพิ่ม ต้นทุนเฉลี่ยจะถูกคำนวณใหม่ตามน้ำหนักของแต่ละไม้
- แสดงกำไร/ขาดทุนทั้งแบบ % และมูลค่า (ทั้งที่ยังไม่ขาย และที่รับรู้แล้ว + ปันผล)
- แบ่ง portfolio ย่อย (sub-portfolio) ได้ไม่จำกัดชั้น พร้อมตัวเลือก "รวม sub-portfolio" ในหน้าสรุป
- กราฟสัดส่วนการถือครอง (โดย symbol และโดยประเภทสินทรัพย์)
- รองรับหลายสกุลเงิน แปลงกลับเป็นสกุลเงินหลัก (base currency) อัตโนมัติผ่าน Frankfurter FX API
- Ticker tape แสดงราคาล่าสุด + % แบบ real-time-ish ที่ด้านบนของแอป

## แหล่งข้อมูลราคา (ฟรี/ฟรีเมียม)
| ประเภท | แหล่งข้อมูล | หมายเหตุ |
|---|---|---|
| หุ้น / ETF / กองทุน | Yahoo Finance (unofficial chart API) | ไม่ต้องใช้ API key รองรับตลาดทั่วโลกผ่าน suffix เช่น `AAPL`, `VOO`, `PTT.BK`, `0700.HK`, `VOD.L` |
| Crypto | CoinGecko public API | ใช้ **CoinGecko id** เป็นสัญลักษณ์ เช่น `bitcoin`, `ethereum`, `solana` (เช็ค id ได้ที่ coingecko.com) |
| อัตราแลกเปลี่ยน | Frankfurter.app (ECB) | ฟรี ไม่ต้องใช้ key |
| กองทุนรวมไทย | SEC Open Data API (`/v2/fund/daily-info/nav`) | ต้องสมัครขอ subscription key ฟรีที่ [api-portal.sec.or.th](https://api-portal.sec.or.th) |

สามตัวแรกไม่ต้องขอ API key เลย เหมาะกับการใช้งานคนเดียว แต่มี rate limit — แอปนี้ cache ผลลัพธ์ไว้ใน R2 และ fetch ใหม่แค่วันละครั้ง (cron) หรือเมื่อกดปุ่ม "อัปเดตราคา" เท่านั้น จึงไม่ชนขีดจำกัด

### กองทุนรวมไทย (SEC Open API)
1. สมัครขอ subscription key ฟรีที่ [api-portal.sec.or.th](https://api-portal.sec.or.th) แล้วตั้งเป็น secret:
   ```bash
   npx wrangler secret put SEC_API_KEY
   ```
2. ในฟอร์มเพิ่ม transaction เลือกประเภทสินทรัพย์เป็น "กองทุนไทย (SEC)"
3. ช่อง "สัญลักษณ์" ต้องใส่เป็น proj_id ของกองทุน (รูปแบบเช่น `M0001_2560`) ไม่ใช่ชื่อย่อกองทุนอย่าง `KFINDIARMF` — proj_id หาได้จากเว็บค้นหากองทุนของ AIMC/SEC ที่ thaimutualfund.com/AIMC/mutualFundCenter.jsp
4. ระบบจะดึง NAV ล่าสุดจาก SEC มาอัตโนมัติเหมือนหุ้น/crypto

หมายเหตุความแม่นยำ: เอกสารสาธารณะของ endpoint นี้ไม่ได้ระบุ field ผลลัพธ์ไว้ชัดเจน 100% โค้ดใน src/lib/priceProviders.js (ฟังก์ชัน fetchSecFundNav) จึงเผื่อไว้หลายชื่อ field ที่เป็นไปได้ (last_val, sell_price, nav, value) หากทดสอบแล้วราคาไม่ขึ้นหรือ error บอกว่าไม่เจอ field ราคา ให้ดู error message (จะ log ตัวอย่าง response ออกมาให้) แล้วแจ้งกลับมาเพื่อแก้ชื่อ field ให้ตรงกับของจริงได้ทันที

> ถ้าต้องการความแม่นยำ/ความเร็วสูงขึ้นในอนาคต สามารถสลับไปใช้ผู้ให้บริการแบบมี API key (Twelve Data, Alpha Vantage, Financial Modeling Prep) ได้โดยแก้เฉพาะไฟล์ `src/lib/priceProviders.js`

## โครงสร้างโปรเจกต์
```
portfolio-tracker/
  wrangler.toml          # config: R2 binding, cron, static assets
  src/
    index.js             # Worker entry: API routes + scheduled handler
    lib/
      storage.js          # R2 read/write helpers
      priceProviders.js   # Yahoo / CoinGecko / Frankfurter fetchers
      calc.js              # cost-basis + P/L + allocation calculations
      auth.js              # shared-password auth
  public/                 # frontend (plain HTML/CSS/JS + Chart.js via CDN)
    index.html
    style.css
    app.js
```

## วิธี Deploy

### 1. เตรียมเครื่องมือ
```bash
npm install
npx wrangler login
```

### 2. สร้าง R2 bucket
```bash
npx wrangler r2 bucket create portfolio-tracker-data
```
(ชื่อ bucket ต้องตรงกับใน `wrangler.toml` ถ้าเปลี่ยนชื่อ ให้แก้ในไฟล์นั้นด้วย)

### 3. ตั้งรหัสผ่านเข้าแอป
```bash
npx wrangler secret put APP_PASSWORD
```
ระบบจะถามให้พิมพ์รหัสผ่าน — นี่คือรหัสผ่านเดียวที่ใช้ล็อกอินเข้าแอป (ออกแบบมาสำหรับใช้คนเดียว ไม่มีระบบสมัครสมาชิก)

### 4. ตั้งสกุลเงินหลัก (ไม่บังคับ)
แก้ค่า `BASE_CURRENCY` ใน `wrangler.toml` (ค่าเริ่มต้นคือ `THB`) เป็นสกุลเงินที่ต้องการให้สรุปยอดรวม เช่น `USD`

### 5. Deploy
```bash
npx wrangler deploy
```
เสร็จแล้วจะได้ URL แบบ `https://portfolio-tracker.<your-subdomain>.workers.dev`

### 6. ทดสอบ local (ไม่บังคับ)
```bash
npx wrangler dev
```
สร้างไฟล์ `.dev.vars` ในเครื่อง (ไม่ต้อง commit) ใส่:
```
APP_PASSWORD=รหัสผ่านของคุณตอน dev
```

## วิธีใช้งาน
1. เข้าเว็บแอป ใส่รหัสผ่านที่ตั้งไว้
2. สร้าง Portfolio หลัก (เช่น "ระยะยาว", "เก็งกำไร") และสร้าง sub-portfolio ข้างในได้ตามต้องการ
3. เพิ่ม transaction: ระบุ symbol ตามแหล่งข้อมูล (หุ้น/ETF/กองทุน = Yahoo ticker, crypto = CoinGecko id)
4. กด "อัปเดตราคา" ครั้งแรกเพื่อดึงราคาเข้าระบบ (หลังจากนั้นจะอัปเดตอัตโนมัติทุกวันตาม cron)
5. ดูสรุปกำไร/ขาดทุน สัดส่วนการถือครอง และกราฟที่หน้าแรกของแต่ละ portfolio หรือเลือก "All Portfolios" เพื่อดูภาพรวมทั้งหมด

## หลักการคำนวณต้นทุน (Weighted-Average Cost / DCA)
ทุกครั้งที่มีการ **ซื้อ** ระบบจะคำนวณต้นทุนเฉลี่ยใหม่ตามสูตร:
```
ต้นทุนเฉลี่ยใหม่ = (จำนวนเดิม × ต้นทุนเฉลี่ยเดิม + จำนวนที่ซื้อใหม่ × ราคาที่ซื้อ + ค่าธรรมเนียม) / จำนวนรวมใหม่
```
เมื่อมีการ **ขาย** ระบบจะคิดกำไร/ขาดทุนที่รับรู้แล้ว (realized P/L) จากส่วนต่างระหว่างราคาขายกับต้นทุนเฉลี่ย ณ ขณะนั้น โดยไม่กระทบต้นทุนเฉลี่ยของจำนวนที่เหลืออยู่ — นี่คือวิธีมาตรฐานที่ใช้กับการทำ DCA เพราะทุกไม้ที่ซื้อเพิ่มจะถูกถ่วงน้ำหนักตามเวลาและขนาดของแต่ละธุรกรรมโดยอัตโนมัติ

## ข้อจำกัดที่ควรทราบ
- Yahoo Finance chart API เป็น endpoint ที่ไม่เป็นทางการ อาจมีการเปลี่ยนแปลงหรือถูกจำกัดในอนาคต หากพบปัญหาให้สลับไปใช้ผู้ให้บริการแบบมี key ตามที่แนะนำด้านบน
- ระบบรองรับผู้ใช้คนเดียว (single shared password) ไม่เหมาะกับการเปิดให้หลายคนใช้ร่วมกันโดยไม่ปรับระบบ auth เพิ่มเติม
- ราคากองทุน (mutual fund) บาง fund house ในไทยอาจไม่มีใน Yahoo Finance — กรณีนี้แนะนำให้บันทึก transaction ไว้ก่อน แล้วอัปเดตราคาด้วยการแก้ไขราคาล่าสุดผ่าน R2 โดยตรง หรือขยาย `priceProviders.js` ให้ดึงจากเว็บ AIMC/บลจ. โดยเฉพาะ
