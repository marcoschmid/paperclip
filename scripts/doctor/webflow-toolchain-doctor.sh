#!/usr/bin/env bash
set -uo pipefail

failures=0

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

check_file() {
  local path="$1"
  if [[ -f "$path" ]]; then
    pass "file exists: $path"
  else
    fail "missing file: $path"
  fi
}

check_contains() {
  local path="$1"
  local needle="$2"
  local label="$3"
  if [[ -f "$path" ]] && grep -Fq "$needle" "$path"; then
    pass "$label"
  else
    fail "$label"
  fi
}

OPENCLAW_PROJECT="/Users/marco/.openclaw/workspace/projects/paperclip"
CODEX_HOME_DIR="${CODEX_HOME:-/Users/marco/paperclip/instances/default/companies/0a7df9a5-299e-4d64-a4d4-0c4c63784425/codex-home}"
CODEX_CONFIG="$CODEX_HOME_DIR/config.toml"
CLAUDE_SKILL="/Users/marco/.claude/skills/webflow-toolchain/SKILL.md"
CODEX_SKILL="$CODEX_HOME_DIR/skills/webflow-toolchain/SKILL.md"
HERMES_CONFIG="/Users/marco/.hermes/config.yaml"
HERMES_SKILL="/Users/marco/.hermes/skills/web-development/webflow-toolchain/SKILL.md"
BRIEFING="$OPENCLAW_PROJECT/docs/briefing/06-webflow-toolchain.md"
TOOLS_DOC="$OPENCLAW_PROJECT/docs/TOOLS.md"

check_file "$OPENCLAW_PROJECT/PROJECT.md"
check_contains "$OPENCLAW_PROJECT/PROJECT.md" "Webflow Toolchain" "OpenClaw project card documents Webflow"
check_file "$BRIEFING"
check_contains "$BRIEFING" "webflow-toolchain" "OpenClaw briefing names Webflow skill"
check_file "$TOOLS_DOC"
check_contains "$TOOLS_DOC" "https://mcp.webflow.com/mcp" "OpenClaw TOOLS documents Webflow MCP endpoint"

check_file "$CODEX_CONFIG"
check_contains "$CODEX_CONFIG" "[mcp_servers.webflow]" "Codex Webflow MCP configured"
check_contains "$CODEX_CONFIG" "https://mcp.webflow.com/mcp" "Codex Webflow MCP endpoint configured"
check_file "$CODEX_SKILL"
check_contains "$CODEX_SKILL" "webflow-toolchain" "Codex Webflow skill installed"

if command -v claude >/dev/null 2>&1; then
  claude_mcp_list_output="$(claude mcp list 2>/dev/null || true)"
  if printf '%s\n' "$claude_mcp_list_output" | grep -qi "Webflow"; then
    pass "Claude Webflow MCP visible"
  else
    fail "Claude Webflow MCP not visible"
  fi
  if printf '%s\n' "$claude_mcp_list_output" | grep -qE "mcp\.webflow\.com/mcp|webflow-mcp-wrapper\.sh"; then
    pass "Claude Webflow MCP uses canonical URL or wrapper"
  else
    fail "Claude Webflow MCP uses canonical URL or wrapper"
  fi
else
  fail "claude command not found"
fi
check_file "$CLAUDE_SKILL"
check_contains "$CLAUDE_SKILL" "webflow-toolchain" "Claude Webflow skill installed"

check_file "$HERMES_CONFIG"
check_contains "$HERMES_CONFIG" "mcp_servers:" "Hermes MCP section configured"
check_contains "$HERMES_CONFIG" "https://mcp.webflow.com/mcp" "Hermes Webflow MCP endpoint configured"
check_file "$HERMES_SKILL"
check_contains "$HERMES_SKILL" "webflow-toolchain" "Hermes Webflow skill installed"

if command -v webflow >/dev/null 2>&1; then
  pass "Webflow CLI available on PATH"
elif command -v npx >/dev/null 2>&1; then
  pass "npx available for on-demand Webflow CLI"
else
  fail "neither webflow nor npx available"
fi

if grep -RIE \
  "(webflow[^[:space:]]*(token|secret|key)|Authorization:[[:space:]]*Bearer|access_token|refresh_token)" \
  "$BRIEFING" "$TOOLS_DOC" "$CODEX_SKILL" "$CLAUDE_SKILL" "$HERMES_SKILL" >/dev/null 2>&1; then
  fail "possible Webflow secret marker found in docs or skills"
else
  pass "no Webflow secret markers in docs or skills"
fi

if [[ "$failures" -eq 0 ]]; then
  printf 'OK webflow toolchain wiring verified\n'
  exit 0
fi

printf 'ERROR webflow toolchain wiring has %d failure(s)\n' "$failures"
exit 1
