#!/bin/bash
# OpenClaw Remote Installer Agent (macOS/Linux)
# This script connects to the teacher's installation server

SERVER="SERVER_URL_PLACEHOLDER"
TOKEN="AGENT_TOKEN_PLACEHOLDER"
POLL_INTERVAL=2

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  OpenClaw Remote Installer Agent${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Gather system info
gather_info() {
  local node_ver
  node_ver=$(node --version 2>/dev/null || echo "not installed")
  local npm_ver
  npm_ver=$(npm --version 2>/dev/null || echo "not installed")

  cat <<JSONEOF
{
  "os": "$(uname -s | tr '[:upper:]' '[:lower:]')",
  "arch": "$(uname -m)",
  "shell": "$SHELL",
  "nodeVersion": "$node_ver",
  "npmVersion": "$npm_ver",
  "path": "$PATH",
  "homeDir": "$HOME",
  "user": "$(whoami)",
  "hostname": "$(hostname)",
  "osVersion": "$(sw_vers -productVersion 2>/dev/null || uname -r)"
}
JSONEOF
}

# Register with server
register() {
  local info
  info=$(gather_info)
  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$SERVER/api/agent/register" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Token: $TOKEN" \
    -d "$info" 2>/dev/null)

  local http_code
  http_code=$(echo "$response" | tail -1)
  if [ "$http_code" != "200" ]; then
    return 1
  fi
  return 0
}

# Poll for commands
poll() {
  curl -s -w "\n%{http_code}" "$SERVER/api/agent/poll" \
    -H "X-Agent-Token: $TOKEN" 2>/dev/null
}

# Send result
send_result() {
  local id="$1"
  local stdout_b64="$2"
  local stderr_b64="$3"
  local exit_code="$4"

  curl -s -X POST "$SERVER/api/agent/result" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Token: $TOKEN" \
    -d "{\"id\":\"$id\",\"stdout\":\"$stdout_b64\",\"stderr\":\"$stderr_b64\",\"exitCode\":$exit_code,\"encoding\":\"base64\"}" \
    >/dev/null 2>&1
}

# Heartbeat
heartbeat() {
  curl -s -X POST "$SERVER/api/agent/heartbeat" \
    -H "X-Agent-Token: $TOKEN" >/dev/null 2>&1
}

# Extract JSON value (simple, no jq dependency)
json_val() {
  echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}

# --- Main ---

echo -e "${YELLOW}Connecting to teacher's server...${NC}"

if ! register; then
  echo -e "${RED}Failed to connect. Check your internet connection.${NC}"
  exit 1
fi

echo -e "${GREEN}Connected! Waiting for teacher's instructions...${NC}"
echo -e "${GREEN}(Keep this terminal open)${NC}"
echo ""

HEARTBEAT_COUNTER=0

cleanup() {
  echo ""
  echo -e "${YELLOW}Disconnecting...${NC}"
  exit 0
}
trap cleanup INT TERM

while true; do
  # Heartbeat every 10 seconds
  HEARTBEAT_COUNTER=$((HEARTBEAT_COUNTER + 1))
  if [ "$HEARTBEAT_COUNTER" -ge 5 ]; then
    heartbeat
    HEARTBEAT_COUNTER=0
  fi

  # Poll for command
  RESPONSE=$(poll)
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    CMD_ID=$(json_val "$BODY" "id")
    CMD=$(json_val "$BODY" "command")

    if [ -n "$CMD" ] && [ -n "$CMD_ID" ]; then
      echo -e "${CYAN}[>] Running:${NC} $CMD"

      # Execute command with background heartbeats
      TMPOUT=$(mktemp)
      TMPERR=$(mktemp)

      # Run command in background
      eval "$CMD" > "$TMPOUT" 2> "$TMPERR" &
      CMD_PID=$!

      # Keep sending heartbeats while command runs
      while kill -0 "$CMD_PID" 2>/dev/null; do
        heartbeat
        sleep 2
      done

      wait "$CMD_PID"
      EXIT_CODE=$?

      STDOUT=$(cat "$TMPOUT")
      STDERR=$(cat "$TMPERR")
      rm -f "$TMPOUT" "$TMPERR"

      # Display output
      if [ -n "$STDOUT" ]; then
        echo "$STDOUT"
      fi
      if [ -n "$STDERR" ]; then
        echo -e "${RED}$STDERR${NC}"
      fi
      echo -e "${CYAN}[Exit code: $EXIT_CODE]${NC}"
      echo ""

      # Base64 encode and send
      STDOUT_B64=$(printf '%s' "$STDOUT" | base64 2>/dev/null || echo "")
      STDERR_B64=$(printf '%s' "$STDERR" | base64 2>/dev/null || echo "")

      send_result "$CMD_ID" "$STDOUT_B64" "$STDERR_B64" "$EXIT_CODE"
    fi
  fi

  sleep "$POLL_INTERVAL"
done
