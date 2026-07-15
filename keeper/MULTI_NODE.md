# Running keepers on many nodes (decentralize + earn)

The keeper market is **permissionless**: any node can run a keeper, poll the
Scheduler, and earn the flat fee of whatever due task it lands first. More
keepers → better liveness (multi-keeper redundancy) and more decentralization.
They **share** the fee opportunities, so N keepers don't each earn N× — they
compete; the first to execute a due task gets that task's fee.

## Nothing is bootnode-locked

- **Contracts are on-chain** (validator-distributed) — zero single point.
- Keepers/reporter/brain are just off-chain helpers; today they run on bootnode
  (81) + server116 (116). Any of them dying doesn't stop the protocol.

## Add a keeper to any node (one command)

Copy `keeper.js` + `install-keeper.sh` to the node, then:

```bash
# mainnet, fresh key auto-generated, cron watchdog (non-root)
./install-keeper.sh

# root box → systemd service instead of cron
INSTALL_DIR=/opt/ramestta-keeper sudo -E ./install-keeper.sh

# bring your own key
KEEPER_KEY=0x... ./install-keeper.sh
```

It installs `ethers`, writes a `600` env, sets up systemd (root) or a `*/5` cron
watchdog, and prints the **keeper address to fund** (a little RAMA for gas — it
earns fees back). The private key is written to `keeper-key.json` (600) and
**never printed**.

Defaults to the canonical mainnet Scheduler
`0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23`.

## Earning reality (guarded beta)

Right now the fresh mainnet stack has ~0 scheduled tasks, so keepers earn nothing
yet — adding them now is about **readiness + decentralization**. Earning starts
when real agents register recurring tasks. Each keeper only needs ~0.3–0.5 RAMA
of gas float to operate.

## Note on shared/validator boxes

A keeper is lightweight (polls + occasional tx), but on boxes running bor/heimdall
or other critical services, add it deliberately (its own key, resource-bounded) —
don't co-locate blindly on a validator doing consensus work.
