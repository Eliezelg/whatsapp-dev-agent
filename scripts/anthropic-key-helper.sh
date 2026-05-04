#!/bin/sh
# Anthropic API key helper for Claude Code CLI.
#
# Used by ~/.claude/settings.json apiKeyHelper to avoid having
# ANTHROPIC_API_KEY in process.env (where Claude Code can `console.log`
# it via prompt injection).
#
# The key is read from a chmod 600 file at runtime, not env vars.
# This way, even if Claude Code is told to "print process.env", the key
# is not there.
#
# Setup:
#   echo "sk-ant-..." > /opt/whatsapp-agent/.anthropic-key
#   chmod 600 /opt/whatsapp-agent/.anthropic-key
#   chown wa-agent:wa-agent /opt/whatsapp-agent/.anthropic-key

set -eu

KEY_FILE="${ANTHROPIC_KEY_FILE:-/opt/whatsapp-agent/.anthropic-key}"

if [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: $KEY_FILE not found" >&2
  exit 1
fi

# Output the key (Claude Code reads it from stdout)
cat "$KEY_FILE"
