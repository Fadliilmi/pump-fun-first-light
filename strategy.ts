// First-light momentum bot for the pump.fun paper sprint.
//
// The bet: on a 6-hour window of brand-new pump.fun coins, the money is in
// the first minutes. A coin that is already climbing in its first few trades
// is more likely to be one of the few that run than a coin bought blind at
// creation, so this bot only buys a fresh coin after it has proven it can
// rise, then rides it with a trailing exit and lets the losers go quickly.
//
// How it works, per batch of the replay:
//   - A coin becomes a candidate when its CreateEvent arrives. Its
//     first-seen price is recorded from the curve reserves on the first
//     trade we observe for it.
//   - Entry: while the coin is still young (at most 8 trades old, created
//     within the last 2500 slots) and its price has risen at least 3%
//     above its first-seen price, buy one small stake of 0.06 SOL (capped
//     at 1% of the coin's real SOL reserve, the harness cap). At most 5
//     open positions, one entry attempt per coin, ever.
//   - Exit: sell the whole position when the price falls 20% from the
//     highest price seen since entry (trailing stop), or 25% below the
//     entry price (hard stop), or when the coin goes stale (150 trades or
//     30000 slots held with no exit). The harness flattens anything left
//     at the end of the replay and closes positions whose curve completes.
//   - Sells are decided before buys in every batch, so an exit never waits
//     behind a new entry for one of the 16 order slots.
//
// Determinism: no randomness, no clock, no network, no environment reads.
// Every decision is a pure function of the hello handshake and the batches
// seen so far, so the grader's two runs produce byte-identical action logs.
// Orders are decided from the current batch's marks and fill 2 slots later
// (the harness latency), which is why slippage is set wide: a fresh coin
// can move a lot in 2 slots, and a stop must exit, never be refused.

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";
import { LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";

// --- Tunables: round numbers, chosen for breadth over concentration. ---
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 6n) / 100n; // 0.06 SOL per coin
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL: smallest buy worth the fees
const RISE_TO_ENTER_BPS = 300; // enter only after +3% vs first-seen price
const ENTER_WITHIN_TRADES = 8; // ... while the coin is still brand new
const ENTER_WITHIN_SLOTS = 2500; // ... and created within the last 2500 slots
const TRAIL_BPS = 2000; // sell when 20% below the peak since entry
const STOP_BPS = 2500; // ... or 25% below entry, whichever comes first
const STALE_TRADES = 150; // give up on a flat coin after 150 trades
const STALE_SLOTS = 30000; // ... or 30000 slots held, whichever comes first
const BUY_SLIPPAGE_BPS = 5000; // wide: a new coin moves fast in the latency
const SELL_SLIPPAGE_BPS = 10000; // widest: a stop must exit, never be refused
const BPS = 10000;

/** Current curve price in lamports of quote per token, or null if unknown. */
function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

/** Per-mint notes for coins we are watching or holding. */
interface CoinNote {
  /** Slot of the coin's CreateEvent, null until we see it. */
  createdSlot: number | null;
  /** Price at the first trade we observed for this coin. */
  firstPrice: number | null;
  /** True once we sent a buy (or gave up on) this coin: one attempt max. */
  decided: boolean;
  /** Highest price seen since entry (lamports per token). */
  peak: number;
  /** Entry price (lamports per token, cost basis incl. fees). */
  entryPrice: number;
  /** Trade count at entry, for the stale-trades exit. */
  entryTrades: number;
  /** Slot at entry, for the stale-slots exit. */
  entrySlot: number;
}

export class FirstLightMomentum {
  private notes = new Map<string, CoinNote>();

  private noteFor(mint: string): CoinNote {
    let note = this.notes.get(mint);
    if (note === undefined) {
      note = {
        createdSlot: null,
        firstPrice: null,
        decided: false,
        peak: 0,
        entryPrice: 0,
        entryTrades: 0,
        entrySlot: 0,
      };
      this.notes.set(mint, note);
    }
    return note;
  }

  /** Decide this batch's orders. Called once per batch by main.ts. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // Register creations and drop completed curves first, so a coin created
    // in this batch is known and a completed one is forgotten.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        this.noteFor(event.mint).createdSlot = event.slot;
      } else if (event.event === "CompleteEvent") {
        this.notes.delete(event.mint);
      }
    }

    // Record first-seen prices from this batch's trades, before deciding.
    for (const event of batch.events) {
      if (event.event !== "TradeEvent") continue;
      const note = this.noteFor(event.mint);
      if (note.firstPrice === null) {
        note.firstPrice = priceOf(state, event.mint);
      }
    }

    // --- Exits first: manage every open position from the latest marks. ---
    // state.positions is the account after this batch's fills; cost basis
    // (cost_lamports / token_amount) is the entry price including fees.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      const price = priceOf(state, mint);
      if (price === null || price <= 0) continue;
      const note = this.noteFor(mint);
      const entryPrice = Number(holding.cost_lamports) / Number(holding.token_amount);
      if (entryPrice <= 0) continue;
      if (note.entryPrice <= 0) note.entryPrice = entryPrice;
      if (note.peak < entryPrice) note.peak = entryPrice;
      if (price > note.peak) note.peak = price;
      const curve = state.curves.get(mint);
      const tradesHeld = curve === undefined ? 0 : curve.trades - note.entryTrades;
      const slotsHeld = note.entrySlot > 0 ? state.slot - note.entrySlot : 0;
      const fellFromPeak = price <= (note.peak * (BPS - TRAIL_BPS)) / BPS;
      const hitHardStop = price <= (entryPrice * (BPS - STOP_BPS)) / BPS;
      const goneStale = tradesHeld >= STALE_TRADES || slotsHeld >= STALE_SLOTS;
      if (fellFromPeak || hitHardStop || goneStale) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // --- Entries: buy young coins that have already shown a rise. ---
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const event of batch.events) {
      if (orders.length >= maxOrders || openSlots <= 0) break;
      if (event.event !== "TradeEvent") continue;
      const mint = event.mint;
      if (state.positions.has(mint)) continue;
      const note = this.noteFor(mint);
      if (note.decided) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        note.decided = true;
        continue;
      }
      // Freshness: only enter while the coin is still in its first trades
      // and its first minutes of life; older coins are someone else's trade.
      if (curve.trades > ENTER_WITHIN_TRADES) {
        note.decided = true;
        continue;
      }
      if (note.createdSlot !== null && state.slot - note.createdSlot > ENTER_WITHIN_SLOTS) {
        note.decided = true;
        continue;
      }
      // Momentum proof: the price must already be up on its first-seen
      // price. A coin that is flat or falling from birth is skipped.
      if (note.firstPrice === null || note.firstPrice <= 0) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      if (price < (note.firstPrice * (BPS + RISE_TO_ENTER_BPS)) / BPS) continue;
      // Size cap: 1% of real reserve. Wait for the reserve to grow if the
      // cap is still below the smallest buy worth the fees.
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + txFee) {
        note.decided = true;
        continue;
      }
      note.decided = true;
      note.entryTrades = curve.trades;
      note.entrySlot = state.slot;
      note.peak = price;
      orders.push({ side: "buy", mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      openSlots -= 1;
    }

    return orders;
  }
}
