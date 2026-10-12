#!/usr/bin/env bash
# Bundles the sidecar into one ES module that system node (24) runs:
#
#   build-sidecar.sh <out-dir>     writes <out-dir>/tl-t3-view.mjs
#
# Needs node_modules from link-t3.sh, so T3's contracts and its effect build
# are what gets bundled.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:?usage: build-sidecar.sh <out-dir>}"
mkdir -p "$out"

# ws (under @effect/platform-node) requires two optional native helpers inside
# a try/catch; left external they fail to load and ws uses its JS fallback.
# The banner gives the bundled CommonJS a real require for them and for node
# builtins.
node "$here/node_modules/esbuild/bin/esbuild" "$here/src/main.ts" \
	--bundle \
	--platform=node \
	--format=esm \
	--target=node24 \
	--external:bufferutil \
	--external:utf-8-validate \
	--banner:js='import { createRequire as __tlCreateRequire } from "node:module"; const require = __tlCreateRequire(import.meta.url);' \
	--log-level=warning \
	--outfile="$out/tl-t3-view.mjs"
echo "build-sidecar: $out/tl-t3-view.mjs"
