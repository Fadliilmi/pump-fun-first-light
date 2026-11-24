// Pump.fun Paper Sprint entry: first-light momentum bot.
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout as
// newline-delimited JSON. It opens with a hello message — protocol, seed,
// universe, capital (10 SOL), caps (max 5 open positions, 100 bps of real
// reserve per order, max 16 orders per batch, no shorts, no leverage),
// latency (2 slots) and fees — then one batch message per slot carrying
// that slot's market events (CreateEvent / TradeEvent / CompleteEvent),
// marks, fills and the account, and finally done. For every batch we must
// reply with exactly one line echoing its seq and carrying our orders; the
// orders fill at slot + latency_slots.
//
// All decisions live in strategy.ts (FirstLightMomentum). This file only
// owns the wire: hello, one reply per batch, done. No randomness, no clock,
// no network, no environment reads — fully deterministic, so the grader's
// two runs produce byte-identical action logs.

import { runBot } from "./vendor/makefun-bot.ts";
import { FirstLightMomentum } from "./strategy.ts";

const strategy = new FirstLightMomentum();

await runBot({
  onHello(state) {
    // Hello handshake: log the seed, capital and caps on stderr only
    // (stdout carries replies and nothing else). The strategy needs no
    // randomness, so the seed is recorded but never used for decisions.
    console.error(
      `hello: protocol=${state.hello.protocol} seed=${state.hello.seed} ` +
        `capital=${state.hello.capital.lamports} maxPositions=${state.hello.caps.max_open_positions} ` +
        `maxOrderBps=${state.hello.caps.max_order_bps_of_real_reserve} ` +
        `maxOrdersPerBatch=${state.hello.caps.max_orders_per_batch} latencySlots=${state.hello.latency_slots}`,
    );
  },
  onBatch(state, batch) {
    // One reply per batch, echoing batch.seq: the strategy's orders for
    // this slot (sells first, then new buys, within the caps).
    return strategy.decide(state, batch);
  },
  onDone(state, done) {
    // Done: the replay ended and the harness already flattened positions.
    // Nothing to reply; report the final account on stderr for the logs.
    console.error(
      `done: reason=${done.reason} cash=${state.account.cash_lamports} ` +
        `positions=${state.account.positions.length}`,
    );
  },
});
