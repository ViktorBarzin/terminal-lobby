/** Entry point for scripts/gen-stubs.sh: writes the rendered stub table to argv[2]. */
import { writeFileSync } from "node:fs";

import { pinnedRpcs, renderStubs, servedTags } from "./stubs-render.ts";

const out = process.argv[2];
if (out === undefined) {
  process.stderr.write("usage: gen-stubs <out-file>\n");
  process.exit(2);
}
writeFileSync(out, renderStubs(pinnedRpcs(), servedTags()));
process.stdout.write(`gen-stubs: ${out}\n`);
