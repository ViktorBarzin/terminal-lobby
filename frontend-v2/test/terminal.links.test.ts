import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLinkTracker, openableUrl } from "../src/terminal/links";

/**
 * Which URLs a session may talk this app into opening, and what a tap on one
 * costs.
 *
 * The terminal prints whatever the session prints, so a link is attacker-shaped
 * input in exactly the way a rendered markdown link is. The allowlist is the
 * whole boundary, and `window.open` in this origin is what it is protecting:
 * the origin holds the live terminal socket.
 */
describe("which links may be opened", () => {
  it("opens the ordinary web schemes", () => {
    expect(openableUrl("https://claude.com/download#mobile")).toBe(
      "https://claude.com/download#mobile",
    );
    expect(openableUrl("http://10.0.20.201/admin")).toBe("http://10.0.20.201/admin");
  });

  // A phone can act on both, and neither can execute anything.
  it("opens mailto and tel", () => {
    expect(openableUrl("mailto:me@viktorbarzin.me")).toBe("mailto:me@viktorbarzin.me");
    expect(openableUrl("tel:+35929999999")).toBe("tel:+35929999999");
  });

  it("refuses a scheme that would run code in this origin", () => {
    for (const raw of [
      "javascript:fetch('/x')",
      "JavaScript:alert(1)",
      "  javascript:alert(1)  ",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "blob:https://terminal.viktorbarzin.me/abc",
      "file:///etc/passwd",
    ]) {
      expect(openableUrl(raw), raw).toBeNull();
    }
  });

  // The scheme is read the way the BROWSER reads it, not the way it is spelled:
  // URL normalises case and the control characters browsers strip.
  it("refuses a scheme dressed up to look like something else", () => {
    expect(openableUrl("java\nscript:alert(1)")).toBeNull();
    expect(openableUrl("java\tscript:alert(1)")).toBeNull();
    expect(openableUrl("JAVASCRIPT:alert(1)")).toBeNull();
  });

  it("refuses what is not a URL at all", () => {
    for (const raw of ["", "   ", "not a url", "/tmp/relative", "example.com"]) {
      expect(openableUrl(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

/** A stand-in MouseEvent: only the two methods activate calls. */
function fakeEvent(): MouseEvent & { prevented: boolean; stopped: boolean } {
  const e = {
    prevented: false,
    stopped: false,
    preventDefault() {
      e.prevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
  };
  return e as unknown as MouseEvent & { prevented: boolean; stopped: boolean };
}

describe("following a link", () => {
  it("opens it and spends the gesture", () => {
    const open = vi.fn();
    const t = createLinkTracker({ open });
    const e = fakeEvent();
    t.activate(e, "https://claude.com/download");
    expect(open).toHaveBeenCalledWith("https://claude.com/download");
    expect(e.prevented).toBe(true);
    expect(e.stopped).toBe(true);
  });

  // A refused link still spends the gesture. Falling through would put the
  // keyboard up on a tap the person meant as "follow this", which is the
  // confusing half of the bug this replaces.
  it("says so rather than opening a refused link", () => {
    const open = vi.fn();
    const refused = vi.fn();
    const t = createLinkTracker({ open, refused });
    const e = fakeEvent();
    t.activate(e, "javascript:alert(1)");
    expect(open).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith("javascript:alert(1)");
    expect(e.prevented).toBe(true);
  });

  it("survives having nowhere to report a refusal", () => {
    const open = vi.fn();
    const t = createLinkTracker({ open });
    expect(() => t.activate(fakeEvent(), "javascript:alert(1)")).not.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});

/**
 * The question the touch path asks at the end of a tap. It is the whole reason
 * the tracker holds state rather than being three loose functions.
 */
describe("is the pointer on a link", () => {
  it("starts off a link", () => {
    expect(createLinkTracker({ open: () => {} }).overLink()).toBe(false);
  });

  it("follows hover and leave", () => {
    const t = createLinkTracker({ open: () => {} });
    t.hover();
    expect(t.overLink()).toBe(true);
    t.leave();
    expect(t.overLink()).toBe(false);
  });

  // xterm can call hover for a second link without a leave in between when the
  // pointer crosses straight from one to another.
  it("stays on a link across two hovers", () => {
    const t = createLinkTracker({ open: () => {} });
    t.hover();
    t.hover();
    expect(t.overLink()).toBe(true);
    t.leave();
    expect(t.overLink()).toBe(false);
  });
});

/**
 * The four places the tracker has to be wired, none of which this file can
 * exercise without a real xterm and a real finger.
 *
 * Measured on the shared Android emulator (real Chrome, CDP touch, the keyboard
 * proven down before each tap), against this branch:
 *
 *   tap          keyboard          opened                     dialog
 *   plain cell   783.2 -> 471.2    -                          -
 *   the link     783.2 -> 783.2    https://example.com/probe  -
 *
 * Two of these were each independently enough to keep the keyboard coming up,
 * so a refactor that drops either one silently restores the bug.
 */
describe("the wiring the emulator proved", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/components/TerminalNative.tsx"),
    "utf8",
  );

  // Without this xterm never hears about the link before touchend decides the
  // focus, because the compat mousemove arrives after it.
  it("hands xterm the touch point before the tap is decided", () => {
    // The optional read is part of the claim: a throw in this listener is
    // swallowed and takes the lift's `feedTouch` with it, so the probe may not
    // assume a shape it has not checked.
    expect(src).toMatch(/probeLinkAt\(e\.changedTouches\?\.\[0\]\)/);
    expect(src).toMatch(/new MouseEvent\("mousemove"/);
  });

  it("leaves the compose mirror alone on a link", () => {
    expect(src).toMatch(/if \(links\.overLink\(\)\) return;/);
  });

  // xterm focuses its own hidden textarea from its own mousedown listener, so
  // suppressing our focus was only half of it.
  it("stops xterm focusing its helper textarea on a link", () => {
    expect(src).toMatch(/helperTextarea\.focus = /);
    expect(src).toMatch(/term\.textarea/);
  });

  it("replaces xterm's confirm() fallback with a real handler", () => {
    expect(src).toMatch(/linkHandler:\s*\{/);
    expect(src).toMatch(/activate:.*links\.activate/);
  });
});
