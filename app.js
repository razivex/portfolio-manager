const STORAGE_KEY = "portfolio-manager:list";
const CURRENCIES = ["BRL", "USD", "EUR"];
const CURRENCY_LABEL = {
  BRL: "Brazilian real",
  USD: "US dollars",
  EUR: "euros",
};
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
  refreshError: false,
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

function priceView(asset) {
  const quote = state.quotes.get(asset.symbol);
  if (!quote) return { main: "…", sub: "Fetching price" };
  if (quote.error || !Number.isFinite(quote.price)) return { main: "—", sub: "Price unavailable" };
  const native = quote.currency || asset.currency;
  const display = currentCurrency();
  const converted = convert(quote.price, native, display);
  if (converted == null) return { main: formatMoney(quote.price, native || "USD"), sub: "Rate unavailable" };
  return {
    main: formatMoney(converted, display),
    sub: native && native !== display ? formatMoney(quote.price, native) : "",
  };
}

function applyQuotes() {
  if (!state.list) return;
  const note = document.querySelector("#price-note");
  if (note && state.list.assets.length === 0) {
    note.textContent = `Prices in ${CURRENCY_LABEL[currentCurrency()]}`;
  } else if (note) {
    const when = state.updatedAt
      ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(state.updatedAt)
      : "waiting for prices";
    const storage = state.storageError ? " · not saved in this browser" : "";
    note.textContent = state.refreshError
      ? `Could not refresh prices${storage}`
      : `Prices in ${CURRENCY_LABEL[currentCurrency()]} · ${when}${storage}`;
  }
  const live = document.querySelector("#live-flag");
  if (live) {
    live.classList.toggle("is-down", state.refreshError);
    live.querySelector(".live-label").textContent = state.refreshError ? "Offline" : "Live";
  }
  for (const asset of state.list.assets) {
    const main = document.querySelector(`[data-price-for="${CSS.escape(asset.symbol)}"]`);
    const sub = document.querySelector(`[data-native-for="${CSS.escape(asset.symbol)}"]`);
    if (!main) continue;
    const view = priceView(asset);
    if (main.textContent !== view.main) {
      main.textContent = view.main;
      main.classList.remove("tick");
      void main.offsetWidth;
      main.classList.add("tick");
    }
    if (sub) sub.textContent = view.sub;
  }
}

function assetRow(asset) {
  const row = el("li", "asset");
  const identity = el("div", "identity");
  identity.append(el("span", `badge badge-${asset.type}`, TYPE_LABEL[asset.type]));
  const who = el("div", "who");
  who.append(el("p", "name", asset.name), el("p", "symbol", asset.symbol));
  identity.append(who);
  const prices = el("div", "prices");
  const main = el("p", "price", "…");
  main.setAttribute("data-price-for", asset.symbol);
  const sub = el("p", "native", "Fetching price");
  sub.setAttribute("data-native-for", asset.symbol);
  prices.append(main, sub);
  const remove = el("button", "remove", "Remove");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${asset.symbol}`);
  remove.addEventListener("click", () => removeAsset(asset.symbol));
  row.append(identity, prices, remove);
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
  if (state.list.assets.length > 0) {
    const live = el("p", "live");
    live.id = "live-flag";
    live.append(el("span", "dot"), el("span", "live-label", "Live"));
    head.append(live);
  }
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
  board.append(head, panel);
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
    const checks = [];
    if (us.length) checks.push(usQuotes);
    if (br.length) checks.push(brQuotes);
    if (coins.length) checks.push(cryptoQuotes);
    const received = checks.filter((group) => Array.isArray(group)).length;
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
    state.refreshError = received === 0;
    if (!state.refreshError) state.updatedAt = new Date();
    if (dirty) save();
  } catch (error) {
    if (error.name === "AbortError" || controller.signal.aborted || seq !== refreshSeq) return;
    state.refreshError = true;
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
