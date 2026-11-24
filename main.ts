// Pump.fun Paper Sprint — buy-and-hold paper-trading bot.
//
// Speaks agent-fun/replay/v2 over stdin/stdout: the harness sends one JSON
// line at a time (hello, then one batch per slot, then done) and this bot
// answers every batch with exactly one reply line echoing the batch seq.
// No network, no clock, no randomness: every decision comes from the slot
// number and the market data in the batch, so two runs agree byte for byte.
//
// Strategy, in one line: buy young coins that are actively being bought,
// hold them, and sell on a profit target, a stop loss, or a time limit.
//
//   * Buy: a mint first seen recently (young coin) that has a buy trade in
//     this batch and enough real SOL reserves that a >= 0.01 SOL order fits
//     under the per-order size cap. Size adapts to the curve: up to 0.4 SOL,
//     never more than 90% of the size cap. At most 5 open positions.
//   * Hold: positions are left alone while they drift inside the band.
//   * Sell: the whole position when its marked value is >= 1.30x cost
//     (take profit), <= 0.80x cost (stop loss), or it has been held for
//     4500 slots (~30 min). The harness flattens anything still held at
//     the end of the window, so a hold to the end still realises PnL.
//   * Rotation: each mint is bought at most once, so the bot keeps moving
//     on to fresh coins and covers the 20-distinct-mint guardrail.

import { createInterface } from "node:readline";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip minimum.
const MAX_BUY_LAMPORTS = 400_000_000n; // 0.4 SOL per buy at most.
const MAX_OPEN_POSITIONS = 5;
const MAX_SLIPPAGE_BPS = 500;
const YOUNG_WINDOW_SLOTS = 7200; // only buy coins first seen in the last ~48 min.
const MAX_HOLD_SLOTS = 4500; // sell after ~30 min even if inside the band.
const TAKE_PROFIT_NUM = 130n; // sell at >= 130% of cost.
const STOP_LOSS_NUM = 80n; // sell at <= 80% of cost.
const DENOM = 100n;

type U64 = string;

interface CurveInfo {
  firstSlot: number;
  firstQuote: bigint;
  firstToken: bigint;
  realQuote: bigint;
  complete: boolean;
}

interface HeldInfo {
  buySlot: number;
  cost: bigint;
  tokens: bigint;
}

interface PendingBuy {
  mint: string;
  lamports: bigint;
}

const curves = new Map<string, CurveInfo>();
const boughtOnce = new Set<string>();
const pendingBuys = new Map<string, PendingBuy>();
const heldSince = new Map<string, number>();
let clientCounter = 0;
let capitalLamports = 0n;
let maxOrderBps = 100;
let maxOrdersPerBatch = 16;
let txFeeLamports = 0n;

function nextClientId(prefix: string): string {
  clientCounter += 1;
  return `${prefix}${clientCounter}`;
}

/** Current price of one token in lamports, as a fraction (quote / token). */
function markValue(tokens: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken === 0n) return 0n;
  return (tokens * virtualQuote) / virtualToken;
}

function decideOrders(batch: any): any[] {
  const orders: any[] = [];
  const slot: number = batch.slot;
  const cash = BigInt(batch.account.cash_lamports);
  const positions: any[] = batch.account.positions ?? [];

  // Fold this batch's marks into the curve table.
  for (const mark of batch.marks ?? []) {
    const curve = curves.get(mark.mint);
    if (curve === undefined) {
      curves.set(mark.mint, {
        firstSlot: slot,
        firstQuote: BigInt(mark.virtual_quote_reserves),
        firstToken: BigInt(mark.virtual_token_reserves),
        realQuote: BigInt(mark.real_quote_reserves),
        complete: false,
      });
    } else {
      curve.realQuote = BigInt(mark.real_quote_reserves);
    }
  }

  // Fold this batch's events: new curves, reserve updates, completions.
  const buyInterest = new Set<string>();
  for (const event of batch.events ?? []) {
    if (event.event === "CreateEvent") {
      if (!curves.has(event.mint)) {
        curves.set(event.mint, {
          firstSlot: slot,
          firstQuote: BigInt(event.virtual_quote_reserves),
          firstToken: BigInt(event.virtual_token_reserves),
          realQuote: 0n,
          complete: false,
        });
      }
    } else if (event.event === "TradeEvent") {
      const curve = curves.get(event.mint);
      if (curve === undefined) {
        curves.set(event.mint, {
          firstSlot: slot,
          firstQuote: BigInt(event.virtual_quote_reserves),
          firstToken: BigInt(event.virtual_token_reserves),
          realQuote: BigInt(event.real_quote_reserves),
          complete: false,
        });
      } else {
        curve.realQuote = BigInt(event.real_quote_reserves);
      }
      if (event.is_buy === true) buyInterest.add(event.mint);
    } else if (event.event === "CompleteEvent") {
      const curve = curves.get(event.mint);
      if (curve !== undefined) curve.complete = true;
    }
  }

  // Drop fills that resolved: pending buys that filled or were rejected.
  for (const fill of batch.fills ?? []) {
    if (fill.side === "buy") pendingBuys.delete(fill.client_id);
  }

  // Current holdings, with their buy slot remembered from the first batch
  // in which the position appeared.
  const held = new Map<string, HeldInfo>();
  for (const position of positions) {
    const tokens = BigInt(position.token_amount);
    if (tokens <= 0n) continue;
    let buySlot = heldSince.get(position.mint);
    if (buySlot === undefined) {
      buySlot = slot;
      heldSince.set(position.mint, buySlot);
    }
    held.set(position.mint, {
      buySlot,
      cost: BigInt(position.cost_lamports),
      tokens,
    });
  }
  for (const mint of [...heldSince.keys()]) {
    if (!held.has(mint)) heldSince.delete(mint);
  }

  // Sells first: take profit, stop loss, or held too long.
  const marks = new Map<string, any>();
  for (const mark of batch.marks ?? []) marks.set(mark.mint, mark);
  for (const [mint, info] of held) {
    const mark = marks.get(mint);
    if (mark === undefined) continue;
    const value = markValue(
      info.tokens,
      BigInt(mark.virtual_quote_reserves),
      BigInt(mark.virtual_token_reserves),
    );
    const heldSlots = slot - info.buySlot;
    const takeProfit = value * DENOM >= info.cost * TAKE_PROFIT_NUM;
    const stopLoss = value * DENOM <= info.cost * STOP_LOSS_NUM;
    const tooLong = heldSlots >= MAX_HOLD_SLOTS;
    if (takeProfit || stopLoss || tooLong) {
      orders.push({
        side: "sell",
        client_id: nextClientId("s"),
        mint,
        token_amount: info.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // Buys: young coins with live buy interest, one buy per mint ever.
  const openCount =
    held.size + pendingBuys.size;
  const freeSlots = MAX_OPEN_POSITIONS - openCount;
  if (freeSlots > 0) {
    let reserved = 0n;
    for (const pending of pendingBuys.values()) reserved += pending.lamports;
    const txReserve = BigInt(pendingBuys.size + orders.length) * txFeeLamports;
    let freeCash = cash - reserved - txReserve;
    let bought = 0;
    for (const mint of buyInterest) {
      if (bought >= freeSlots) break;
      if (orders.length >= maxOrdersPerBatch) break;
      if (held.has(mint) || pendingBuys.has(mint)) continue;
      if (boughtOnce.has(mint)) continue;
      const curve = curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (slot - curve.firstSlot > YOUNG_WINDOW_SLOTS) continue;
      // Skip coins that already more than doubled since first sight.
      const mark = marks.get(mint);
      if (mark !== undefined && curve.firstToken > 0n && curve.firstQuote > 0n) {
        const nowNum = BigInt(mark.virtual_quote_reserves) * curve.firstToken;
        const thenDen = BigInt(mark.virtual_token_reserves) * curve.firstQuote;
        if (thenDen > 0n && nowNum >= 2n * thenDen) continue;
      }
      // Size cap: at most maxOrderBps of the real SOL reserve.
      const cap = (curve.realQuote * BigInt(maxOrderBps)) / 10_000n;
      let size = (cap * 9n) / 10n;
      if (size > MAX_BUY_LAMPORTS) size = MAX_BUY_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (freeCash < size + txFeeLamports) continue;
      const clientId = nextClientId("b");
      orders.push({
        side: "buy",
        client_id: clientId,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingBuys.set(clientId, { mint, lamports: size });
      boughtOnce.add(mint);
      freeCash -= size + txFeeLamports;
      bought += 1;
    }
  }

  return orders;
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("ignoring non-JSON input line");
      continue;
    }
    if (message.type === "hello") {
      capitalLamports = BigInt(message.capital.lamports);
      maxOrderBps = message.caps.max_order_bps_of_real_reserve;
      maxOrdersPerBatch = message.caps.max_orders_per_batch;
      txFeeLamports =
        BigInt(message.fees.base_fee_lamports) +
        BigInt(message.fees.priority_fee_lamports);
      console.error(
        `hello: capital=${capitalLamports} maxOrderBps=${maxOrderBps} maxOrdersPerBatch=${maxOrdersPerBatch}`,
      );
    } else if (message.type === "batch") {
      const orders = decideOrders(message);
      const reply = { type: "reply", seq: message.seq, orders };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    } else if (message.type === "done") {
      console.error(`done: reason=${message.reason}`);
      break;
    } else {
      console.error(`ignoring unknown message type: ${message.type}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
