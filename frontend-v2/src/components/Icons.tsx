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

/** lucide `eye` — Watch mode: this device observes without driving. */
export const EyeIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

/** lucide `rotate-cw` — reload the app (the lobby header's ↻). */
export const RotateCwIcon: Component<{ size?: number }> = (props) => (
  <Svg size={props.size}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </Svg>
);
