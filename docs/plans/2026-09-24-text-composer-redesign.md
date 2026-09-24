# Redesigning the Text view composer

**Status:** draft 2026-09-24. Five directions built for review; none chosen yet.
**Owner:** wizard. **Repos touched:** terminal-lobby (frontend-v2), once a direction is chosen.
**Decisions from:** Viktor's request on 2026-09-24 and three questions he answered the same day.

The pictures and the five live prototypes sit beside the published page on
pages.viktorbarzin.me, under `composer/`.

## What we are solving

Viktor asked for a full redesign of the composer at the bottom of the Text view,
and of what it shows. Asked what bothers him, he picked all four of these:

1. **Too much at once.** Attach, the mode chip, the model and effort chip, Stop
   and Send sit in one row all the time.
2. **It takes too much of the screen.** A tall box plus a row of chips takes
   space from the conversation, most of all on a phone.
3. **The controls say too little.** "manual" and "claude-opus-5-5 · medium" do
   not read as things to press, or say what pressing them does, and a red Stop
   shows while Claude is only waiting for an answer.
4. **It looks generic.** It works, but it does not feel designed for this app.

Scope, as he chose it: the composer and the status line above it
("● Working… 24m 21s · 7 steps", "● Waiting for you 3s"), designed as one piece.
The docked question card and the permission panel keep their look, and have to
sit well above whatever replaces the composer. Desktop and phone count equally.

## Today, measured

Measured on the deployed build (0.71.2) in an idle session, at the same frame
sizes the prototypes use.

| | Desktop 1280×800 | Phone 390×844 |
|---|---|---|
| Composer at rest | 124px | 127px |
| Controls at rest | 4: Attach, mode, model, Send | 4, the same |
| While Claude works | 160px: the working row in the timeline, a gap, then the composer | 183px; the command label wraps to two lines |
| Controls while working | 5: Stop joins | 5 |

On the phone the model chip is 152px wide and runs under Send at rest and under
Stop while working, so it reads "claude-opus-5-5 · ı" and then "claud". That is
a defect in today's layout, whichever direction is chosen.

![Today at rest, desktop and phone](composer/shots/0-today-idle.webp)

![Today while Claude works](composer/shots/0-today-working.webp)

## The five directions

Each direction was built by a separate designer, blind to the other four, from
one brief (see [how they were made](#how-they-were-made)). All five use the app's
own theme tokens and its two fonts, DM Sans and JetBrains Mono, so any of them
works in all eight themes; they differ in layout, hierarchy, motion and what they
choose to show.

Every prototype is live. Both frames take typing, and the state switcher covers
Idle, Typing, Attachments, Working, Waiting, Menus, Watching and Keyboard up.
A theme toggle switches between slate and t3-light, and each mode control can be
walked round to bypass to see how a dangerous mode is marked.

| | Direction | At rest, desktop / phone | Controls at rest | Status lives | Stop lives | Mode and model |
|---|---|---|---|---|---|---|
| | Today | 124 / 127px | 4 | a timeline row | the bar, beside Send | chips in the bar |
| 1 | [Quiet line](composer/1-quiet-line.html) | 86 / 92px | 5 | one thin line above the field | on that line | labelled dials on that line |
| 2 | [Instrument panel](composer/2-instrument-panel.html) | 125 / 129px | 5 / 3 | the composer's top band | the band, "Stop Claude" | labelled cells; one Session control on the phone |
| 3 | [Prompt](composer/3-prompt.html) | 75 / 97px | 5 | a tmux-style strip under the field | a ^C key cap beside the field | segments in that strip |
| 4 | [Floating card](composer/4-floating-card.html) | 101 / 118px | 5 | a pill on the card's top edge | in that pill | icons, named on hover; short labels on the phone |
| 5 | [Tide](composer/5-tide.html) | 72 / 70px | 1 | a coloured line that grows into a strip | the strip, while working | a tray that rises on hover or focus |

Heights include each direction's own status line, which today is a separate row
in the timeline. Phone figures leave out the home-indicator strip; direction 4's
includes the 22px margin its card floats on. Controls are counted as buttons,
not counting the field.

### 1. Quiet line

**[Open the prototype](composer/1-quiet-line.html).** The composer should cost
one line until you need more.

- A single-line pill holds a "+", the field and Send. The "+" opens a tray:
  attach a file, add a photo, / commands, @ a file path.
- One thin line above it carries the state on the left ("Working · Edit
  QuestionCard.tsx · 4m 12s · 7 steps", with Stop beside it) and three labelled
  dials on the right: mode, model with effort, context. On the phone they open
  one sheet with three tabs.
- The dock's top edge lights with the state: a slow sweep while working, the
  awaiting colour while waiting, a dashed danger rule in bypass.
- Queued prompts become dashed ghost bubbles at the end of the conversation.
- Breaks three pinned behaviours: Attach loses its word, the controls no longer
  sit on a bar below the field, and the dials line is not part of the field's
  surface. A mode click opens a list of the six modes rather than cycling.

![Quiet line at rest](composer/shots/1-idle.webp)

![Quiet line while Claude works](composer/shots/1-working.webp)

### 2. Instrument panel

**[Open the prototype](composer/2-instrument-panel.html).** Every control says
what it is and what it will do.

- One framed instrument in three rows. The top band is the status line: the
  state word lit like a lamp, the tool, elapsed time, steps, and "Stop Claude"
  only while Claude works. The band's colour is Claude's state.
- Below the field, a rail of labelled cells: MODE (each mode explained in one
  line in its menu), MODEL, CONTEXT with a ten-segment meter, ATTACH, and Send as
  a solid key. While Claude works, Send carries a "queues next" caption.
- Bypass and no ask stripe the whole frame in the danger colour.
- On the phone the rail folds into one Session cell ("Manual · Opus 5.5 High ·
  42%") that opens a sheet with the same labelled controls.
- Breaks: Stop moves out of the bar into the band, a mode click opens a menu
  rather than cycling, and the status row leaves the timeline.

![Instrument panel at rest](composer/shots/2-idle.webp)

![Instrument panel while Claude works](composer/shots/2-working.webp)

### 3. Prompt

**[Open the prototype](composer/3-prompt.html).** It is a terminal lobby, so the
composer is a typeset prompt.

- The field is set in JetBrains Mono behind a ❯. The glyph, the caret and a rail
  down the left edge take the permission mode's colour, and the strip names the
  mode and what it means ("MANUAL asks first"). In bypass the rule turns red and
  the rail becomes hazard striping.
- One tmux-style strip replaces both the chip row and the timeline's status row:
  mode, model and effort, a context meter, the live activity, and "+ attach".
  Each segment opens its picker; mode cycles.
- The prompt line holds key caps only: "⏎ send" always, "^C stop" while Claude
  works. On desktop, live hints sit on the rule above the field ("⏎ queue after
  this turn" while working, "1 allow · 2 deny" when a permission waits).
- Breaks: Send is no longer the last control of the bar's right group, and Send
  and Stop move up beside the field.

![Prompt at rest](composer/shots/3-idle.webp)

![Prompt while Claude works](composer/shots/3-working.webp)

### 4. Floating card

**[Open the prototype](composer/4-floating-card.html).** Polish over novelty: a
composer that floats over the conversation instead of walling it off.

- A card with an 18px radius floats 16px above the pane's edge, and the
  conversation fades out underneath it. The full-width strip and its top border
  go.
- The status line becomes a pill riding the card's top edge, with Stop inside it
  only while Claude works.
- On desktop the bar is three quiet icons (attach, mode, model), a context ring
  with its number inside, and a filled Send; each icon's words appear on hover
  and focus. The phone keeps short labels: Attach, Manual, Opus · High. Bypass
  and no ask keep their word visible everywhere.
- Attachments also get a thumbnail tray above the text.
- Breaks: Attach shows its word only on hover on desktop, and Stop is no longer
  in the bar's right group.

![Floating card at rest](composer/shots/4-idle.webp)

![Floating card while Claude works](composer/shots/4-working.webp)

### 5. Tide

**[Open the prototype](composer/5-tide.html).** Show what the moment needs and
nothing else.

- At rest there is one line: the field and Send. The status row becomes a 2px
  line along the composer's top edge: a slow shimmer while Claude works, a still
  line in the awaiting colour while it waits, nothing when idle.
- While Claude works the line swells into a strip: the tool in plain words
  ("Editing QuestionCard.tsx"), time, steps, and Stop at its end. While it waits,
  the strip reads "Claude asked you something ↑" and has no Stop. Typing
  mid-turn shows a "Will queue" pill.
- Hover on desktop, or focus on the phone, raises a tray of labelled keys: Mode,
  Model, Context with a small gauge, Attach. Bypass and no ask keep a red flag
  and edge even at rest.
- The transitions carry the design; with reduced motion on, nothing moves.
- Breaks: the controls no longer sit on a bar below the field, the field and bar
  stop being one surface, and Attach shows its word only when the tray is up.

![Tide at rest](composer/shots/5-idle.webp)

![Tide while Claude works](composer/shots/5-working.webp)

## With the question card docked

The card keeps today's look in every direction. These show how each composer sits
under it.

![Quiet line, waiting](composer/shots/1-waiting.webp)

![Instrument panel, waiting](composer/shots/2-waiting.webp)

![Prompt, waiting](composer/shots/3-waiting.webp)

![Floating card, waiting](composer/shots/4-waiting.webp)

![Tide, waiting](composer/shots/5-waiting.webp)

## What stays the same, whichever is chosen

The brief fixed the behaviour, so every direction keeps: Enter to send and
Shift+Enter for a newline; history on ↑; Shift+Tab to cycle the mode; 1 and 2 on
an empty field to answer a permission; attachments as inline tokens with a
thumbnail that opens full size; the / and @ completion menu; Send staying
available while Claude works, with a mid-turn send queued; Stop only while Claude
works; a 16px floor on the phone's field so iOS does not zoom.

## Open questions

- **Real devices.** Every phone frame is a 390px region in desktop Chromium.
  Touch, the soft keyboard and iOS focus zoom are unverified until the chosen
  direction is built and checked on the shared Android emulator and with
  `homelab ios`.
- **A mode menu needs a new driver.** Directions 1 and 2 open a list of modes on
  a click instead of cycling. Building that needs the server to press Shift+Tab
  until the pane reports the chosen mode, the way the model picker already drives
  the CLI's own picker.
- **Proposals inside the prototypes.** Some designers added behaviour that is not
  today's, and each would need a decision if its direction is picked: Stop putting
  queued prompts back into the field (2, 4, 5); mode going inert while watching
  (3, 4); ^C in the field stopping the turn when no text is selected (3).
- **Tide on a phone** raises its controls only when the field has focus, so
  changing the model means raising the keyboard first.
- **Pinned tests.** Today's tests pin parts of the current look (Attach shows a
  word, Send is last in the bar's right group, the controls sit on a bar below
  the field). The chosen direction will rewrite some of them on purpose; each
  section above says which.

## Next step

Viktor picks a direction, or a combination. This doc then gains the chosen
design and an implementation plan, and the page moves to approved.

## How they were made

Five designers, one per direction, each blind to the others, worked from one
brief: the four complaints, the behaviour list above, and four constraints. The
constraints were the app's theme tokens and fonts only, accessible controls with
44px touch targets on the phone, motion in CSS, and nothing a Solid component and
a stylesheet could not build. Each prototype has the same eight states, and each
designer screenshotted every state in both themes and read the pictures back
before handing over. Today's baseline was measured on the deployed 0.71.2 at
1280×800 and 390×844.
