import { For, type Accessor, type Component } from "solid-js";
import { Group, Row } from "../controls";

/** What Settings needs to render the act-as picker. Absent for a non-admin. */
export interface ActAsControl {
  /** Mapped OS users this caller may act as (already excludes themselves). */
  users: Accessor<string[]>;
  /** The user currently being acted as, "" when it is your own lobby. */
  current: Accessor<string>;
  /** Switch to a user, or "" to return to your own lobby. Navigates. */
  switchTo: (osUser: string) => void;
}

/**
 * The admin act-as picker. The whole page renders only when the caller
 * administers this box, so a non-admin has no rail entry for it either.
 *
 * The note stays in the page: taking on another user's lobby is not something
 * to discover after the fact.
 */
export const ActAsPage: Component<{ actAs: ActAsControl }> = (props) => (
  <Group>
    <Row
      label="Act as user"
      labelFor="tl-set-actas"
      note="This tab becomes that user: their sessions, files and terminal, with full read-write access as them. Your other tabs are unaffected. Every switch is recorded."
    >
      <select
        id="tl-set-actas"
        class="tl-set-select"
        aria-label="Act as another user"
        value={props.actAs.current()}
        onChange={(e) => props.actAs.switchTo(e.currentTarget.value)}
      >
        <option value="">— myself —</option>
        <For each={props.actAs.users()}>{(u) => <option value={u}>{u}</option>}</For>
      </select>
    </Row>
  </Group>
);
