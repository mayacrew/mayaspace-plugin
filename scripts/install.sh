#!/usr/bin/env bash
#
# Copy the built plugin (main.js + manifest.json + styles.css) into each
# Obsidian vault listed in VAULTS. Run after `npm run build` (or use
# `npm run deploy`, which builds then installs).
#
# Add more vaults by appending to the VAULTS array.

set -euo pipefail

PLUGIN_ID="mayaspace-plugin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VAULTS=(
	"/Users/devtkim/Documents/ObsidianVault"
	"/Users/devtkim/Documents/mark"
)

ARTIFACTS=("main.js" "manifest.json" "styles.css")

for artifact in "${ARTIFACTS[@]}"; do
	if [[ ! -f "$ROOT/$artifact" ]]; then
		echo "missing $artifact in $ROOT — run 'npm run build' first" >&2
		exit 1
	fi
done

for vault in "${VAULTS[@]}"; do
	if [[ ! -d "$vault" ]]; then
		echo "skip: vault not found at $vault" >&2
		continue
	fi
	dest="$vault/.obsidian/plugins/$PLUGIN_ID"
	mkdir -p "$dest"
	for artifact in "${ARTIFACTS[@]}"; do
		cp "$ROOT/$artifact" "$dest/$artifact"
	done
	echo "installed → $dest"
done
