#!/usr/bin/env bash
#
# Build the single-file nanopi.js distribution locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-single-file.sh [--skip-install] [--skip-build] [--offline-model-data] [--out <dir>]
#
# Options:
#   --skip-install       Skip pnpm install
#   --skip-build         Skip the workspace build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   <out>/nanopi.js      Zero-dependency single-file CLI for Node >= 22.19

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    pnpm install --frozen-lockfile --ignore-scripts
else
    echo "==> Skipping pnpm install (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        pnpm run build:offline
    else
        echo "==> Building all packages..."
        pnpm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building single-file distribution..."
mkdir -p "$OUTPUT_DIR"
node scripts/build-coding-agent-single-file.mjs --out "$OUTPUT_DIR/nanopi.js"

echo ""
echo "==> Build complete!"
ls -lh "$OUTPUT_DIR/nanopi.js"
echo ""
echo "Smoke test from outside the repository:"
echo "  node \"$OUTPUT_DIR/nanopi.js\" --version"
