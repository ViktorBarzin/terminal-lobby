import { Show, type Accessor, type Component } from "solid-js";
import { claudeBackendFor, type PrefsStore } from "../../../store/prefs";
import type { ClaudeBackend, Whoami } from "../../../types/lobby";
import { Group, Row, Segmented, Toggle } from "../controls";

const BACKEND_LABELS: Record<ClaudeBackend, string> = {
  t3: "T3",
  tmux: "Terminal lobby",
};

/** What the sidebar tells you about the sessions you already have, and where
 *  a new Claude session runs.
 *
 *  There is no default command to choose here: every new session starts on
 *  Claude, and another command picked in the composer lasts that one session
 *  (store/prefs.ts, oneSessionCleared; Viktor, 2026-09-30). Where that Claude
 *  runs is a standing choice for a user who has a T3 (ADR-0046 decision 3),
 *  and the composer's "Claude in T3" and "Claude in Terminal" rows override it
 *  for one session. */
export const SessionsPage: Component<{
  prefs: PrefsStore;
  whoami?: Accessor<Whoami | null>;
}> = (props) => {
  const p = () => props.prefs.prefs();
  const who = () => props.whoami?.() ?? null;
  const backend = () => claudeBackendFor(p().session.claudeBackend, who());

  return (
    <Group>
      <Show when={who()?.t3}>
        <Row
          label="New Claude sessions run in"
          hint="T3 starts each new Claude session as a thread in your own T3 Code, which opens in a new tab. Terminal lobby starts it in a terminal here, as before. Codex, pi and shells always run here. The New session screen offers the other one for a single session."
        >
          <Segmented<ClaudeBackend>
            label="New Claude sessions run in"
            options={["t3", "tmux"]}
            value={backend()}
            format={(v) => BACKEND_LABELS[v]}
            onChange={(v) => props.prefs.setPref({ session: { claudeBackend: v } })}
          />
        </Row>
      </Show>
      <Row
        label="Show when each session was last driven"
        hint="The last time someone was attached to it and able to type — watching a session does not move this. A running session shows its live timer instead, which counts the turn in flight."
      >
        <Toggle
          label="Show when each session was last driven"
          checked={p().sidebar.showLastActive}
          onChange={(on) => props.prefs.setPref({ sidebar: { showLastActive: on } })}
        />
      </Row>
    </Group>
  );
};
