# Security policy

## Status

Ramestta Agent OS is in **guarded mainnet beta** pending external audit. Contracts
are UUPS-upgradeable behind a 24-hour `AgentTimelock`, controlled by a 2-of-3
multisig. Start with small amounts; use testnet to experiment first.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security bug.

Email **security@ramestta.com** with:

- A description of the issue and its impact
- Repro steps, PoC, or proposed fix
- Your affiliation (optional)

We aim to acknowledge within 48 hours and issue a first-pass triage within
5 business days. Please give us a reasonable window to fix and roll out before
public disclosure — typically 90 days, sooner if a fix ships earlier.

## Scope

- Smart contracts in [`contracts/`](contracts/) currently deployed to Ramestta
  mainnet (chain 1370) — proxy addresses in [`README.md`](README.md).
- The `@ramestta/agent-kit` SDK ([`sdk/`](sdk/)) and `@ramestta/agent-mcp-server`
  ([`mcp-server/`](mcp-server/)) client libraries.
- The public read-only MCP endpoint at `https://agents.ramestta.com/mcp` and its
  source in [`remote-mcp/`](remote-mcp/).

Out of scope: RNS core, keeper economics gaming that isn't a vulnerability, and
third-party wallets/dApps built on top of the Agent OS.

## What we consider a vulnerability

- Any way to bypass the on-chain `AgentPermissions` spend caps, allow-lists, or
  the human approval inbox.
- Unauthorized upgrade paths on any UUPS/beacon proxy, or timelock bypass.
- Draining `AgentTreasury`, an `AgentWallet`, or the `SLAInsurancePool`.
- Impersonating a `.rama` agent identity or hijacking a booted agent.
- Any privilege escalation on `MultiSigWallet`.
- SDK/MCP bugs that would exfiltrate a controller key or leak it via error paths.
- Denial-of-service that permanently breaks a live agent (transient scheduler
  starvation is not in scope).

## Rewards

Bug bounty budget is being set up. Until it launches, we will offer a discretionary
reward proportional to severity and quality of the report — we would rather pay
than have a bug hit an operator.

## Coordinated disclosure hall of fame

We publish acknowledgments here after fixes ship — please tell us how you'd like
to be credited (name, handle, or anonymous).
