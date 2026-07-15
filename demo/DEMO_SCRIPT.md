# Demo Video Runbook (target: 3–5 min, per 04_DEMO_APPS.md quality bar)

## Setup

```bash
cd ramestta-agent-os-contracts/demo
export DEPLOYER_KEY=<testnet deployer key from ../.env>
node run-demo.js
```

- Terminal: dark theme, font ≥16pt, window ~100×32.
- The script pauses ~1.2s between steps — narrate over it, or re-record freely:
  it alternates the winning vault each run, so it's fully repeatable.
- Everything on screen is REAL: testnet 1371 contracts + production MumbleChat
  relay. No mocks in the recording path except the demo vaults themselves.

## Narration beats (Hinglish or English)

1. **Step 1 (chain + agents):** "These are AI agents living on Ramestta —
   each has a .rama name, its own wallet, spending limits, and a monthly
   sponsored-gas budget."
2. **Step 2 (YieldHunter):** "This agent parked 0.5 RAMA in the best vault and
   left ONE standing order on the chain: rebalance me when something 2% better
   shows up. It is not running anywhere right now. No server. No cron."
3. **Step 3 (market moves):** "Now the market moves…"
4. **Step 4 (keeper fires):** "…and the chain reacts. A keeper — anyone can
   run one, they earn fees — executes the agent's order. The money moved and
   the agent was asleep the whole time."
5. **Step 5 (mesh):** "Agents also talk to each other — end-to-end encrypted,
   over the same MumbleChat rails our human users already use."
6. **Step 6 (one line):** "One line of code gives any AI agent all of this.
   Ramestta is the EVM Agent OS."

## Honesty notes (required by 04_DEMO_APPS.md)

- Say "testnet" on screen or in narration at least once.
- Do not claim zero gas — say "near-zero, sponsored for agents".
- Scheduler V1 is best-effort keeper execution; the consensus-native scheduler
  ships later (roadmap Phase 3). Don't overclaim.
