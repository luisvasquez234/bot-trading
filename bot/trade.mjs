// Bot de trading automatico en modo PAPER (simulado, sin dinero real).
// Estrategia: de las acciones que mas cayeron hoy (top losers), compra las que
// esten sobrevendidas (RSI-14 bajo) apostando a un rebote, con take-profit y
// stop-loss automaticos via bracket order.

const KEY_ID = process.env.ALPACA_KEY_ID;
const SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const TRADE_BASE_URL = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const DATA_BASE_URL = "https://data.alpaca.markets";

const MAX_POSITIONS = Number(process.env.MAX_POSITIONS || 5);
const TRADE_NOTIONAL = Number(process.env.TRADE_NOTIONAL || 500); // dolares (simulados) por operacion
const RSI_PERIOD = 14;
const RSI_OVERSOLD = Number(process.env.RSI_OVERSOLD || 35);
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 0.03); // +3%
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 0.02); // -2%
const MIN_PRICE = 3; // evita penny stocks demasiado ilíquidas/manipulables

if (!KEY_ID || !SECRET_KEY) {
  console.error("Faltan ALPACA_KEY_ID / ALPACA_SECRET_KEY en el entorno.");
  process.exit(1);
}

const authHeaders = {
  "APCA-API-KEY-ID": KEY_ID,
  "APCA-API-SECRET-KEY": SECRET_KEY,
};

async function apiGet(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function apiPost(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// RSI de Wilder sobre precios de cierre
function calculateRSI(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function getTopLosers(top = 10) {
  const data = await apiGet(DATA_BASE_URL, `/v1beta1/screener/stocks/losers?top=${top}`);
  return data.losers || [];
}

async function getRecentCloses(symbol, days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days * 2); // margen por fines de semana/feriados
  const params = new URLSearchParams({
    timeframe: "1Day",
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    limit: String(days),
    adjustment: "raw",
    feed: "iex",
  });
  const data = await apiGet(DATA_BASE_URL, `/v2/stocks/${symbol}/bars?${params}`);
  return (data.bars || []).map((b) => b.c);
}

async function getOpenPositions() {
  try {
    return await apiGet(TRADE_BASE_URL, "/v2/positions");
  } catch {
    return [];
  }
}

async function getAccount() {
  return apiGet(TRADE_BASE_URL, "/v2/account");
}

async function placeBracketBuy(symbol, price) {
  const takeProfitPrice = (price * (1 + TAKE_PROFIT_PCT)).toFixed(2);
  const stopLossPrice = (price * (1 - STOP_LOSS_PCT)).toFixed(2);
  return apiPost(TRADE_BASE_URL, "/v2/orders", {
    symbol,
    notional: String(TRADE_NOTIONAL),
    side: "buy",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: takeProfitPrice },
    stop_loss: { stop_price: stopLossPrice },
  });
}

async function main() {
  const account = await getAccount();
  console.log(`Cuenta paper: equity=$${account.equity} cash=$${account.cash}`);

  const positions = await getOpenPositions();
  const heldSymbols = new Set(positions.map((p) => p.symbol));
  console.log(`Posiciones abiertas: ${positions.length} (${[...heldSymbols].join(", ") || "ninguna"})`);

  const slotsFree = MAX_POSITIONS - positions.length;
  if (slotsFree <= 0) {
    console.log("Ya se alcanzo el maximo de posiciones abiertas. No se abren nuevas hoy.");
    return;
  }

  const losers = await getTopLosers(15);
  console.log(`Top losers de hoy: ${losers.map((l) => `${l.symbol} (${l.percent_change?.toFixed?.(2)}%)`).join(", ")}`);

  const candidates = [];
  for (const loser of losers) {
    const { symbol, price } = loser;
    if (heldSymbols.has(symbol)) continue;
    if (!price || price < MIN_PRICE) continue;
    try {
      const closes = await getRecentCloses(symbol);
      const rsi = calculateRSI(closes);
      if (rsi !== null && rsi <= RSI_OVERSOLD) {
        candidates.push({ symbol, price, rsi });
      }
    } catch (err) {
      console.warn(`No se pudo evaluar ${symbol}: ${err.message}`);
    }
  }

  candidates.sort((a, b) => a.rsi - b.rsi); // primero las mas sobrevendidas
  const toBuy = candidates.slice(0, slotsFree);

  if (toBuy.length === 0) {
    console.log("Ninguna de las mas caidas de hoy esta suficientemente sobrevendida (RSI). No se compra nada.");
    return;
  }

  for (const { symbol, price, rsi } of toBuy) {
    console.log(`Comprando ${symbol} a ~$${price} (RSI=${rsi.toFixed(1)}) con take-profit +${TAKE_PROFIT_PCT * 100}% / stop-loss -${STOP_LOSS_PCT * 100}%`);
    try {
      await placeBracketBuy(symbol, price);
    } catch (err) {
      console.error(`Fallo la orden de ${symbol}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Error en el bot:", err);
  process.exit(1);
});
