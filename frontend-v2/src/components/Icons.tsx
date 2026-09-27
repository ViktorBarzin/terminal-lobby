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

/** lucide `image` — the session image gallery. */
export const ImageIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </Svg>
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

/** lucide `message-square-text` — the Text view's segment. */
export const MessageTextIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M7 8h10" />
    <path d="M7 12h6" />
  </Svg>
);

/** lucide `square-terminal` — the Terminal view's segment. */
export const TerminalIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="m7 11 2-2-2-2" />
    <path d="M11 13h4" />
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
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

/** The up-and-down chevrons that say a dial opens a list. */
export const ChevronsIcon: Component = () => (
  <Glyph box="0 0 8 10" size={10} width={1.4} class="tl-dial-chev">
    <path d="M2 3.6 4 1.6l2 2M2 6.4l2 2 2-2" />
  </Glyph>
);

/** A dial that cannot act right now. */
export const LockIcon: Component = () => (
  <Glyph box="0 0 12 12" size={10} class="tl-dial-lock">
    <rect x="2.2" y="5.2" width="7.6" height="5.4" rx="1.3" />
    <path d="M4 5.2V3.9a2 2 0 0 1 4 0v1.3" />
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

/** Closes the phone's settings sheet. */
export const CloseIcon: Component = () => (
  <Glyph box="0 0 16 16" size={18} width={1.8}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Glyph>
);
