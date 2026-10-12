/**
 * T3's orchestration protocol is negotiated by exact match: the web client
 * sends its version as a query parameter on /ws and as a header on
 * /api/orchestration/*, and a server that speaks another version refuses
 * (426 on /ws, 400 on the HTTP routes), the same way T3's own server does
 * (apps/server/src/ws.ts hasCompatibleOrchestrationProtocol). The version is
 * the pinned contracts' constant, so a pin bump that changes it changes this.
 */
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";

import type { RequestHeaders } from "./auth.ts";

export function hasCompatibleOrchestrationProtocol(url: URL): boolean {
  return (
    url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) === ORCHESTRATION_PROTOCOL_VERSION_TEXT
  );
}

export function hasOrchestrationProtocolHeader(headers: RequestHeaders): boolean {
  return headers[ORCHESTRATION_PROTOCOL_HEADER] === ORCHESTRATION_PROTOCOL_VERSION_TEXT;
}

export const protocolIncompatibleBody = {
  code: "orchestration_protocol_incompatible",
  message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
} as const;
