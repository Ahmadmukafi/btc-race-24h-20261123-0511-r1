// cbBTC 1-minute bot for make.fun btc-race-24h-20261123-0511.
// Protocol: agent-fun/bars-replay/v1 (NDJSON on stdin/stdout, one reply per batch).
// One asset (CBBTC), long only, $1,000 paper money, no shorts, no leverage.
//
// Method — one-shot, two ways in, one position, full size:
//   * Dip leg (mean reversion): buy when the close sits 1.50% below its 60-bar
//     EMA and ticks up; exit at +1.00%, at -1.50%, or when the close reclaims
//     the EMA60. Catches the sharp intraday bounce after a wash-out.
//   * Trend leg (momentum): buy when the 240-bar return tops +1.00% with the
//     close above its 240-bar EMA; exit on a 0.80% trailing stop from the peak
//     close, or when the close falls back under the EMA240. Rides a multi-hour
//     trend and lets the trailing stop bank it.
// Whichever signal fires first takes the single trade; after the exit the bot
// never re-enters, so a choppy window cannot bleed it through repeated
// round trips (each costs ~26 bps in fees, slippage and impact).
//
// Deterministic: no clock, no randomness, no environment. Every decision is a
// pure function of the bars seen so far, so two runs on the same data produce
// byte-identical action logs.

import { createInterface } from 'node:readline';

const SYMBOL = 'CBBTC';
const DIP_BPS = 150; // dip leg: entry 1.50% below EMA60
const DIP_EXIT_BPS = 100; // dip leg: take profit +1.00%
const DIP_STOP_BPS = 150; // dip leg: stop loss -1.50%
const TREND_BPS = 100; // trend leg: 240-bar return over +1.00%
const TRAIL_BPS = 80; // trend leg: trailing stop 0.80% under the peak close
const MAX_SLIP_BPS = 150; // max slippage vs latest close on every order

interface HelloSymbol {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}
interface Hello {
  type: 'hello';
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
}
interface Bar {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}
interface Fill {
  client_id: string;
  symbol: string;
  side: string;
  status: string;
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
}
interface Account {
  cash_quote_units: string;
  positions: { symbol: string; qty: string; cost_quote_units: string }[];
  equity_quote_units: string;
}
interface Batch {
  type: 'batch';
  seq: number;
  t: number;
  bars: Bar[];
  fills: Fill[];
  account: Account;
}
interface Done {
  type: 'done';
  seq: number;
  reason: string;
  account: Account;
}
type Order =
  | { side: 'buy'; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

const state = {
  priceScale: 5,
  warmupBars: 0,
  seq: -1,
  closes: [] as number[],
  ema60: 0,
  ema240: 0,
  cash: 0n,
  posQty: '0',
  leg: '' as '' | 'dip' | 'trend',
  entryClose: 0,
  peakClose: 0,
  doneTrading: false,
  orderNo: 0,
  trades: 0,
};

function emaUpdate(prev: number, price: number, n: number): number {
  const k = 2 / (n + 1);
  return price * k + prev * (1 - k);
}

function decide(): Order[] {
  const c = state.closes;
  const n = c.length;
  if (n === 0) return [];
  const close = c[n - 1];
  const long = state.posQty !== '0';
  if (!long) {
    if (state.doneTrading) return [];
    // A buy decided on this batch fills at the next bar's open.
    if (state.leg !== '') {
      // A buy was sent on the previous batch but no position arrived: it was
      // rejected, so clear the leg and let the signal re-fire if still true.
      state.leg = '';
    }
    if (n >= 61) {
      const dip = close < state.ema60 * (1 - DIP_BPS / 10000) && close > c[n - 2];
      if (dip) {
        state.leg = 'dip';
        state.entryClose = close;
        state.peakClose = close;
        return [{ side: 'buy', client_id: `buy${++state.orderNo}`, symbol: SYMBOL, notional_quote_units: state.cash.toString(), max_slippage_bps: MAX_SLIP_BPS }];
      }
    }
    if (n >= 241) {
      const ret240 = close / c[n - 241] - 1;
      const trend = ret240 > TREND_BPS / 10000 && close > state.ema240;
      if (trend) {
        state.leg = 'trend';
        state.entryClose = close;
        state.peakClose = close;
        return [{ side: 'buy', client_id: `buy${++state.orderNo}`, symbol: SYMBOL, notional_quote_units: state.cash.toString(), max_slippage_bps: MAX_SLIP_BPS }];
      }
    }
    return [];
  }
  // Long: manage the exit for the leg that got us in.
  if (close > state.peakClose) state.peakClose = close;
  if (state.leg === 'dip') {
    if (close >= state.entryClose * (1 + DIP_EXIT_BPS / 10000) || close <= state.entryClose * (1 - DIP_STOP_BPS / 10000) || close >= state.ema60) {
      state.doneTrading = true;
      state.trades++;
      return [{ side: 'sell', client_id: `sell${++state.orderNo}`, symbol: SYMBOL, qty: state.posQty, max_slippage_bps: MAX_SLIP_BPS }];
    }
    return [];
  }
  if (state.leg === 'trend') {
    if (close <= state.peakClose * (1 - TRAIL_BPS / 10000) || close < state.ema240) {
      state.doneTrading = true;
      state.trades++;
      return [{ side: 'sell', client_id: `sell${++state.orderNo}`, symbol: SYMBOL, qty: state.posQty, max_slippage_bps: MAX_SLIP_BPS }];
    }
    return [];
  }
  // Long with no leg recorded (should not happen): exit on the trailing stop.
  if (close <= state.peakClose * (1 - TRAIL_BPS / 10000)) {
    state.doneTrading = true;
    state.trades++;
    return [{ side: 'sell', client_id: `sell${++state.orderNo}`, symbol: SYMBOL, qty: state.posQty, max_slippage_bps: MAX_SLIP_BPS }];
  }
  return [];
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as Hello | Batch | Done;
    if (msg.type === 'hello') {
      const sym = msg.symbols.find((s) => s.symbol === SYMBOL);
      if (sym) state.priceScale = sym.price_scale;
      state.warmupBars = msg.warmup_bars ?? 0;
      state.cash = BigInt(msg.capital.quote_units);
      continue;
    }
    if (msg.type === 'done') {
      console.error(`done seq=${msg.seq} reason=${msg.reason} equity=${msg.account.equity_quote_units} trades=${state.trades}`);
      break;
    }
    // batch
    state.seq = msg.seq;
    state.cash = BigInt(msg.account.cash_quote_units);
    const pos = msg.account.positions.find((p) => p.symbol === SYMBOL);
    state.posQty = pos ? pos.qty : '0';
    // Trade journal (stderr only; stdout carries replies alone): one line per
    // fill the harness reports, so a local grade shows what actually filled.
    for (const f of msg.fills) {
      console.error(`fill seq=${msg.seq} ${f.client_id} ${f.side} ${f.status} price=${f.price} qty=${f.qty} notional=${f.notional_quote_units} fee=${f.fee_quote_units}${f.reason ? ` reason=${f.reason}` : ''}`);
    }
    for (const b of msg.bars) {
      if (b.symbol !== SYMBOL) continue;
      const price = Number(b.c) / 10 ** state.priceScale;
      if (state.closes.length === 0) {
        state.ema60 = price;
        state.ema240 = price;
      } else {
        state.ema60 = emaUpdate(state.ema60, price, 60);
        state.ema240 = emaUpdate(state.ema240, price, 240);
      }
      state.closes.push(price);
    }
    const warmingUp = state.warmupBars > 0 && state.seq < state.warmupBars;
    const orders = warmingUp ? [] : decide();
    process.stdout.write(`${JSON.stringify({ type: 'reply', seq: msg.seq, orders })}\n`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
