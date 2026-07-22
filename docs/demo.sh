#!/usr/bin/env bash
# Renders a scripted "AI agent using cookie-mcp" session for the README demo GIF.
# It is a staged reenactment (typed lines, illustrative values) — not a live API run.
# Driven by docs/demo.tape via VHS:  vhs docs/demo.tape
set -euo pipefail

# ---- pacing (override with env when tuning) --------------------------------
CHAR=${CHAR:-0.028}   # per-keystroke delay for the "typed" user prompts
LINE=${LINE:-0.11}    # delay between streamed result lines
BEAT=${BEAT:-0.5}     # short pause
THINK=${THINK:-0.7}   # agent "thinking" pause before it acts

# ---- palette (truecolor ANSI) ---------------------------------------------
R=$'\033[0m'; B=$'\033[1m'
DIM=$'\033[38;5;244m'
WHT=$'\033[38;5;231m'
AMBER=$'\033[38;5;214m'   # Cookie accent — tool bullet
GRN=$'\033[38;5;114m'     # success
BLU=$'\033[38;5;110m'     # json values
MUT=$'\033[38;5;66m'      # muted labels

type_line() { local s="$1" i; for ((i=0; i<${#s}; i++)); do printf '%s' "${s:i:1}"; sleep "$CHAR"; done; }

# a user turn: the muted ">" prompt, then the question typed out
ask() { printf '\n%s>%s %s' "$MUT" "$R$WHT" ""; type_line "$1"; printf '%s\n' "$R"; sleep "$THINK"; }

# a tool invocation line:  ⏺ tool_name(args)
tool() { printf '%s⏺%s %s%s%s%s(%s)%s\n' "$AMBER" "$R" "$B" "$1" "$R" "$DIM" "$2" "$R"; sleep "$BEAT"; }

# streamed result body under the tree connector
res() {
  local first=1 l
  for l in "$@"; do
    if ((first)); then printf '  %s└%s  %s%s\n' "$DIM" "$R" "$DIM" "$l$R"; first=0
    else printf '     %s%s\n' "$DIM" "$l$R"; fi
    sleep "$LINE"
  done
  sleep "$BEAT"
}

# final assistant sentence
say() { printf '%s⏺%s %s%s%s\n' "$WHT" "$R" "$WHT" "$1" "$R"; sleep "$BEAT"; }

clear
printf '%s cookie-mcp %s· 32 onchain tools · wallet keyed · non-custodial: signs locally, simulates first%s\n' "$AMBER$B" "$R$DIM" "$R"
sleep "$BEAT"

# ---------------------------------------------------------------------------
ask "What's the health of Cookie Chain right now?"
tool "chain_health" ""
res '{ "healthy": true, "status": "operational", "epoch": 33, "epochProgressPct": 73.5,' \
    '  "slots": { "confirmed": 14573743, "finalized": 14573705 }, "slotsPerSec": 2.78 }'

ask "Bridge 1000 COOK from Solana to Cookie Chain."
tool "bridge" 'solana-to-cookie · 1000 COOK · simulated first'
res '{ "direction": "solana-to-cookie", "amount": "1000", "destinationDomain": 420042004,' \
    '  "sourceSignature": "4vN1v9…8ZtQ", "messageId": "0x7ab3…e10c", "delivered": true }'

ask "Buy COOKHOUSE with 100 COOK."
tool "trade" 'COOKHOUSE C4yVWDrw…uFonFi5 · in 100 COOK · simulated first'
res '{ "confirmed": true, "signature": "5Kd8xq…pW3a",' \
    '  "input": { "symbol": "COOK", "amount": "100" },' \
    '  "output": { "symbol": "COOKHOUSE", "expectedOut": "6634.410639", "minOut": "6290.084726" },' \
    '  "route": { "venues": ["Cookiebox DAMM"] } }'

ask "Stake 200 COOK for bCOOK."
tool "stake" 'in 200 COOK · simulated first'
res '{ "signature": "2pM7Hf…rQ9x", "staked": { "amount": "200", "symbol": "COOK" },' \
    '  "received": { "estimate": "175.701402", "symbol": "bCOOK" }, "rate": 1.1326 }'

ask "Bridge 500 COOK from Cookie Chain back to Solana."
tool "bridge" 'cookie-to-solana · 500 COOK · simulated first'
res '{ "direction": "cookie-to-solana", "amount": "500", "destinationDomain": 1399811149,' \
    '  "sourceSignature": "3Jq6c2…Hk44L", "messageId": "0x9c3d…1a7f", "delivered": true }'

say "Done — 1000 COOK bridged in · 6,634 COOKHOUSE bought · 200 COOK → 175.7 bCOOK · 500 COOK bridged out."

sleep 3600   # hold the final frame; VHS ends the recording via docs/demo.tape
