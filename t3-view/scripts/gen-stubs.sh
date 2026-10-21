#!/usr/bin/env bash
# Regenerates src/rpc/stubs.ts from the pinned WsRpcGroup: every RPC the
# sidecar does not serve, mapped to its fallback. Run it after a pin bump
# (test/stubs.test.ts fails until the committed file matches).
#
#   gen-stubs.sh            rewrite src/rpc/stubs.ts
#   gen-stubs.sh <file>     write somewhere else
#
# Needs node_modules from link-t3.sh, like the tests and the bundle.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$here/src/rpc/stubs.ts}"
pin_tag="$(sed -n 's/^tag=//p' "$here/T3_PIN" | head -n1)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Bundled as build-sidecar.sh bundles the sidecar, since it imports the
# handlers and through them T3's contracts.
node "$here/node_modules/esbuild/bin/esbuild" "$here/scripts/gen-stubs.ts" \
	--bundle \
	--platform=node \
	--format=esm \
	--target=node24 \
	--external:bufferutil \
	--external:utf-8-validate \
	--banner:js='import { createRequire as __tlCreateRequire } from "node:module"; const require = __tlCreateRequire(import.meta.url);' \
	--define:__T3_PIN_TAG__="\"$pin_tag\"" \
	--log-level=warning \
	--outfile="$tmp/gen-stubs.mjs"
node "$tmp/gen-stubs.mjs" "$out"
