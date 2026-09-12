# A live terminal never moves, and a workspace splits in two

Viktor, 2026-09-12: *"I want to be able to view multiple sessions at the same
time... I want to be able to manually drag-and-drop sessions around to arrange
my workspace."*

Design: `docs/plans/2026-09-12-multi-session-workspaces-design.md`.

Two decisions in that design will read as arbitrary later, and both are
expensive to reverse once the code is written against them. This record holds
the reasoning for both.

## 1. The split tree positions slots; it never reorders them

`frontend-v2/src/App.tsx:1139` renders every session the tab has kept, and hides
all but one:

```tsx
<For each={mounted()}>
  {(k) => {
    const shown = () => k.key === selectedKey();
    return <div class="tl-session-slot" classList={{ "tl-hidden": !shown() }}>
```

The comment above it states the rule this record makes binding:

> The slots are appended and never reordered, so a live terminal is never moved
> in the DOM.

`store/keepalive.ts` says what happens if one is: moving or replacing the node a
session hangs off disposes `TerminalNative`, which drops the xterm instance, the
ttyd socket and the tmux attach. ADR-0026 measured what rebuilding those costs —
779 ms for a warm open, of which 627 ms is ttyd forking, tmux attaching and
redrawing. keepalive exists to avoid paying it, and the same module names the
constraint as load-bearing: `list` only ever grows at the end and shrinks by
removal, and its entries are stable objects so `<For>` leaves the DOM alone.

### The decision

The split tree is a **positioning layer over a fixed DOM order**. A tile's place
in the tree is expressed as a CSS area (or a computed rect) assigned to the slot
where it already sits. Splitting, moving, closing and resizing change
assignments. No operation reorders `mounted()`, and no operation reparents a
slot.

### What this costs

Tiles cannot slide under the cursor during a drag. The design uses a translucent
drop shadow showing the region a tile will occupy, and tiles snap on release.
Live reflow during a drag was the alternative and was rejected: every reflow that
moved a slot would tear down and rebuild that session's terminal, which is
exactly the cost keepalive was built to remove.

### Alternatives considered

**Reorder the DOM and rebuild terminals.** Best drag feel, and it reintroduces a
~780 ms rebuild per moved tile — worse in a four-tile workspace than the single
switch keepalive already fixed.

**Portal each terminal into a positioned container.** Solid can move a node
without disposing the component, but the DOM node itself still moves, and moving
a live `<canvas>`-backed xterm across documents or containers re-triggers layout
and the fit path. It also reintroduces exactly the class of bug ADR-0020 closed
by putting one terminal in one document.

## 2. Workspace membership is server-side; geometry is not

A **Workspace** is an unnamed, implicit grouping: the set of sessions in a split
arrangement. It carries two kinds of state, and they are stored in different
places.

| state | store | scope |
|---|---|---|
| workspace id, ordered members | tmux-api, beside `layout/<user>.json` | per user, all devices |
| the split tree and tile sizes | the browser, beside `store/device-prefs.ts` | per device |

### Why membership roams

Membership is not a screen arrangement. It changes what the sidebar does:
members are marked, and clicking one enters its workspace rather than opening
that session alone. Three things follow.

- The sidebar is already server-driven through Layout. A device-local overlay on
  it would make one sidebar behave differently from another for the same user,
  with nothing on screen to explain why.
- Two tabs on one machine must agree. Per-browser storage gives them separate
  copies of an exclusivity rule — a session belongs to at most one workspace —
  and two tabs disagreeing about that produces conflicting writes with nothing
  to reconcile them.
- A kill must not silently drop membership, so a restored session returns to its
  workspace. `assignments/<user>.json` already does exactly this for project
  assignment, and it is server-side for the same reason.

### Why geometry does not

A tree of four columns describes a 32-inch monitor. It is meaningless on a
laptop and unrenderable on a phone, which sees no workspaces at all (coarse
pointer at 720px or narrower). Roaming it would mean carrying an arrangement to
devices that must immediately override it, and then inventing a rule for how
much of it to honour. Sidebar collapse state is kept per-browser on the same
reasoning and is named as such in `CONTEXT.md`.

A device with no stored geometry auto-arranges its members evenly in the
workspace's server-side member order, so a fresh device shows the group
immediately and deterministically, and the first drag makes the arrangement its
own.

### What this costs

Two stores for one object, and an update path that writes to both. A workspace
is also not fully portable: your laptop knows which four sessions belong
together but not how you had them arranged.

### Alternatives considered

**All of it per-device.** No server work at all, ships sooner. A workspace then
exists only on the machine that made it, two tabs disagree, and a restored
session cannot find its group.

**All of it server-side, geometry included.** Fully portable and backed up.
Needs a rule for what a narrow screen renders from a tree it cannot fit, and
that rule has to feel predictable every time the window is resized, which is a
cost paid on every resize for a benefit collected when a device is new.

## Status

Accepted 2026-09-12, before implementation. Both decisions are testable the
moment the first tile ships: a moved tile that keeps its scrollback and its
socket confirms the first, and a workspace that survives a page reload on one
device while looking different on another confirms the second.
