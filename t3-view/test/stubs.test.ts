import { readFileSync } from "node:fs";

import { WsRpcGroup } from "@t3tools/contracts";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { describe, expect, it } from "vitest";

import { pinnedRpcs, renderStubs, servedTags } from "../scripts/stubs-render.ts";
import { silentStream, unavailable } from "../src/rpc/fallback.ts";
import { STUB_HANDLERS } from "../src/rpc/stubs.ts";

describe("STUB_HANDLERS", () => {
  const tags = [...WsRpcGroup.requests.keys()];
  const served = servedTags();

  it("is exactly what scripts/gen-stubs.sh writes for the pinned WsRpcGroup", () => {
    const committed = readFileSync(new URL("../src/rpc/stubs.ts", import.meta.url), "utf8");
    expect(committed).toBe(renderStubs(pinnedRpcs(), served));
  });

  it("covers every RPC the handlers do not serve, and none they do", () => {
    const stubbed = Object.keys(STUB_HANDLERS);
    expect(stubbed.filter((tag) => served.has(tag))).toEqual([]);
    expect([...stubbed, ...served].sort()).toEqual([...tags].sort());
  });

  it("keeps every subscription open and makes every unary call unavailable", () => {
    const stubs = new Map<string, unknown>(Object.entries(STUB_HANDLERS));
    for (const [tag, rpc] of WsRpcGroup.requests) {
      if (served.has(tag)) continue;
      const expected = RpcSchema.isStreamSchema(rpc.successSchema) ? silentStream : unavailable;
      expect(stubs.get(tag), tag).toBe(expected);
    }
  });
});
