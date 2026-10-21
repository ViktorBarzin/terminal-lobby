import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// The pinned T3 tag, as build-sidecar.sh passes it to esbuild (descriptor.ts).
const pinTag = /^tag=(.+)$/m.exec(readFileSync(new URL("./T3_PIN", import.meta.url), "utf8"))?.[1];

export default defineConfig({
  define: { __T3_PIN_TAG__: JSON.stringify(pinTag) },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
