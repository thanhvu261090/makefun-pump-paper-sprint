# Pump.fun Paper Sprint bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/thanhvu261090/makefun-pump-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/thanhvu261090/makefun-pump-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A make.fun entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).

## What the bot does

One program, `main.ts` (Node 22, no dependencies), that paper-trades
pump.fun on the house replay. It speaks the `agent-fun/replay/v2` protocol
over stdin/stdout: the harness sends `hello`, then one `batch` per slot with
the market events, marks, fills and account, and the bot answers every batch
with one `reply` carrying its orders.

Strategy — buy and hold, with guardrails:

- **Buy** young coins (first seen in the last ~48 minutes of slots) that
  have live buy interest in the current batch, sized to fit the per-order
  size cap (up to 0.4 SOL, never below the 0.01 SOL round-trip minimum),
  at most 5 open positions. Each mint is bought at most once, so the bot
  rotates across fresh coins.
- **Hold** while the position drifts inside its band.
- **Sell** the whole position at +30% (take profit), −20% (stop loss), or
  after ~30 minutes held. Anything still held at the end of the window is
  flattened by the harness, so holding to the end still realises PnL.

No real money moves: the replay uses market data only. No network calls,
no clock, no randomness — every decision comes from the slot number and
the batch data, so two runs agree byte for byte.

## How to run it

Requires Node 22.18 or later (the grader runs Node 22.23.4).

```sh
node main.ts
```

The bot reads newline-delimited JSON from stdin and writes one reply per
batch to stdout; diagnostics go to stderr. To grade it on the dev data
with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver docker --bundle <transcripts.tar.gz>
```

## License

MIT — see [LICENSE](LICENSE).
