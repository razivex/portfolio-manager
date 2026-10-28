const STORAGE_KEY = "portfolio-manager:list";
const CURRENCIES = ["BRL", "USD", "EUR"];
const TYPE_LABEL = {
  "us-stock": "US stock",
  "us-reit": "US REIT",
  "us-etf": "US ETF",
  "br-stock": "BR stock",
  "br-fii": "BR FII",
  "br-etf": "BR ETF",
  crypto: "Crypto",
};
const US_EXCHANGES = ["NASDAQ", "NYSE", "AMEX", "CBOE"];
const COLUMNS = ["name", "description", "close", "currency", "type", "exchange", "industry"];
const KNOWN_COINS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  ADA: "cardano",
  XRP: "ripple",
  DOGE: "dogecoin",
};
const POLL_MS = 15000;

const state = {
  list: null,
  draftCurrency: "BRL",
  quotes: new Map(),
  fx: { USD: 1 },
  updatedAt: null,
  brokenCache: false,
  storageError: false,
  searchAbort: null,
};

const dialog = document.querySelector("#search-dialog");
const searchInput = document.querySelector("#search-input");
const searchStatus = document.querySelector("#search-status");
const searchResults = document.querySelector("#search-results");
let pollTimer = 0;
let searchTimer = 0;
let refreshSeq = 0;
let refreshController = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function currentCurrency() {
  return state.list ? state.list.currency : state.draftCurrency;
}

function formatAmount(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  return value.toFixed(8).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function clampAmountText(raw) {
  const text = String(raw).replace(/[^\d.,]/g, "");
  const sep = text.search(/[.,]/);
  if (sep === -1) return text;
  const decimals = text.slice(sep + 1).replace(/[.,]/g, "").slice(0, 8);
  return `${text.slice(0, sep)}${text[sep]}${decimals}`;
}

function canonicalAmount(value) {
  if (value == null || value === "") return null;
  const source = typeof value === "number" ? formatAmount(value) : String(value);
  const text = clampAmountText(source);
  if (!text || text === "." || text === ",") return null;
  const normalized = text.replace(",", ".").replace(/\.$/, "");
  if (!normalized) return null;
  const [intRaw, decRaw = ""] = normalized.split(".");
  if (!/^\d*$/.test(intRaw) || !/^\d*$/.test(decRaw)) return null;
  let intPart = intRaw.replace(/^0+(?=\d)/, "");
  if (!intPart) intPart = "0";
  const decPart = decRaw.slice(0, 8).replace(/0+$/, "");
  return decPart ? `${intPart}.${decPart}` : intPart;
}

function normalizeAsset(asset) {
  const raw = String(asset.symbol || "").toUpperCase();
  const symbol = raw.replace(/\.SA$/, "").split("-")[0];
  const next = {
    symbol,
    name: asset.name || symbol,
    type: asset.type,
    currency: asset.currency || null,
    tv: asset.tv || null,
    coinId: asset.coinId || null,
    amount: canonicalAmount(asset.amount),
  };
  if (next.type === "crypto") {
    next.coinId = next.coinId || KNOWN_COINS[raw] || KNOWN_COINS[symbol] || null;
    next.currency = "USD";
    next.tv = null;
    return next;
  }
  if (String(next.type).startsWith("br-")) next.tv = next.tv || `BMFBOVESPA:${symbol}`;
  return next;
}

function loadList() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    state.storageError = true;
    return null;
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.assets)) {
      state.brokenCache = true;
      return null;
    }
    if (!CURRENCIES.includes(data.currency)) data.currency = "BRL";
    data.assets = data.assets
      .filter((asset) => asset && asset.symbol && TYPE_LABEL[asset.type])
      .map(normalizeAsset);
    return data;
  } catch {
    state.brokenCache = true;
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.list));
    return true;
  } catch {
    state.storageError = true;
    return false;
  }
}

function syncCurrency() {
  const selected = currentCurrency();
  document.querySelectorAll("[data-currency]").forEach((button) => {
    button.setAttribute("aria-checked", button.dataset.currency === selected ? "true" : "false");
  });
}

function setCurrency(code) {
  if (!CURRENCIES.includes(code)) return;
  if (state.list) {
    if (state.list.currency === code) return;
    state.list.currency = code;
    save();
  } else {
    state.draftCurrency = code;
  }
  syncCurrency();
  applyQuotes();
}

function formatMoney(value, currency) {
  if (!Number.isFinite(value)) return "—";
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  const locale = currency === "BRL" ? "pt-BR" : currency === "EUR" ? "de-DE" : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  }).format(value);
}

function convert(price, from, to) {
  if (!Number.isFinite(price) || !from || !to) return null;
  if (from === to) return price;
  const fromPerUsd = state.fx[from];
  const toPerUsd = state.fx[to];
  if (!fromPerUsd || !toPerUsd) return null;
  return (price / fromPerUsd) * toPerUsd;
}

function amountNumber(asset) {
  const value = Number(asset.amount);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function pricedPosition(asset) {
  const quote = state.quotes.get(asset.symbol);
  const amount = amountNumber(asset);
  if (!quote) return { status: "pending" };
  if (quote.error || !Number.isFinite(quote.price)) return { status: "missing" };
  const native = quote.currency || asset.currency;
  const display = currentCurrency();
  const converted = convert(quote.price, native, display);
  if (converted == null) {
    return {
      status: "missing",
      position: "—",
      price: formatMoney(quote.price, native || "USD"),
      native: "Rate unavailable",
    };
  }
  const value = converted * amount;
  return {
    status: "ready",
    value,
    position: formatMoney(value, display),
    price: formatMoney(converted, display),
    native: native && native !== display ? formatMoney(quote.price, native) : "",
  };
}

function priceView(asset) {
  const priced = pricedPosition(asset);
  if (priced.status === "pending") return { position: "…", price: "…", native: "Fetching price" };
  if (priced.status === "missing" && !priced.position) return { position: "—", price: "—", native: "Price unavailable" };
  return priced;
}

function totalText() {
  const display = currentCurrency();
  if (state.list.assets.length === 0) return `Total · ${formatMoney(0, display)}`;
  let sum = 0;
  let ready = 0;
  let pending = false;
  for (const asset of state.list.assets) {
    const priced = pricedPosition(asset);
    if (priced.status === "pending") pending = true;
    if (priced.status !== "ready") continue;
    sum += priced.value;
    ready += 1;
  }
  if (ready === 0 && pending) return "Total · …";
  if (ready === 0) return "Total · —";
  return `Total · ${formatMoney(sum, display)}`;
}

function formatUpdatedAt(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Last Updated At: —";
  const pad = (value) => String(value).padStart(2, "0");
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `Last Updated At: ${day}/${month}/${year} ${hour}:${minute}:${second}`;
}

function applyQuotes() {
  if (!state.list) return;
  const note = document.querySelector("#price-note");
  if (note) note.textContent = totalText();
  const updated = document.querySelector("#updated-at");
  if (updated) updated.textContent = formatUpdatedAt(state.updatedAt);
  for (const asset of state.list.assets) {
    const position = document.querySelector(`[data-position-for="${CSS.escape(asset.symbol)}"]`);
    const price = document.querySelector(`[data-price-for="${CSS.escape(asset.symbol)}"]`);
    const sub = document.querySelector(`[data-native-for="${CSS.escape(asset.symbol)}"]`);
    if (!position || !price) continue;
    const view = priceView(asset);
    if (position.textContent !== view.position) {
      position.textContent = view.position;
      position.classList.remove("tick");
      void position.offsetWidth;
      position.classList.add("tick");
    }
    price.textContent = view.price;
    if (sub) sub.textContent = view.native;
  }
}

function trashIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12M10 11v6M14 11v6");
  svg.append(path);
  return svg;
}

function assetRow(asset) {
  const row = el("li", "asset");
  const identity = el("div", "identity");
  identity.append(el("span", `badge badge-${asset.type}`, TYPE_LABEL[asset.type]));
  const who = el("div", "who");
  who.append(el("p", "name", asset.name), el("p", "symbol", asset.symbol));
  identity.append(who);
  const quote = el("div", "quote");
  const price = el("p", "price", "…");
  price.title = "Price";
  price.setAttribute("data-price-for", asset.symbol);
  const sub = el("p", "native", "Fetching price");
  sub.setAttribute("data-native-for", asset.symbol);
  quote.append(price, sub);
  const actions = el("div", "row-actions");
  const amount = document.createElement("input");
  amount.className = "amount";
  amount.type = "text";
  amount.inputMode = "decimal";
  amount.autocomplete = "off";
  amount.spellcheck = false;
  amount.placeholder = "0";
  amount.setAttribute("aria-label", `Amount of ${asset.symbol}`);
  amount.value = asset.amount == null ? "" : String(asset.amount);
  amount.addEventListener("input", () => {
    const clean = clampAmountText(amount.value);
    if (clean !== amount.value) {
      const end = amount.selectionStart === amount.value.length;
      const caret = amount.selectionStart;
      amount.value = clean;
      const pos = end ? clean.length : Math.min(caret ?? clean.length, clean.length);
      amount.setSelectionRange(pos, pos);
    }
    const trailing = /[.,]$/.test(clean);
    asset.amount = canonicalAmount(trailing ? clean.slice(0, -1) : clean);
    save();
    applyQuotes();
  });
  amount.addEventListener("blur", () => {
    amount.value = asset.amount == null ? "" : String(asset.amount);
  });
  const remove = el("button", "remove");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${asset.symbol}`);
  remove.title = "Remove";
  remove.append(trashIcon());
  remove.addEventListener("click", () => removeAsset(asset.symbol));
  actions.append(amount, remove);
  const holding = el("div", "holding");
  const position = el("p", "position", "…");
  position.title = "Position";
  position.setAttribute("data-position-for", asset.symbol);
  holding.append(position, actions);
  row.append(identity, quote, holding);
  return row;
}

function renderGate() {
  const main = document.querySelector("#app");
  const gate = el("section", "gate");
  if (state.brokenCache) {
    gate.append(el("p", "gate-note", "The saved list could not be read. Add asset starts a new one."));
  }
  const button = el("button", "add-main", "Add asset");
  button.type = "button";
  button.addEventListener("click", createList);
  gate.append(button);
  main.replaceChildren(gate);
  document.querySelector("#nav-add").hidden = true;
}

function renderList() {
  const main = document.querySelector("#app");
  const board = el("section", "board");
  const head = el("div", "board-head");
  const titles = el("div");
  const heading = el("h1", null, "Assets");
  heading.append(el("span", "count", String(state.list.assets.length)));
  const note = el("p", "note");
  note.id = "price-note";
  titles.append(heading, note);
  head.append(titles);
  const panel = el("div", "panel");
  if (state.list.assets.length === 0) {
    const empty = el("div", "empty");
    const add = el("button", "add-main add-inline", "Add asset");
    add.type = "button";
    add.addEventListener("click", openSearch);
    empty.append(el("p", null, "This list has no assets yet."), add);
    panel.append(empty);
  } else {
    const list = el("ul", "assets");
    state.list.assets.forEach((asset) => list.append(assetRow(asset)));
    panel.append(list);
  }
  const assetCount = el("p", "note asset-count", `Number of Assets: ${state.list.assets.length}`);
  board.append(head, panel, assetCount);
  main.replaceChildren(board);
  document.querySelector("#nav-add").hidden = false;
  applyQuotes();
}

function render() {
  if (state.list) renderList();
  else renderGate();
  syncCurrency();
}

function createList() {
  if (state.list) {
    openSearch();
    return;
  }
  state.list = {
    version: 1,
    createdAt: new Date().toISOString(),
    currency: state.draftCurrency || "BRL",
    assets: [],
  };
  state.brokenCache = false;
  save();
  render();
  ensurePolling();
  openSearch();
}

function sameAsset(asset, result) {
  if (asset.coinId && result.coinId) return asset.coinId === result.coinId;
  if (asset.tv && result.tv) return asset.tv === result.tv;
  return asset.symbol === result.symbol;
}

function addAsset(result) {
  if (!state.list) return;
  if (state.list.assets.some((asset) => sameAsset(asset, result))) return;
  state.list.assets.push({
    symbol: result.symbol,
    name: result.name,
    type: result.type,
    currency: result.currency || null,
    tv: result.tv || null,
    coinId: result.coinId || null,
    amount: null,
  });
  if (Number.isFinite(result.price)) {
    state.quotes.set(result.symbol, { price: result.price, currency: result.currency });
  }
  save();
  render();
  refreshPrices();
}

function removeAsset(symbol) {
  if (!state.list) return;
  state.list.assets = state.list.assets.filter((asset) => asset.symbol !== symbol);
  state.quotes.delete(symbol);
  save();
  render();
}

async function scan(market, body, signal) {
  const response = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error("Market data is unavailable.");
  const data = await response.json();
  return data.data || [];
}

function mapRow(row) {
  const item = { tv: row.s };
  COLUMNS.forEach((key, index) => {
    item[key] = row.d[index];
  });
  return item;
}

function classifyListed(row) {
  const symbol = String(row.name || "").toUpperCase();
  if (!symbol) return null;
  const text = fold(`${symbol} ${row.description || ""}`);
  const industry = fold(row.industry);
  let type = null;
  if (row.exchange === "BMFBOVESPA") {
    if (/^[A-Z]{4}\d+F$/.test(symbol)) return null;
    const etf = text.includes("fundo de indice") || text.includes("ishares") || text.includes("classe de indice") || /(^| )etf( |$)/.test(text);
    const fii = text.includes("investimento imobili") || /(^| )fii( |$)/.test(text);
    if (etf) type = "br-etf";
    else if (fii) type = "br-fii";
    else if (row.type === "stock" || text.includes(" s.a") || text.includes(" unit")) type = "br-stock";
  } else if (US_EXCHANGES.includes(row.exchange)) {
    if (row.type === "fund") type = "us-etf";
    else if (row.type === "stock" && industry.includes("real estate investment trust")) type = "us-reit";
    else if (row.type === "stock") type = "us-stock";
  }
  if (!type) return null;
  return {
    symbol,
    name: row.description || symbol,
    type,
    exchange: row.exchange === "BMFBOVESPA" ? "B3" : row.exchange,
    currency: row.currency || (type.startsWith("br-") ? "BRL" : "USD"),
    tv: row.tv,
    coinId: null,
    price: Number.isFinite(row.close) ? row.close : null,
  };
}

async function searchCrypto(query, signal) {
  const response = await fetch(
    `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
    { signal, cache: "no-store", referrerPolicy: "no-referrer" }
  );
  if (!response.ok) throw new Error("Crypto search is unavailable.");
  const data = await response.json();
  return (data.coins || [])
    .filter((coin) => coin.market_cap_rank)
    .filter((coin) => !/tokenized|xstock|robinhood|bstock|ondo/i.test(coin.name || ""))
    .slice(0, 6)
    .map((coin) => ({
      symbol: String(coin.symbol || "").toUpperCase(),
      name: coin.name,
      type: "crypto",
      exchange: "Crypto",
      currency: "USD",
      tv: null,
      coinId: coin.id,
      price: null,
    }));
}

function rankScore(asset, query) {
  const target = query.toUpperCase().replace(/\s+/g, "");
  const symbol = asset.symbol.toUpperCase();
  const name = fold(asset.name);
  const foldedQuery = fold(query);
  let score = 3;
  if (symbol === target || name === foldedQuery) score = 0;
  else if (symbol.startsWith(target)) score = 1;
  else if (name.includes(foldedQuery)) score = 2;
  if (symbol.includes("/") || fold(asset.name).includes("preferred")) score += 2;
  return score;
}

async function searchMarkets(query, signal) {
  const text = query.trim();
  const upper = text.toUpperCase();
  const listed = {
    filter: [{ left: "name,description", operation: "match", right: text }],
    options: { lang: "en" },
    symbols: { query: { types: [] }, tickers: [] },
    columns: COLUMNS,
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [0, 40],
  };
  const jobs = [
    scan("america", listed, signal).then((rows) => rows.map(mapRow).map(classifyListed).filter(Boolean)),
    scan("brazil", listed, signal).then((rows) => rows.map(mapRow).map(classifyListed).filter(Boolean)),
    searchCrypto(text, signal),
  ];
  if (/^[A-Z][A-Z0-9.]{0,7}$/.test(upper)) {
    jobs.push(scan("america", {
      symbols: { tickers: US_EXCHANGES.map((exchange) => `${exchange}:${upper}`), query: { types: [] } },
      columns: COLUMNS,
    }, signal).then((rows) => rows.map(mapRow).map(classifyListed).filter(Boolean)));
  }
  if (/^[A-Z]{4}\d{1,2}$/.test(upper)) {
    jobs.push(scan("brazil", {
      symbols: { tickers: [`BMFBOVESPA:${upper}`], query: { types: [] } },
      columns: COLUMNS,
    }, signal).then((rows) => rows.map(mapRow).map(classifyListed).filter(Boolean)));
  }
  const settled = await Promise.allSettled(jobs);
  if (signal.aborted) return [];
  if (settled.every((item) => item.status === "rejected")) throw new Error("Search is unavailable.");
  const seen = new Set();
  const results = [];
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    for (const asset of item.value) {
      const key = asset.coinId || asset.tv;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(asset);
    }
  }
  results.sort((a, b) => rankScore(a, text) - rankScore(b, text));
  return results.slice(0, 12);
}

async function resolveMissing(signal) {
  const missing = state.list.assets.filter((asset) => asset.type.startsWith("us-") && !asset.tv);
  if (!missing.length) return;
  const rows = await scan("america", {
    symbols: {
      tickers: missing.flatMap((asset) => US_EXCHANGES.map((exchange) => `${exchange}:${asset.symbol}`)),
      query: { types: [] },
    },
    columns: COLUMNS,
  }, signal);
  let dirty = false;
  for (const asset of missing) {
    const matches = rows.map(mapRow).map(classifyListed).filter((item) => item && item.symbol === asset.symbol);
    matches.sort((a, b) => US_EXCHANGES.indexOf(a.exchange) - US_EXCHANGES.indexOf(b.exchange));
    if (!matches[0]) continue;
    asset.tv = matches[0].tv;
    if (!asset.currency) asset.currency = matches[0].currency;
    dirty = true;
  }
  if (dirty) save();
}

async function quoteListed(market, tickers, signal) {
  if (!tickers.length) return [];
  const rows = await scan(market, {
    symbols: { tickers, query: { types: [] } },
    columns: ["close", "currency"],
  }, signal);
  return rows.map((row) => ({ tv: row.s, price: row.d[0], currency: row.d[1] }));
}

async function quoteFx(signal) {
  const rows = await scan("forex", {
    symbols: { tickers: ["FX_IDC:USDBRL", "FX_IDC:USDEUR"], query: { types: [] } },
    columns: ["close"],
  }, signal);
  const fx = { USD: 1 };
  for (const row of rows) {
    if (row.s === "FX_IDC:USDBRL" && Number.isFinite(row.d[0])) fx.BRL = row.d[0];
    if (row.s === "FX_IDC:USDEUR" && Number.isFinite(row.d[0])) fx.EUR = row.d[0];
  }
  return fx;
}

async function quoteCrypto(ids, signal) {
  if (!ids.length) return [];
  const response = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`,
    { signal, cache: "no-store", referrerPolicy: "no-referrer" }
  );
  if (!response.ok) throw new Error("Crypto prices are unavailable.");
  const data = await response.json();
  return ids
    .filter((id) => data[id] && Number.isFinite(data[id].usd))
    .map((id) => ({ coinId: id, price: data[id].usd, currency: "USD" }));
}

async function refreshPrices() {
  if (!state.list || state.list.assets.length === 0) return;
  if (document.visibilityState === "hidden") return;
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const seq = ++refreshSeq;
  try {
    await resolveMissing(controller.signal);
    const assets = state.list.assets;
    const us = assets.filter((asset) => asset.tv && asset.type.startsWith("us-")).map((asset) => asset.tv);
    const br = assets.filter((asset) => asset.tv && asset.type.startsWith("br-")).map((asset) => asset.tv);
    const coins = assets.filter((asset) => asset.coinId).map((asset) => asset.coinId);
    const [usQuotes, brQuotes, fx, cryptoQuotes] = await Promise.all([
      quoteListed("america", us, controller.signal).catch(() => null),
      quoteListed("brazil", br, controller.signal).catch(() => null),
      quoteFx(controller.signal).catch(() => null),
      quoteCrypto(coins, controller.signal).catch(() => null),
    ]);
    if (controller.signal.aborted || seq !== refreshSeq) return;
    let dirty = false;
    for (const quote of [...(usQuotes || []), ...(brQuotes || [])]) {
      const asset = assets.find((item) => item.tv === quote.tv);
      if (!asset || !Number.isFinite(quote.price)) continue;
      state.quotes.set(asset.symbol, { price: quote.price, currency: quote.currency || asset.currency });
      if (quote.currency && asset.currency !== quote.currency) {
        asset.currency = quote.currency;
        dirty = true;
      }
    }
    for (const quote of cryptoQuotes || []) {
      const asset = assets.find((item) => item.coinId === quote.coinId);
      if (!asset) continue;
      state.quotes.set(asset.symbol, { price: quote.price, currency: "USD" });
      asset.currency = "USD";
    }
    if (fx) state.fx = { ...state.fx, ...fx };
    const arrived = [us.length ? usQuotes : null, br.length ? brQuotes : null, coins.length ? cryptoQuotes : null, fx];
    if (arrived.some((group) => group != null)) state.updatedAt = new Date();
    if (dirty) save();
  } catch (error) {
    if (error.name === "AbortError" || controller.signal.aborted || seq !== refreshSeq) return;
  }
  if (seq === refreshSeq) applyQuotes();
}

function ensurePolling() {
  if (pollTimer || !state.list) return;
  refreshPrices();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") refreshPrices();
  }, POLL_MS);
}

function paintResults(results) {
  searchResults.replaceChildren();
  if (results.length === 0) {
    searchStatus.textContent = "No matching assets.";
    return;
  }
  searchStatus.textContent = "";
  for (const result of results) {
    const item = el("li");
    const button = el("button", "result");
    button.type = "button";
    const added = state.list.assets.some((asset) => sameAsset(asset, result));
    button.disabled = added;
    button.append(el("span", `badge badge-${result.type}`, TYPE_LABEL[result.type]));
    const who = el("span", "who");
    who.append(
      el("span", "name", result.name),
      el("span", "symbol", `${result.symbol} · ${result.exchange || TYPE_LABEL[result.type]}`)
    );
    const action = el("span", "action", added ? "Added" : "Add");
    button.append(who, action);
    button.addEventListener("click", () => {
      addAsset(result);
      button.disabled = true;
      action.textContent = "Added";
    });
    item.append(button);
    searchResults.append(item);
  }
}

async function runSearch(query) {
  state.searchAbort?.abort();
  const controller = new AbortController();
  state.searchAbort = controller;
  try {
    const results = await searchMarkets(query, controller.signal);
    if (controller.signal.aborted) return;
    paintResults(results);
  } catch (error) {
    if (error.name === "AbortError" || controller.signal.aborted) return;
    searchResults.replaceChildren();
    searchStatus.textContent = "Search is unavailable.";
  }
}

function openSearch() {
  if (!state.list) return;
  searchInput.value = "";
  searchStatus.textContent = "US and Brazilian stocks, REITs, ETFs, FIIs, and crypto.";
  searchResults.replaceChildren();
  dialog.showModal();
  searchInput.focus();
}

function closeSearch() {
  state.searchAbort?.abort();
  window.clearTimeout(searchTimer);
  if (dialog.open) dialog.close();
}

document.querySelector("#nav-add").addEventListener("click", openSearch);
document.querySelector("#search-close").addEventListener("click", closeSearch);
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeSearch();
});
dialog.addEventListener("close", () => {
  state.searchAbort?.abort();
  window.clearTimeout(searchTimer);
});

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 2) {
    state.searchAbort?.abort();
    searchResults.replaceChildren();
    searchStatus.textContent = query
      ? "Type at least 2 letters."
      : "US and Brazilian stocks, REITs, ETFs, FIIs, and crypto.";
    return;
  }
  searchStatus.textContent = "Searching…";
  searchResults.replaceChildren();
  searchTimer = window.setTimeout(() => runSearch(query), 350);
});

const currencyGroup = document.querySelector(".currency");
const settingsToggle = document.querySelector("#settings-toggle");
const settingsMenu = document.querySelector("#settings-menu");

function setSettingsOpen(open) {
  settingsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  settingsToggle.classList.toggle("is-active", open);
  settingsMenu.hidden = !open;
  if (open) settingsMenu.querySelector('[aria-checked="true"]')?.focus();
}

settingsToggle.addEventListener("click", () => {
  setSettingsOpen(settingsMenu.hidden);
});

document.addEventListener("click", (event) => {
  if (settingsMenu.hidden || event.target.closest(".settings")) return;
  setSettingsOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || settingsMenu.hidden || dialog.open) return;
  event.preventDefault();
  setSettingsOpen(false);
  settingsToggle.focus();
});

currencyGroup.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  const buttons = [...currencyGroup.querySelectorAll("[data-currency]")];
  const index = buttons.findIndex((button) => button.getAttribute("aria-checked") === "true");
  event.preventDefault();
  const shift = event.key === "ArrowRight" ? 1 : -1;
  const next = buttons[(index + shift + buttons.length) % buttons.length];
  next.click();
  next.focus();
});
document.querySelectorAll("[data-currency]").forEach((button) => {
  button.addEventListener("click", () => setCurrency(button.dataset.currency));
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.list) refreshPrices();
});

state.list = loadList();
render();
if (state.list) ensurePolling();
