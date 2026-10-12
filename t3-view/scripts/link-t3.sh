#!/usr/bin/env bash
# Points t3-view/node_modules at a pinned T3 checkout prepared by
# build-web.sh, so the sidecar compiles, tests and bundles against T3's own
# contracts and the exact effect build T3's lockfile resolves (4.0.2 with T3's
# patch). There is no second lockfile: every package here comes from T3's.
#
#   link-t3.sh <work-dir>     (the same <work-dir> given to build-web.sh)
#
# node_modules is generated and gitignored; run this again after a pin bump.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="${1:?usage: link-t3.sh <work-dir>}"
t3="$(cd "$work/t3" && pwd)"
hoisted="$t3/node_modules/.pnpm/node_modules"
web="$t3/apps/web/node_modules"

# name -> directory inside the checkout. readlink -f resolves pnpm's symlinks
# so every tool sees one real path per package, which keeps a single effect
# module instance across the sidecar and T3's contracts.
declare -A links=(
	[effect]="$web/effect"
	[@effect/platform-node]="$web/@effect/platform-node"
	[@t3tools/contracts]="$t3/packages/contracts"
	[@t3tools/shared]="$t3/packages/shared"
	[@t3tools/client-runtime]="$t3/packages/client-runtime"
	# Two app packages, for single files that import only contracts: the
	# server's RPC scope table (auth/RpcAuthorization.ts) and, in tests, the
	# web client's own first-run gate logic.
	[t3]="$t3/apps/server"
	[@t3tools/web]="$t3/apps/web"
	[esbuild]="$hoisted/esbuild"
	[vitest]="$hoisted/vitest"
	[typescript]="$t3/node_modules/typescript"
	[@types/node]="$t3/node_modules/@types/node"
)

rm -rf "$here/node_modules"
for name in "${!links[@]}"; do
	target="$(readlink -f "${links[$name]}")"
	if [[ ! -d "$target" ]]; then
		echo "link-t3: $name not found at ${links[$name]}; run build-web.sh --deps-only $work" >&2
		exit 1
	fi
	mkdir -p "$here/node_modules/$(dirname "$name")"
	ln -s "$target" "$here/node_modules/$name"
done
# build-web.sh installs the web client's closure, which leaves apps/server
# without node_modules. RpcAuthorization.ts imports effect and contracts from
# there, so give it the same two packages (inside the generated checkout,
# never in the reference clone).
server_modules="$t3/apps/server/node_modules"
if [[ ! -e "$server_modules/effect" ]]; then
	mkdir -p "$server_modules/@t3tools"
	ln -s "$(readlink -f "$web/effect")" "$server_modules/effect"
	ln -s "$t3/packages/contracts" "$server_modules/@t3tools/contracts"
fi
echo "link-t3: node_modules -> $t3"
