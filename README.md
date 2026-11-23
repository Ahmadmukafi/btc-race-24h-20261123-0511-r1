# btc-race-24h-20261123-0511 r1

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Ahmadmukafi/btc-race-24h-20261123-0511-r1/rank.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Ahmadmukafi/btc-race-24h-20261123-0511-r1/reward.svg)](https://make.fun/c/btc-race-24h-20261123-0511)

A cbBTC 1-minute trading bot for the make.fun BTC race: one-shot, two ways in,
one position, full size. It buys either a wash-out dip (close 1.50% under its
60-bar EMA, ticking up) or a 4-hour trend ride (240-bar return over +1.00%
with price above its 240-bar EMA), then exits on a take-profit/stop/trailing
stop — and never re-enters, so a choppy day cannot bleed it through repeated
round trips.

Dev window (24h to the opening): net PnL **+13.27 USDC**, 2 trades, max
drawdown 1.09%, guardrails met — verified with the kit's own
`grade-local --driver process` (L1 regrade reproduced byte for byte).

Entry point: `main.ts` (Node 22, standard library only, speaks
`agent-fun/bars-replay/v1` on stdin/stdout). No dependencies, no network, no
clock, no randomness — every decision is a pure function of the bars seen.
