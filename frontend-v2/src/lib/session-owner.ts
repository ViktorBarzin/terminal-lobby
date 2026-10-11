import { createContext, useContext } from "solid-js";

/**
 * The account that owns the session a view is showing, when it is not the
 * viewer's own (ADR-0043). SessionView provides it, and the parts of the Text
 * view that build their own session-events URLs (pictures, an agent's
 * drill-in, steering an agent) read it rather than having it threaded through
 * every component between. Undefined for your own session.
 */
const SessionOwnerContext = createContext<string | undefined>(undefined);

export const SessionOwnerProvider = SessionOwnerContext.Provider;

export function useSessionOwner(): string | undefined {
  return useContext(SessionOwnerContext);
}
