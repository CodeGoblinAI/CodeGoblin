#!/usr/bin/env bash
# CodeGoblin installer — installs the published npm meta package globally.
set -euo pipefail

PACKAGE="${CODEGOBLIN_NPM_PACKAGE:-codegoblin}"
VERSION="${VERSION:-latest}"
TAG="${CODEGOBLIN_NPM_TAG:-latest}"

if [ "$VERSION" = "latest" ] && [ -n "${TAG:-}" ] && [ "$TAG" != "latest" ]; then
  SPEC="${PACKAGE}@${TAG}"
else
  SPEC="${PACKAGE}@${VERSION}"
fi

echo "Installing CodeGoblin (${SPEC})..."

if command -v npm >/dev/null 2>&1; then
  npm install -g "$SPEC"
elif command -v bun >/dev/null 2>&1; then
  bun install -g "$SPEC"
elif command -v pnpm >/dev/null 2>&1; then
  pnpm install -g "$SPEC"
else
  echo "Error: npm, bun, or pnpm is required." >&2
  exit 1
fi

echo ""
echo "Installed. Run: codegoblin --help"
