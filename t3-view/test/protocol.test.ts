import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  hasCompatibleOrchestrationProtocol,
  hasOrchestrationProtocolHeader,
  protocolIncompatibleBody,
} from "../src/protocol.ts";

const url = (query: string) => new URL(`http://t3view.local/ws${query}`);

describe("orchestration protocol checks", () => {
  it("speaks the protocol version of the pinned contracts, which is 2", () => {
    expect(ORCHESTRATION_PROTOCOL_VERSION).toBe(2);
  });

  it("accepts /ws?orchestrationProtocol=2", () => {
    expect(hasCompatibleOrchestrationProtocol(url("?wsToken=x&orchestrationProtocol=2"))).toBe(
      true,
    );
  });

  it.each(["", "?orchestrationProtocol=1", "?orchestrationProtocol=3", "?orchestrationProtocol="])(
    "refuses /ws%s",
    (query) => {
      expect(hasCompatibleOrchestrationProtocol(url(query))).toBe(false);
    },
  );

  it("names the version the client must speak in the 426 body", () => {
    expect(protocolIncompatibleBody).toEqual({
      code: "orchestration_protocol_incompatible",
      message: "Update this client to one that supports orchestration protocol 2.",
      orchestrationProtocolVersion: 2,
    });
  });

  it("requires x-t3-orchestration-protocol: 2 on /api/orchestration routes", () => {
    expect(hasOrchestrationProtocolHeader({ "x-t3-orchestration-protocol": "2" })).toBe(true);
    expect(hasOrchestrationProtocolHeader({ "x-t3-orchestration-protocol": "1" })).toBe(false);
    expect(hasOrchestrationProtocolHeader({})).toBe(false);
  });
});
