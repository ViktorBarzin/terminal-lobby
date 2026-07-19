import { type Component } from "solid-js";

/**
 * Header notification bell (inventory Cat.9 "Bell icon state paint"). Two glyphs:
 * a plain bell when off, a bell-with-rings when on. Stroke uses `currentColor`,
 * so the `.on` accent color on the button flows through. Lucide-style paths.
 */
export const BellIcon: Component<{ ringing?: boolean; size?: number }> = (
  props,
) => {
  const size = () => props.size ?? 16;
  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      {props.ringing && (
        <>
          <path d="M20.7 4.3a8 8 0 0 1 1.8 3" opacity="0.9" />
          <path d="M3.3 4.3a8 8 0 0 0-1.8 3" opacity="0.9" />
        </>
      )}
    </svg>
  );
};
