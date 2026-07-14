const state = {
  password: localStorage.getItem("ledger_pw") || "",
  portfolios: [],
  currentId: null, // null = "All portfolios"
  summary: null,
  transactions: [],
  charts: {},
  editingTxId: null,
  editingPortfolioId: null,
  settings: { appName: "SabaiPort" },
  txPage: 1,
  txPageSize: Number(localStorage.getItem("tx_page_size")) || 10,
};

const BASE_CCY_FALLBACK = "THB";

function fmt(n, opts = {}) {
  if (n == null || Number.isNaN(n)) return "–";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2, ...opts }).format(n);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-app-password": state.password,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    showLogin("รหัสผ่านไม่ถูกต้อง หรือหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

// ---------- Settings (app name) ----------
function applySettingsToDom() {
  const name = state.settings.appName || "SabaiPort";
  document.getElementById("brand-name-login").textContent = name;
  document.getElementById("brand-name-app").textContent = name;
  document.getElementById("page-title").textContent = `${name} — Portfolio Tracker`;
}

async function loadSettings() {
  try {
    state.settings = await fetch("/api/settings").then((r) => r.json());
  } catch (e) {
    // keep default appName if this fails - not critical enough to block the login screen
  }
  applySettingsToDom();
}

const appnameModal = document.getElementById("appname-modal");
document.getElementById("btn-edit-appname").addEventListener("click", () => {
  document.getElementById("appname-input").value = state.settings.appName || "SabaiPort";
  appnameModal.classList.remove("hidden");
});
document.getElementById("btn-cancel-appname").addEventListener("click", () => {
  appnameModal.classList.add("hidden");
});
document.getElementById("appname-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const appName = document.getElementById("appname-input").value.trim();
  if (!appName) return;
  try {
    state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ appName }) });
    applySettingsToDom();
    appnameModal.classList.add("hidden");
  } catch (err) {
    alert("บันทึกไม่สำเร็จ: " + err.message);
  }
});

// ---------- Login ----------
function showLogin(errorMsg) {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("login-error").textContent = errorMsg || "";
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("login-password").value;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (data.ok) {
      state.password = pw;
      localStorage.setItem("ledger_pw", pw);
      document.getElementById("login-screen").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");
      boot();
    } else {
      document.getElementById("login-error").textContent = "รหัสผ่านไม่ถูกต้อง";
    }
  } catch (err) {
    document.getElementById("login-error").textContent = "เชื่อมต่อไม่สำเร็จ";
  }
});

// ---------- Boot ----------
async function boot() {
  await loadPortfolios();
  await loadSummaryAndTx();
  document.getElementById("btn-refresh").addEventListener("click", refreshPrices);
}

async function loadPortfolios() {
  state.portfolios = await api("/api/portfolios");
  renderPortfolioTree();
  renderParentSelect();
}

function renderPortfolioTree() {
  const el = document.getElementById("portfolio-tree");
  el.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = "portfolio-item" + (state.currentId === null ? " active" : "");
  allItem.textContent = "All Portfolios";
  allItem.onclick = () => selectPortfolio(null);
  el.appendChild(allItem);

  const roots = state.portfolios.filter((p) => !p.parentId);
  const renderNode = (p, depth) => {
    const item = document.createElement("div");
    item.className = "portfolio-item" + (depth > 0 ? " child" : "") + (state.currentId === p.id ? " active" : "");
    item.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="item-actions"><span class="edit" data-id="${p.id}">✎</span><span class="del" data-id="${p.id}">✕</span></span>`;
    item.querySelector("span").onclick = () => selectPortfolio(p.id);
    item.querySelector(".edit").onclick = (e) => { e.stopPropagation(); openEditPortfolio(p); };
    item.querySelector(".del").onclick = (e) => { e.stopPropagation(); deletePortfolio(p.id); };
    el.appendChild(item);
    const children = state.portfolios.filter((c) => c.parentId === p.id);
    children.forEach((c) => renderNode(c, depth + 1));
  };
  roots.forEach((r) => renderNode(r, 0));
}

function renderParentSelect(excludeId) {
  const sel = document.getElementById("p-parent");
  sel.innerHTML = '<option value="">— ไม่มี (พอร์ตหลัก) —</option>';
  const excluded = new Set();
  if (excludeId) {
    excluded.add(excludeId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of state.portfolios) {
        if (p.parentId && excluded.has(p.parentId) && !excluded.has(p.id)) {
          excluded.add(p.id);
          changed = true;
        }
      }
    }
  }
  state.portfolios
    .filter((p) => !excluded.has(p.id))
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
}

function selectPortfolio(id) {
  state.currentId = id;
  renderPortfolioTree();
  const p = state.portfolios.find((x) => x.id === id);
  document.getElementById("current-portfolio-name").textContent = p ? p.name : "All Portfolios";
  document.getElementById("current-portfolio-sub").textContent = p ? "รายละเอียดพอร์ตนี้" : "ภาพรวมทุกพอร์ตรวมกัน";
  loadSummaryAndTx();
}

async function deletePortfolio(id) {
  const p = state.portfolios.find((x) => x.id === id);
  let txCount = 0;
  try {
    txCount = (await api(`/api/transactions/${id}`)).length;
  } catch (e) {
    // if this fails we still let the user decide below, just without the exact count
  }
  const warning = txCount > 0
    ? `ลบ portfolio "${p ? p.name : id}"? การลบนี้จะลบ transaction ทั้งหมด ${txCount} รายการข้างในไปด้วย และไม่สามารถกู้คืนได้`
    : `ลบ portfolio "${p ? p.name : id}"? (ต้องไม่มี sub-portfolio อยู่ข้างใน)`;
  if (!confirm(warning)) return;
  try {
    await api(`/api/portfolios/${id}`, { method: "DELETE" });
    if (state.currentId === id) state.currentId = null;
    await loadPortfolios();
    await loadSummaryAndTx();
  } catch (e) {
    alert(e.message);
  }
}

// ---------- Summary + Transactions ----------
// Guards against overlapping loads: clicking portfolio A then quickly clicking B fires two
// requests, and without this, whichever happened to resolve last would win and overwrite the
// correct (more recent) view - making clicks look unresponsive and needing repeated clicking.
let loadRequestId = 0;
async function loadSummaryAndTx() {
  const requestId = ++loadRequestId;
  const includeSub = document.getElementById("include-sub").checked;
  let summary, transactions;
  if (state.currentId === null) {
    [summary, transactions] = await Promise.all([api("/api/summary-all"), Promise.resolve([])]);
  } else {
    [summary, transactions] = await Promise.all([
      api(`/api/summary/${state.currentId}?includeSub=${includeSub}`),
      api(`/api/transactions/${state.currentId}`),
    ]);
  }
  if (requestId !== loadRequestId) return; // a newer load started while this one was in flight

  state.summary = summary;
  state.transactions = transactions;
  state.txPage = 1;
  renderSummary();
  renderCharts();
  renderPositions();
  renderTransactions();
}

document.getElementById("include-sub").addEventListener("change", loadSummaryAndTx);

function renderSummary() {
  const s = state.summary;
  document.getElementById("stat-value").textContent = `${fmt(s.totalValue)} ${s.baseCurrency}`;
  document.getElementById("stat-cost").textContent = `${fmt(s.totalCost)} ${s.baseCurrency}`;

  const pnlEl = document.getElementById("stat-pnl");
  const pnlPctEl = document.getElementById("stat-pnl-pct");
  pnlEl.textContent = `${s.totalUnrealizedPnL >= 0 ? "+" : ""}${fmt(s.totalUnrealizedPnL)} ${s.baseCurrency}`;
  pnlPctEl.textContent = `${s.totalUnrealizedPnLPct >= 0 ? "+" : ""}${fmt(s.totalUnrealizedPnLPct)}%`;
  const cls = s.totalUnrealizedPnL >= 0 ? "gain" : "loss";
  pnlEl.className = "card-value mono " + cls;
  pnlPctEl.className = "card-sub mono " + cls;

  document.getElementById("stat-realized").textContent =
    `${fmt(s.totalRealizedPnL + s.totalDividends)} ${s.baseCurrency}`;

  document.getElementById("last-updated").textContent = s.priceUpdatedAt
    ? "ราคาอัปเดต: " + new Date(s.priceUpdatedAt).toLocaleString("th-TH")
    : "ยังไม่เคยอัปเดตราคา";

  const fxBanner = document.getElementById("fx-warning-banner");
  if (s.fxWarnings && s.fxWarnings.length > 0) {
    fxBanner.textContent = `⚠ ไม่มีอัตราแลกเปลี่ยนสำหรับ: ${s.fxWarnings.join(", ")} — ตัวเลขบางส่วนด้านล่างอาจไม่ถูกต้องหรือไม่แสดงมูลค่า`;
    fxBanner.classList.remove("hidden");
  } else {
    fxBanner.classList.add("hidden");
  }
}

function renderCharts() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js ยังไม่โหลด — ข้ามการวาดกราฟรอบนี้");
    return;
  }
  const s = state.summary;
  const ctx1 = document.getElementById("chart-allocation");
  const ctx2 = document.getElementById("chart-type");
  const palette = ["#c9a227", "#3daa6b", "#5b8ad6", "#d65b5b", "#9a6bd6", "#4bb8c4", "#d68a3f", "#8b95a6"];

  if (state.charts.alloc) state.charts.alloc.destroy();
  if (state.charts.type) state.charts.type.destroy();

  state.charts.alloc = new Chart(ctx1, {
    type: "doughnut",
    data: {
      labels: s.allocationBySymbol.map((a) => a.symbol),
      datasets: [{ data: s.allocationBySymbol.map((a) => a.value), backgroundColor: palette, borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { position: "right", labels: { color: "#8b95a6", boxWidth: 12, font: { family: "Inter" } } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const a = s.allocationBySymbol[c.dataIndex];
              return `${a.symbol}: ${fmt(a.value)} ${s.baseCurrency} (${fmt(a.pct, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%)`;
            },
          },
        },
      },
      maintainAspectRatio: false,
    },
  });

  state.charts.type = new Chart(ctx2, {
    type: "doughnut",
    data: {
      labels: s.allocationByType.map((a) => assetTypeLabel(a.assetType)),
      datasets: [{ data: s.allocationByType.map((a) => a.value), backgroundColor: palette, borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { position: "right", labels: { color: "#8b95a6", boxWidth: 12, font: { family: "Inter" } } },
      },
      maintainAspectRatio: false,
    },
  });
}

function assetTypeLabel(t) {
  return { stock: "หุ้น", etf: "ETF", fund: "กองทุน", thai_fund: "กองทุนไทย", crypto: "Crypto" }[t] || t;
}

function renderPositions() {
  const body = document.getElementById("positions-body");
  body.innerHTML = "";
  state.summary.positions
    .filter((p) => p.quantity > 0)
    .forEach((p) => {
      const cls = p.unrealizedPnLBase >= 0 ? "gain" : "loss";
      const tr = document.createElement("tr");
      const staleBadge = p.fxMissing ? ` <span class="badge-warn" title="ไม่มีอัตราแลกเปลี่ยนล่าสุด ตัวเลขนี้อาจไม่ถูกต้อง">⚠ FX</span>` : "";
      const today = new Date().toISOString().slice(0, 10);
      const priceDateNote =
        p.currentPrice != null && p.priceDate
          ? `<br/><span class="muted small">${p.priceDate === today ? "" : "ณ วันที่ " + p.priceDate}${p.priceStale ? " (ราคาย้อนหลัง)" : ""}</span>`
          : "";
      tr.innerHTML = `
        <td class="label-cell">${escapeHtml(p.symbol)}<br/><span class="muted small">${assetTypeLabel(p.assetType)}</span></td>
        <td>${fmt(p.quantity, { maximumFractionDigits: 6, minimumFractionDigits: 0 })}</td>
        <td>${fmt(p.avgCost)} ${escapeHtml(p.currency)}</td>
        <td>${p.currentPrice != null ? fmt(p.currentPrice) + " " + escapeHtml(p.quoteCurrency) : "–"} <button type="button" class="icon-btn" data-action="edit-price" title="ตั้งราคาด้วยตนเอง">✎</button>${priceDateNote}</td>
        <td>${p.marketValueBase != null ? fmt(p.marketValueBase) + " " + escapeHtml(state.summary.baseCurrency) : "–"}${staleBadge}</td>
        <td class="${cls}">${p.unrealizedPnLBase != null ? (p.unrealizedPnLBase >= 0 ? "+" : "") + fmt(p.unrealizedPnLBase) : "–"}</td>
        <td class="${cls}">${p.unrealizedPnLPct != null ? (p.unrealizedPnLPct >= 0 ? "+" : "") + fmt(p.unrealizedPnLPct, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + "%" : "–"}</td>
      `;
      tr.querySelector('[data-action="edit-price"]').onclick = () => openPriceModal(p);
      body.appendChild(tr);
    });
}

function renderTransactions() {
  const body = document.getElementById("tx-body");
  body.innerHTML = "";
  const disabled = state.currentId === null;
  document.getElementById("btn-add-tx").disabled = disabled;
  document.getElementById("btn-add-tx").title = disabled ? "เลือก portfolio ก่อนเพื่อเพิ่มรายการ" : "";

  const sorted = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
  const totalPages = Math.max(1, Math.ceil(sorted.length / state.txPageSize));
  state.txPage = Math.min(Math.max(1, state.txPage), totalPages);
  const start = (state.txPage - 1) * state.txPageSize;
  const pageItems = sorted.slice(start, start + state.txPageSize);

  pageItems.forEach((t) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${t.date}</td>
        <td class="label-cell">${txTypeLabel(t.type)}</td>
        <td class="label-cell">${escapeHtml(t.symbol)}</td>
        <td>${fmt(t.quantity, { maximumFractionDigits: 6, minimumFractionDigits: 0 })}</td>
        <td>${fmt(t.price)}</td>
        <td>${fmt(t.fees || 0)}</td>
        <td class="label-cell">${escapeHtml(t.currency)}</td>
        <td class="label-cell muted small">${escapeHtml(t.note || "")}</td>
        <td class="row-actions">
          <button class="icon-btn" data-action="edit" data-id="${t.id}">✎</button>
          <button class="icon-btn" data-action="delete" data-id="${t.id}">✕</button>
        </td>
      `;
      tr.querySelector('[data-action="edit"]').onclick = () => openEditTx(t);
      tr.querySelector('[data-action="delete"]').onclick = () => deleteTx(t.id);
      body.appendChild(tr);
  });

  document.getElementById("tx-page-info").textContent =
    sorted.length === 0 ? "ไม่มีรายการ" : `หน้า ${state.txPage} จาก ${totalPages} (ทั้งหมด ${sorted.length} รายการ)`;
  document.getElementById("tx-page-prev").disabled = state.txPage <= 1;
  document.getElementById("tx-page-next").disabled = state.txPage >= totalPages;
  document.getElementById("tx-page-size").value = String(state.txPageSize);
}

document.getElementById("tx-page-prev").addEventListener("click", () => {
  state.txPage -= 1;
  renderTransactions();
});
document.getElementById("tx-page-next").addEventListener("click", () => {
  state.txPage += 1;
  renderTransactions();
});
document.getElementById("tx-page-size").addEventListener("change", (e) => {
  state.txPageSize = Number(e.target.value);
  localStorage.setItem("tx_page_size", String(state.txPageSize));
  state.txPage = 1;
  renderTransactions();
});

function txTypeLabel(t) {
  return { buy: "ซื้อ", sell: "ขาย", dividend: "ปันผล" }[t] || t;
}

async function deleteTx(id) {
  if (!confirm("ลบรายการนี้?")) return;
  await api(`/api/transactions/${state.currentId}/${id}`, { method: "DELETE" });
  await loadSummaryAndTx();
}

async function refreshPrices() {
  const btn = document.getElementById("btn-refresh");
  btn.disabled = true;
  btn.textContent = "กำลังอัปเดต...";
  try {
    const result = await api("/api/refresh-prices", { method: "POST" });
    await loadSummaryAndTx();
    const failedSymbols = result.failedSymbols || [];
    const failedCurrencies = result.failedCurrencies || [];
    if (failedSymbols.length > 0 || failedCurrencies.length > 0) {
      const parts = [];
      if (failedSymbols.length > 0) parts.push(`ราคา: ${failedSymbols.join(", ")}`);
      if (failedCurrencies.length > 0) parts.push(`อัตราแลกเปลี่ยน: ${failedCurrencies.join(", ")}`);
      alert(`อัปเดตไม่สำเร็จบางรายการ (ยังใช้ค่าล่าสุดที่เคยดึงได้อยู่):\n${parts.join("\n")}`);
    }
  } catch (e) {
    alert("อัปเดตราคาไม่สำเร็จ: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "↻ อัปเดตราคา";
  }
}

// ---------- Manual price override ----------
const priceModal = document.getElementById("price-modal");
let priceModalSymbol = null;

function openPriceModal(p) {
  priceModalSymbol = p.symbol;
  document.getElementById("price-modal-symbol").textContent = p.symbol;
  document.getElementById("price-input").value = p.currentPrice ?? "";
  document.getElementById("price-currency-input").value = p.quoteCurrency || p.currency;
  document.getElementById("price-date-input").value = new Date().toISOString().slice(0, 10);
  priceModal.classList.remove("hidden");
}
document.getElementById("btn-cancel-price").addEventListener("click", () => {
  priceModal.classList.add("hidden");
});
document.getElementById("price-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    price: document.getElementById("price-input").value,
    currency: document.getElementById("price-currency-input").value.trim().toUpperCase(),
    date: document.getElementById("price-date-input").value,
  };
  try {
    await api(`/api/prices/${encodeURIComponent(priceModalSymbol)}`, { method: "PUT", body: JSON.stringify(body) });
    priceModal.classList.add("hidden");
    await loadSummaryAndTx();
  } catch (err) {
    alert("บันทึกไม่สำเร็จ: " + err.message);
  }
});

// ---------- Modals ----------
const txModal = document.getElementById("tx-modal");
document.getElementById("btn-add-tx").addEventListener("click", () => {
  state.editingTxId = null;
  document.getElementById("tx-modal-title").textContent = "เพิ่มรายการ";
  document.getElementById("tx-form").reset();
  document.getElementById("f-date").value = new Date().toISOString().slice(0, 10);
  updateSymbolHint();
  txModal.classList.remove("hidden");
});

function openEditTx(t) {
  state.editingTxId = t.id;
  document.getElementById("tx-modal-title").textContent = "แก้ไขรายการ";
  document.getElementById("f-date").value = t.date;
  document.getElementById("f-type").value = t.type;
  document.getElementById("f-symbol").value = t.symbol;
  document.getElementById("f-assetType").value = t.assetType;
  document.getElementById("f-quantity").value = t.quantity;
  document.getElementById("f-price").value = t.price;
  document.getElementById("f-currency").value = t.currency;
  document.getElementById("f-fees").value = t.fees || 0;
  document.getElementById("f-note").value = t.note || "";
  updateSymbolHint();
  txModal.classList.remove("hidden");
}

function updateSymbolHint() {
  const type = document.getElementById("f-assetType").value;
  const label = document.getElementById("f-symbol-label");
  const currencyField = document.getElementById("f-currency");
  const hints = {
    stock: "สัญลักษณ์ (Yahoo ticker เช่น AAPL, PTT.BK)",
    etf: "สัญลักษณ์ (Yahoo ticker เช่น VOO, SPY)",
    fund: "สัญลักษณ์ (Yahoo ticker ของกองทุนต่างประเทศ)",
    thai_fund: "ชื่อย่อกองทุน (เช่น KFINDIARMF) หรือ proj_id ก็ได้",
    crypto: "CoinGecko id (เช่น bitcoin, ethereum)",
  };
  label.firstChild.textContent = hints[type] || "สัญลักษณ์";
  if (type === "thai_fund") currencyField.value = "THB";
}
document.getElementById("f-assetType").addEventListener("change", updateSymbolHint);
document.getElementById("btn-cancel-tx").addEventListener("click", () => {
  state.editingTxId = null;
  txModal.classList.add("hidden");
});

document.getElementById("tx-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    date: document.getElementById("f-date").value,
    type: document.getElementById("f-type").value,
    symbol: document.getElementById("f-symbol").value.trim(),
    assetType: document.getElementById("f-assetType").value,
    quantity: document.getElementById("f-quantity").value,
    price: document.getElementById("f-price").value,
    currency: document.getElementById("f-currency").value.trim().toUpperCase(),
    fees: document.getElementById("f-fees").value,
    note: document.getElementById("f-note").value,
  };
  try {
    if (state.editingTxId) {
      await api(`/api/transactions/${state.currentId}/${state.editingTxId}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      await api(`/api/transactions/${state.currentId}`, { method: "POST", body: JSON.stringify(body) });
    }
    txModal.classList.add("hidden");
    state.editingTxId = null;
    await loadSummaryAndTx();
  } catch (err) {
    alert("บันทึกไม่สำเร็จ: " + err.message);
  }
});

const portfolioModal = document.getElementById("portfolio-modal");
document.getElementById("btn-new-portfolio").addEventListener("click", () => {
  state.editingPortfolioId = null;
  document.getElementById("portfolio-modal-title").textContent = "Portfolio ใหม่";
  document.getElementById("btn-submit-portfolio").textContent = "สร้าง";
  document.getElementById("portfolio-form").reset();
  renderParentSelect();
  portfolioModal.classList.remove("hidden");
});

function openEditPortfolio(p) {
  state.editingPortfolioId = p.id;
  document.getElementById("portfolio-modal-title").textContent = "แก้ไข Portfolio";
  document.getElementById("btn-submit-portfolio").textContent = "บันทึก";
  document.getElementById("p-name").value = p.name;
  // Rebuild the parent dropdown excluding this portfolio itself (can't be its own parent)
  renderParentSelect(p.id);
  document.getElementById("p-parent").value = p.parentId || "";
  portfolioModal.classList.remove("hidden");
}

document.getElementById("btn-cancel-portfolio").addEventListener("click", () => {
  state.editingPortfolioId = null;
  portfolioModal.classList.add("hidden");
});

document.getElementById("portfolio-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById("p-name").value.trim(),
    parentId: document.getElementById("p-parent").value || null,
  };
  try {
    if (state.editingPortfolioId) {
      await api(`/api/portfolios/${state.editingPortfolioId}`, { method: "PUT", body: JSON.stringify(body) });
      portfolioModal.classList.add("hidden");
      state.editingPortfolioId = null;
      await loadPortfolios();
      selectPortfolio(state.currentId); // refresh name shown in topbar if it was the active one
    } else {
      const created = await api("/api/portfolios", { method: "POST", body: JSON.stringify(body) });
      portfolioModal.classList.add("hidden");
      await loadPortfolios();
      selectPortfolio(created.id);
    }
  } catch (err) {
    alert("บันทึกไม่สำเร็จ: " + err.message);
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Init ----------
(async function init() {
  await loadSettings();
  if (state.password) {
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    boot().catch((e) => console.error(e));
  } else {
    showLogin();
  }
})();
