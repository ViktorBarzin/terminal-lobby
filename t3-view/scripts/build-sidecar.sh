#!/usr/bin/env bash
# Bundles the sidecar into one ES module that system node (24) runs:
#
#   build-sidecar.sh <out-dir>     writes <out-dir>/tl-t3-view.mjs
#   build-sidecar.sh -o <file>     writes <file> (packaging/build-deb.sh)
#
# Needs node_modules from link-t3.sh, so T3's contracts and its effect build
# are what gets bundled.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# descriptor.ts reports the pinned tag as serverVersion.
pin_tag="$(sed -n 's/^tag=//p' "$here/T3_PIN" | head -n1)"
if [[ "${1:-}" == "-o" ]]; then
	outfile="${2:?usage: build-sidecar.sh -o <file>}"
else
	outfile="${1:?usage: build-sidecar.sh <out-dir> | -o <file>}/tl-t3-view.mjs"
fi
mkdir -p "$(dirname "$outfile")"

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
	--define:__T3_PIN_TAG__="\"$pin_tag\"" \
	--log-level=warning \
	--outfile="$outfile"
echo "build-sidecar: $outfile"
