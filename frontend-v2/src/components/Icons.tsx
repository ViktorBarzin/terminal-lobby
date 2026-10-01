import { type Component, type JSX } from "solid-js";

/**
 * Chrome icons, as inline Lucide-style SVG.
 *
 * The vanilla page moved off emoji deliberately: 🖼 📷 📋 are emoji-default
 * codepoints, so they rendered in full colour beside monochrome glyphs and at a
 * different size on every OS. It replaced them with a Lucide set stroked in
 * `currentColor`, which inherits the button's colour and its hover and active
 * states. The v2 rewrite carried the emoji across instead; these bring the icons
 * back, using the same Lucide glyphs the vanilla page names in its `data-icon`
 * attributes (image / camera / clipboard / file-text) so the two tiers match.
 *
 * `currentColor` is the whole point — never hard-code a fill here.
 */

const Svg: Component<{ size?: number; children: JSX.Element }> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {props.children}
  </svg>
);

/** lucide `camera` — upload an image into the session. */
export const CameraIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </Svg>
);

/** lucide `clipboard` — paste the clipboard into the terminal. */
export const ClipboardIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </Svg>
);

/** lucide `copy` — copy the terminal selection (the mobile key row's Copy). */
export const CopyIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Svg>
);

/** lucide `file-text` — the file preview overlay. */
export const FileTextIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </Svg>
);

/** lucide `paperclip` — attach a file to the message being composed. */
export const PaperclipIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="M13.234 20.252 21 12.3a2.83 2.83 0 0 0 0-4 2.83 2.83 0 0 0-4 0l-8.586 8.586a4 4 0 1 0 5.656 5.656l.09-.09" />
  </Svg>
);

/** lucide `eye` — Watch mode: this device observes without driving. */
export const EyeIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

/** Skills: modular pieces with room for another. Hand-drawn in the same stroked
 *  24-box as the Lucide set rather than borrowed from it, so nothing here claims
 *  to be a glyph it is not. Replaces a ⌘ that read as the Mac command key on
 *  iOS. */
export const SkillsIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 17.5h7" />
    <path d="M17.5 14v7" />
  </Svg>
);

/* ---- The Quiet line composer's glyphs (2026-09-24) -----------------------
   Drawn from the prototype's own paths (docs/plans/2026-09-24-text-composer-
   redesign.md, direction 1) on the small boxes the prototype drew them in, so
   a 12px chevron and a 16px arrow keep the stroke weights they were designed
   at rather than being scaled out of a 24px box. Same rule as the set above:
   every stroke and fill is `currentColor`. */

const Glyph: Component<{
  box: string;
  size?: number;
  width?: number;
  class?: string;
  children: JSX.Element;
}> = (props) => (
  <svg
    class={props.class}
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox={props.box}
    fill="none"
    stroke="currentColor"
    stroke-width={props.width ?? 1.6}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {props.children}
  </svg>
);

/** The pill's `+`: what can be added to the message. It turns to a × while
 *  its tray is open, by rotation in CSS rather than by a second glyph. */
export const PlusIcon: Component<{ size?: number }> = (props) => (
  <Glyph box="0 0 16 16" size={props.size} width={1.8}>
    <path d="M8 3v10M3 8h10" />
  </Glyph>
);

/** Send, as an arrow: the button keeps its name in `aria-label`. */
export const SendArrowIcon: Component<{ size?: number }> = (props) => (
  <Glyph box="0 0 16 16" size={props.size} width={2}>
    <path d="M8 13.2V3.2M3.6 7.4 8 3l4.4 4.4" />
  </Glyph>
);

/** Stop's filled square. */
export const StopSquareIcon: Component<{ size?: number }> = (props) => (
  <svg width={props.size ?? 8} height={props.size ?? 8} viewBox="0 0 10 10" aria-hidden="true">
    <rect x="1" y="1" width="8" height="8" rx="1.6" fill="currentColor" />
  </svg>
);

/** A mode that asks before something: the shield. */
export const ShieldIcon: Component<{ size?: number; class?: string }> = (props) => (
  <Glyph box="0 0 16 16" size={props.size ?? 12} width={1.7} class={props.class}>
    <path d="M8 1.9 3.2 3.7v3.9c0 3 2 5.3 4.8 6.5 2.8-1.2 4.8-3.5 4.8-6.5V3.7L8 1.9Z" />
  </Glyph>
);

/**
 * Claude's sparkle, on the model button and each row of the model sheet. The
 * one filled glyph here: it is a mark rather than a line drawing, coloured by
 * the theme's `--sparkle`.
 */
export const SparkleIcon: Component<{ size?: number; class?: string }> = (props) => (
  <svg
    class={props.class}
    width={props.size ?? 15}
    height={props.size ?? 15}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8 .8l.9 5.2 3.9-3.6-2.4 4.7 5.2.9-5.2.9 2.4 4.7-3.9-3.6L8 15.2 7.1 10l-3.9 3.6L5.6 9 .4 8l5.2-.9L3.2 2.4 7.1 6z" />
  </svg>
);

/** The single chevron that says the model button opens a sheet. */
export const ChevronDownIcon: Component<{ class?: string }> = (props) => (
  <Glyph box="0 0 12 12" size={11} class={props.class}>
    <path d="m2.8 4.6 3.2 3.2 3.2-3.2" />
  </Glyph>
);

/** A lightbox's arrows, to the previous and the next picture. */
export const ChevronLeftIcon: Component = () => (
  <Glyph box="0 0 16 16" size={20} width={1.8}>
    <path d="m10 3.5-4.5 4.5 4.5 4.5" />
  </Glyph>
);
export const ChevronRightIcon: Component = () => (
  <Glyph box="0 0 16 16" size={20} width={1.8}>
    <path d="m6 3.5 4.5 4.5-4.5 4.5" />
  </Glyph>
);

/** The new-session strip's project button (prototype 6-t3's `folder`). */
export const FolderGlyph: Component = () => (
  <Glyph box="0 0 16 16" size={14}>
    <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
  </Glyph>
);

/** The new-session strip's command button (prototype 6-t3's `prompt`). */
export const PromptGlyph: Component = () => (
  <Glyph box="0 0 16 16" size={14}>
    <path d="m3 4.5 3.2 3.5L3 11.5M8 12h5" />
  </Glyph>
);

/** The + menu's "Photo library" row (prototype 6-t3's `photo`). */
export const PhotoGlyph: Component = () => (
  <Glyph box="0 0 16 16">
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
    <circle cx="5.7" cy="6.3" r="1.2" />
    <path d="m2.4 12 3.8-3.6 2.6 2.4 2.1-1.8 3 2.6" />
  </Glyph>
);

/** The + menu's "Camera" row. */
export const CameraGlyph: Component = () => (
  <Glyph box="0 0 16 16">
    <path d="M2 5.4c0-.8.6-1.4 1.4-1.4h1.8l1.1-1.6h3.4L10.8 4h1.8c.8 0 1.4.6 1.4 1.4v6.4c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4z" />
    <circle cx="8" cy="8.4" r="2.4" />
  </Glyph>
);

/** The + menu's "File" row. */
export const FileGlyph: Component = () => (
  <Glyph box="0 0 16 16">
    <path d="M9 1.8H4.6a1.4 1.4 0 0 0-1.4 1.4v9.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V5.6L9 1.8Z" />
    <path d="M9 1.8v3.8h3.8" />
  </Glyph>
);

/** The + menu's "Commands" row. */
export const SlashBoxIcon: Component = () => (
  <Glyph box="0 0 16 16">
    <rect x="1.8" y="1.8" width="12.4" height="12.4" rx="3" />
    <path d="M9.8 4.6 6.2 11.4" />
  </Glyph>
);

/** The tick on the row a list is set to. */
export const CheckIcon: Component = () => (
  <Glyph box="0 0 14 14" size={14} width={1.9}>
    <path d="m2.8 7.4 2.8 2.8 5.6-6" />
  </Glyph>
);

/** The pen on a card's "Type your own answer" row (prototype 6-question). */
export const PenIcon: Component = () => (
  <Glyph box="0 0 16 16" size={12} width={1.6}>
    <path d="M10.8 2.6 13.4 5.2 6 12.6l-3.2.6.6-3.2z" />
  </Glyph>
);

/** The header's round back button (prototype 6-t3's `back`). */
export const BackGlyph: Component = () => (
  <Glyph box="0 0 20 20" size={20} width={2}>
    <path d="M12.5 4 6.5 10l6 6" />
  </Glyph>
);

/** The header's Terminal icon: a window with a prompt (prototype `term`). */
export const TerminalGlyph: Component = () => (
  <Glyph box="0 0 20 20" size={20}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.4" />
    <path d="m6 8 2.4 2L6 12M10.5 12.5h3.5" />
  </Glyph>
);

/** The header's Text icon, drawn to sit beside the Terminal one: a speech
 *  bubble with two lines of text, in the same 20-box and stroke. */
export const TextGlyph: Component = () => (
  <Glyph box="0 0 20 20" size={20}>
    <path d="M4.9 3.5h10.2a2.4 2.4 0 0 1 2.4 2.4v6.2a2.4 2.4 0 0 1-2.4 2.4H9l-3.6 2.6v-2.6h-.5a2.4 2.4 0 0 1-2.4-2.4V5.9a2.4 2.4 0 0 1 2.4-2.4Z" />
    <path d="M6.5 7.6h7M6.5 10.4h4.4" />
  </Glyph>
);

/** The header's "…" (prototype `dots`). Filled, so it reads at 20px. */
export const DotsGlyph: Component = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <circle cx="4.5" cy="10" r="1.3" />
    <circle cx="10" cy="10" r="1.3" />
    <circle cx="15.5" cy="10" r="1.3" />
  </svg>
);

/** The session browser: a window with a toolbar and two dots, in the header's
 *  20-box and stroke. On the session bar, the Browser card and the panel. */
export const BrowserGlyph: Component<{ size?: number }> = (props) => (
  <Glyph box="0 0 20 20" size={props.size ?? 20}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.4" />
    <path d="M2.5 7.5h15M5.2 5.5h.01M7.4 5.5h.01" />
  </Glyph>
);

/** The panel's back, forward and reload, in the 16-box the chevrons use. */
export const ArrowLeftGlyph: Component = () => (
  <Glyph box="0 0 16 16" size={16}>
    <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />
  </Glyph>
);
export const ArrowRightGlyph: Component = () => (
  <Glyph box="0 0 16 16" size={16}>
    <path d="M3 8h9.5M8.5 4l4 4-4 4" />
  </Glyph>
);
export const ReloadGlyph: Component = () => (
  <Glyph box="0 0 16 16" size={16}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
  </Glyph>
);
