#!/usr/bin/env bash
# Save the refresh token on the clipboard to COOKUNITY_REFRESH_TOKEN_FILE.
#
# Copy the `refresh_token` value from the browser first (DevTools -> Application -> Local
# Storage -> the @@auth0spajs@@ key's body). Then CLEAR cookunity.com site data in Chrome and
# log in again: the browser and this server must not share one token, or Auth0's reuse
# detection can revoke both.
#
# Never prints the token. Usage: load-refresh-token.sh [--dry-run]
set -euo pipefail
# An inherited SHELLOPTS=xtrace would trace the clipboard assignment below to stderr.
set +x

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# Mirrors REFRESH_TOKEN_* in src/constants.ts.
MIN_LENGTH=40
MAX_LENGTH=1024

DEST="${COOKUNITY_REFRESH_TOKEN_FILE:-}"
if [[ -z "$DEST" ]]; then
  echo "error: set COOKUNITY_REFRESH_TOKEN_FILE to the destination path" >&2
  exit 2
fi

value="$(pbpaste | tr -d '[:space:]')"
# Strip surrounding quotes from a copied JSON value.
value="${value#\"}"; value="${value%\"}"

if [[ ! "$value" =~ ^v1\.[A-Za-z0-9._-]+$ ]] || (( ${#value} < MIN_LENGTH || ${#value} > MAX_LENGTH )); then
  echo "error: clipboard does not look like a refresh token (expected v1.-prefixed, ${MIN_LENGTH}-${MAX_LENGTH} chars). Nothing written." >&2
  exit 1
fi

if (( DRY_RUN )); then
  echo "[dry-run] clipboard looks like a refresh token (${#value} chars); would write to $DEST (mode 600)"
  exit 0
fi

umask 077
mkdir -p "$(dirname "$DEST")"
tmp="$(mktemp "$DEST.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$value" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$DEST"
trap - EXIT
echo "saved refresh token to $DEST (${#value} chars, mode 600)"
echo "next: clear cookunity.com site data in Chrome and log in again, then run: npm run verify:refresh"
