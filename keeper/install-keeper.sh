#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Ramestta AI Agent OS — portable keeper installer.
#
# Run on ANY node to join the permissionless keeper market and earn task fees.
# The keeper polls the Scheduler and executes due tasks; each execution pays its
# flat fee to whoever lands it first. More keepers = better liveness; they share
# the fee opportunities.
#
# Usage (from the folder that also holds keeper.js):
#   ./install-keeper.sh                         # mainnet, fresh key auto-generated
#   NETWORK=testnet ./install-keeper.sh         # testnet
#   KEEPER_KEY=0x... ./install-keeper.sh        # bring your own key
#   INSTALL_DIR=/opt/ramestta-keeper sudo -E ./install-keeper.sh   # systemd (root)
#
# Prints the keeper ADDRESS to fund. NEVER prints the private key.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NETWORK="${NETWORK:-mainnet}"
if [ "$NETWORK" = "mainnet" ]; then
  RPC_DEFAULT="https://blockchain.ramestta.com"
  SCHED_DEFAULT="0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23"   # canonical upgradeable Scheduler
else
  RPC_DEFAULT="https://testnet.ramestta.com"
  SCHED_DEFAULT=""   # set SCHEDULER=... for testnet
fi
RPC_URL="${RPC_URL:-$RPC_DEFAULT}"
SCHEDULER="${SCHEDULER:-$SCHED_DEFAULT}"
POLL_MS="${POLL_MS:-30000}"
DIR="${INSTALL_DIR:-$HOME/ramestta-keeper}"

[ -n "$SCHEDULER" ] || { echo "ERROR: set SCHEDULER=0x... (no default for $NETWORK)"; exit 1; }
command -v node >/dev/null || { echo "ERROR: node.js not found — install Node 18+ first"; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR"; cd "$DIR"
[ -f keeper.js ] || cp "$SRC_DIR/keeper.js" .

# deps: just ethers
if [ ! -d node_modules/ethers ]; then
  echo "installing ethers…"
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install ethers@6 >/dev/null 2>&1
fi

# key: generate a fresh one unless provided (kept in keeper-key.json, mode 600)
if [ -z "${KEEPER_KEY:-}" ]; then
  if [ -f keeper-key.json ]; then
    KEEPER_KEY="$(node -e 'process.stdout.write(require("./keeper-key.json").key)')"
    ADDR="$(node -e 'process.stdout.write(require("./keeper-key.json").address)')"
  else
    read -r ADDR KEEPER_KEY < <(node -e 'const {Wallet}=require("ethers");const w=Wallet.createRandom();require("fs").writeFileSync("keeper-key.json",JSON.stringify({address:w.address,key:w.privateKey},null,2),{mode:0o600});process.stdout.write(w.address+" "+w.privateKey)')
    echo "generated fresh keeper key → keeper-key.json (mode 600)"
  fi
else
  ADDR="$(node -e 'const {Wallet}=require("ethers");process.stdout.write(new Wallet(process.env.KEEPER_KEY).address)')"
fi

umask 077
cat > env.sh <<EOF
export RPC_URL=$RPC_URL
export SCHEDULER=$SCHEDULER
export KEEPER_KEY=$KEEPER_KEY
export POLL_MS=$POLL_MS
EOF
chmod 600 env.sh

cat > run.sh <<'EOF'
#!/bin/bash
cd "$(dirname "$0")" && source env.sh
exec node keeper.js >> keeper.log 2>&1
EOF
chmod +x run.sh

# service: systemd if root, else a cron watchdog (cron-started procs survive SSH close)
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null; then
  SVC="ramestta-keeper-$NETWORK"
  cat > "/etc/systemd/system/$SVC.service" <<EOF
[Unit]
Description=Ramestta keeper ($NETWORK)
After=network-online.target
[Service]
EnvironmentFile=$DIR/env.sh
ExecStart=/usr/bin/env node $DIR/keeper.js
Restart=always
RestartSec=10
WorkingDirectory=$DIR
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable --now "$SVC"
  echo "installed systemd service: $SVC"
else
  cat > watchdog.sh <<EOF
#!/bin/bash
pgrep -f "node $DIR/keeper.js" >/dev/null || pgrep -f "node keeper.js" >/dev/null || nohup $DIR/run.sh >/dev/null 2>&1 &
EOF
  chmod +x watchdog.sh
  ( crontab -l 2>/dev/null | grep -v "$DIR/watchdog.sh"; echo "*/5 * * * * $DIR/watchdog.sh # ramestta-keeper"; echo "@reboot $DIR/watchdog.sh # ramestta-keeper" ) | crontab -
  echo "installed cron watchdog (*/5 + @reboot)"
fi

echo ""
echo "✅ keeper installed in $DIR ($NETWORK)"
echo "   watching Scheduler $SCHEDULER"
echo "   👉 FUND THIS ADDRESS with a little RAMA (gas; earns fees back): $ADDR"
echo "   logs: $DIR/keeper.log"
