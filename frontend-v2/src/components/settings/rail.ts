/**
 * The Settings rail's model.
 *
 * The panel used to be thirteen groups down one 420px column, where the only
 * hierarchy was the order they happened to be written in. The rail is the
 * hierarchy now, so the list of pages lives here rather than being implied by
 * the JSX: it is the one place that answers what exists, in what order, and
 * with which rules between the groups.
 *
 * Three tiers, separated by a rule each:
 *   - preferences, the seven pages everyone has;
 *   - Skills, which is a thing you manage rather than a preference;
 *   - Act as user, which only renders for a caller who administers the box.
 */

export type PageId =
  | "appearance"
  | "terminal"
  | "sessions"
  | "keyboard"
  | "notifications"
  | "network"
  | "privacy"
  | "skills"
  | "actas";

export interface RailEntry {
  id: PageId;
  /** What the rail shows, and the page's own heading. */
  label: string;
  /** Draw a rule ABOVE this entry, separating it from the tier before it. */
  startsGroup?: boolean;
}

/** The preference pages, in reading order: what you look at most, first. */
const PREFERENCES: readonly RailEntry[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "sessions", label: "Sessions" },
  { id: "keyboard", label: "Keyboard" },
  { id: "notifications", label: "Notifications" },
  { id: "network", label: "Network" },
  { id: "privacy", label: "Privacy" },
];

/**
 * The rail for one caller. `admin` is the same signal that decides whether the
 * act-as control is offered at all — absent for everyone else, so the entry is
 * not merely disabled, it is not there.
 */
export const railFor = (opts: { admin: boolean }): RailEntry[] => {
  const entries: RailEntry[] = [
    ...PREFERENCES,
    { id: "skills", label: "Skills", startsGroup: true },
  ];
  if (opts.admin) entries.push({ id: "actas", label: "Act as user", startsGroup: true });
  return entries;
};

/**
 * Which page to show, given what was remembered from last time.
 *
 * The remembered id is read back in a context that may no longer offer it — a
 * tab opened as an admin stores "actas", and the same browser signed in as
 * someone else must not land on a page that is not in its rail. Anything the
 * rail does not carry falls back to the first entry.
 */
export const resolvePage = (
  entries: readonly RailEntry[],
  stored: string | null | undefined,
): PageId => {
  const hit = entries.find((e) => e.id === stored);
  return hit ? hit.id : (entries[0]?.id ?? "appearance");
};

/** What pressing an opener's button should do to a panel that may already be
 *  open. `goto` is the case that is easy to miss: two buttons, one dialog. */
export type OpenerAction =
  | { kind: "open"; page: PageId | undefined }
  | { kind: "close" }
  | { kind: "goto"; page: PageId };

/**
 * The rule behind the header's two buttons, and the phone's two menu items.
 *
 * Settings and Skills were separate overlays that toggled independently. They
 * are one dialog now, so a button press has three possible meanings and only
 * one of them is "close": the button for the page you are looking at closes the
 * panel, and the other one takes you to its page rather than shutting the
 * surface you asked to see.
 *
 * `pressed` is undefined for the gear, which means Settings-in-general and so
 * has no page of its own to compare against.
 */
export const openerAction = (state: {
  isOpen: boolean;
  /** the page the panel is SHOWING, not the one it was last sent to. */
  showing: PageId | undefined;
  pressed: PageId | undefined;
}): OpenerAction => {
  if (!state.isOpen) return { kind: "open", page: state.pressed };
  if (state.pressed === undefined || state.pressed === state.showing) {
    return { kind: "close" };
  }
  return { kind: "goto", page: state.pressed };
};
