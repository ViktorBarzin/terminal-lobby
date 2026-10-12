import { WsRpcGroup } from "@t3tools/contracts";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { describe, expect, it } from "vitest";

import { STUB_HANDLERS, silentStream, unavailable } from "../src/rpc/stubs.ts";

describe("STUB_HANDLERS", () => {
  const tags = [...WsRpcGroup.requests.keys()];

  it("covers exactly the RPCs of the pinned WsRpcGroup", () => {
    expect(tags).toHaveLength(193);
    expect(Object.keys(STUB_HANDLERS).sort()).toEqual([...tags].sort());
  });

  it("keeps every subscription open and makes every unary call unavailable", () => {
    const stubs = new Map<string, unknown>(Object.entries(STUB_HANDLERS));
    for (const [tag, rpc] of WsRpcGroup.requests) {
      const expected = RpcSchema.isStreamSchema(rpc.successSchema) ? silentStream : unavailable;
      expect(stubs.get(tag), tag).toBe(expected);
    }
  });
});
