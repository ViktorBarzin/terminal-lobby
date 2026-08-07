import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import type { PreviewStore } from "../store/preview";
import { HTML_SANDBOX, dirname } from "../store/preview.logic";
import { fileReadUrl } from "../lib/config";
import { IMAGE_DECODE_MESSAGE, imageErrorMessage } from "../lib/file-api";
import { Markdown } from "./Markdown";
import { CodeView } from "./CodeView";
import { CodeEditor } from "./CodeEditor";

/**
 * The file-preview overlay (roadmap pillar #6). A pure view over the preview
 * store: a backdrop + panel with a path box, a transcript-derived recent-files
 * strip, a raw|rendered toggle (markdown/HTML only), and a body that renders the
 * loaded file by kind — rendered markdown (reusing the Markdown+Mermaid stack),
 * a SANDBOXED iframe for HTML (srcdoc + sandbox="" — no scripts, no
 * same-origin), a read-only highlighted CodeView for code/text, and inline
 * images. Escape / backdrop click closes; Escape steps down the stack the user
 * can see — Browse, then the editor, then the overlay.
 *
 * SECURITY: user HTML is rendered ONLY via <iframe srcdoc> with the empty
 * sandbox (HTML_SANDBOX), giving it a unique opaque origin and no script
 * execution. It must never run against the authed lobby origin.
 */
function fmtBytes(n: number | null): string {
  // 0 is a real size — an empty file reads "0 B". Only "no size known" (null,
  // or a nonsense negative) renders nothing; `n <= 0` used to put an EMPTY chip
  // in the header for every empty file.
  if (n === null || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const FilePreview: Component<{ store: PreviewStore }> = (props) => {
  const s = props.store;
  let panelEl: HTMLDivElement | undefined;
  let inputEl: HTMLInputElement | undefined;
  const [pathInput, setPathInput] = createSignal("");
  // null while the image is fine; otherwise the message to show in its place.
  const [imgError, setImgError] = createSignal<string | null>(null);

  // Reset the image-error latch whenever the previewed path changes.
  createEffect(() => {
    s.path();
    setImgError(null);
  });

  // Keep the path box on the file that is actually on screen. Only typing used
  // to write it, so every other way in — a Browse entry, a recent chip, a
  // transcript click — left the PREVIOUS path in the box: two filenames visible
  // at once, and Enter silently re-opened the older one. Nothing here fights
  // the user's typing: s.path() only changes when a file is opened.
  createEffect(() => {
    const p = s.path();
    if (p !== null) setPathInput(p);
  });

  /**
   * An <img> failed. It cannot say why on its own — and readFile skips the
   * fetch for a name-classified image, so nothing else knows either. Show the
   * decode message at once (something is always on screen), then ask the server
   * for the real status and replace it: missing / too large / out of reach read
   * exactly as they do for a text file. Only the error path pays for the probe.
   */
  /** Directory of the previewed document — what a RELATIVE markdown image
   *  reference resolves against. Undefined with nothing loaded. */
  const mdBase = (): string | undefined => {
    const p = s.path();
    return p ? dirname(p) : undefined;
  };

  const onImgError = (): void => {
    const p = s.path();
    setImgError(IMAGE_DECODE_MESSAGE);
    if (!p) return;
    void imageErrorMessage(p).then((message) => {
      if (s.path() === p) setImgError(message); // ignore a superseded file
    });
  };

  /** Tabbable descendants of the panel, in DOM order (disabled ones drop out). */
  const tabbable = (): HTMLElement[] =>
    panelEl
      ? [
          ...panelEl.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
      : [];

  // Keyboard handling (capture + stop so it never leaks to the shell's other
  // handlers). Cmd/Ctrl-S saves while editing (regardless of focus in the
  // overlay); Tab is trapped inside the panel; Escape steps out of
  // browse → edit → close, in that order.
  //
  // That order is the VISIBLE stack, and it has to be: the body switch renders
  // <Match when={s.browsing()}> first and the header hides Edit/Save/View while
  // browsing, so an editor open behind the browse pane is off-screen — and
  // browse() never touches editState, so it stays open there. Asking the
  // editor first meant Escape prompted "Discard unsaved changes?" about a layer
  // the user could not see, threw the draft away on OK, and changed nothing on
  // screen; the loss only showed up on Done.
  const onKey = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      if (!s.editing()) return; // let the browser keep native Ctrl-S elsewhere
      e.preventDefault();
      e.stopPropagation();
      void s.save();
      return;
    }
    // aria-modal="true" tells assistive tech Tab cannot leave this dialog, so
    // it must not: the backdrop is opaque, and Tab used to walk out of it into
    // the composer, the sidebar and the view switch — all invisible. Wrap at
    // both ends instead. CodeMirror's own Tab (indent) is untouched: its
    // contenteditable is not in the tabbable run, so this leaves it alone.
    if (e.key === "Tab" && panelEl) {
      const items = tabbable();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !panelEl.contains(active);
      if (!first || !last) {
        e.preventDefault();
        panelEl.focus();
      } else if (e.shiftKey && (outside || active === first || active === panelEl)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (s.browsing()) s.closeBrowse();
    else if (s.editing()) s.requestExitEdit();
    else s.close();
  };
  onMount(() => document.addEventListener("keydown", onKey, true));
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  // Focus. The panel's own empty state says "Type an absolute file path above",
  // so opening it puts the caret there — blind typing lands in the box instead
  // of in the session composer behind the backdrop. Every close path unmounts
  // the overlay (SessionView renders it under <Show when={preview.isOpen()}>),
  // so returning focus to the opener belongs in onCleanup and covers the ✕, the
  // backdrop and Escape alike. Mirrors SettingsPanel/CommandPalette.
  let opener: HTMLElement | null = null;
  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => (inputEl ?? panelEl)?.focus());
  });
  onCleanup(() => {
    if (opener && opener !== document.body && opener.isConnected) opener.focus();
  });

  const submitPath = (e: SubmitEvent): void => {
    e.preventDefault();
    const p = pathInput().trim();
    if (p) void s.open(p);
  };

  return (
    <div
      class="tl-preview-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) s.close();
      }}
    >
      <div
        ref={panelEl}
        class="tl-preview-panel"
        role="dialog"
        aria-modal="true"
        aria-label="File preview"
        tabindex="-1"
      >
        <div class="tl-preview-head">
          <span class="tl-preview-name" title={s.path() ?? ""}>
            {s.name() || "File preview"}
          </span>
          <Show when={s.status() === "loaded" && s.size() !== null && s.kind() !== "binary"}>
            <span class="tl-preview-size">{fmtBytes(s.size())}</span>
          </Show>
          <span class="tl-preview-head-spacer" />
          {/* raw|rendered toggle (md/html) — hidden while editing raw source. */}
          <Show when={s.modeApplies() && !s.editing()}>
            <div class="tl-preview-toggle" role="group" aria-label="View mode">
              <button
                type="button"
                classList={{ on: s.mode() === "rendered" }}
                aria-pressed={s.mode() === "rendered"}
                onClick={() => s.setMode("rendered")}
              >
                Rendered
              </button>
              <button
                type="button"
                classList={{ on: s.mode() === "raw" }}
                aria-pressed={s.mode() === "raw"}
                onClick={() => s.setMode("raw")}
              >
                Raw
              </button>
            </div>
          </Show>
          {/* Edit ⇄ View toggle + Save — only for editable, loaded files. */}
          <Show when={s.canEdit() && !s.browsing()}>
            <Show
              when={s.editing()}
              fallback={
                <button
                  type="button"
                  class="tl-btn tl-preview-edit"
                  title="Edit this file"
                  onClick={() => s.beginEdit()}
                >
                  Edit
                </button>
              }
            >
              <span
                class="tl-preview-dirty"
                classList={{ on: s.unsaved() }}
                title={s.unsaved() ? "Unsaved changes" : "Saved"}
                aria-hidden="true"
              >
                ●
              </span>
              <button
                type="button"
                class="tl-btn tl-btn-approve tl-preview-save"
                title="Save (Ctrl/Cmd-S)"
                disabled={!s.dirty()}
                onClick={() => void s.save()}
              >
                {s.saving() ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                class="tl-btn tl-preview-view"
                title="Back to preview"
                onClick={() => s.requestExitEdit()}
              >
                View
              </button>
            </Show>
          </Show>
          <button
            class="tl-icon-btn tl-preview-close"
            aria-label="Close preview"
            title="Close"
            onClick={() => s.close()}
          >
            ✕
          </button>
        </div>

        <form class="tl-preview-pathbar" onSubmit={submitPath}>
          <input
            ref={inputEl}
            class="tl-preview-pathinput"
            type="text"
            placeholder="/absolute/path/to/file"
            aria-label="File path"
            value={pathInput()}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            onInput={(e) => setPathInput(e.currentTarget.value)}
          />
          <button type="submit" class="tl-btn">
            Open
          </button>
          {/* Always available: the picker is how you find a path you don't
              already know, so gating it on an already-loaded file locked out
              exactly the sessions that need it (no transcript, no path). The
              store picks the starting directory. */}
          <button type="button" class="tl-btn" onClick={() => void s.browseStart()}>
            Browse
          </button>
        </form>

        <Show when={s.recentFiles().length > 0 && !s.browsing()}>
          <div class="tl-preview-recents">
            <span class="tl-preview-recents-label">Recent</span>
            <For each={s.recentFiles()}>
              {(f) => (
                <button
                  type="button"
                  class="tl-preview-chip"
                  classList={{ on: s.path() === f.path }}
                  title={f.path}
                  onClick={() => void s.open(f.path)}
                >
                  {f.name}
                </button>
              )}
            </For>
          </div>
        </Show>

        <div class="tl-preview-body">
          <Switch>
            {/* ---- directory browse (GET /files/list) --------------------- */}
            <Match when={s.browsing()}>
              <div class="tl-preview-browse">
                <div class="tl-preview-browse-bar">
                  <button
                    type="button"
                    class="tl-btn"
                    disabled={!s.canBrowseUp()}
                    title={
                      s.canBrowseUp() ? "Parent folder" : "Already at the top folder"
                    }
                    onClick={() => void s.browseUp()}
                  >
                    ⬆ Up
                  </button>
                  <span class="tl-preview-browse-dir" title={s.browseDir() ?? ""}>
                    {s.browseDir()}
                  </span>
                  {/* file-api hides dotfiles unless the listing asks for them
                      (&all=1), and nothing in the app ever asked — so the
                      .gitignore / .env / .bashrc that file-api deliberately
                      lets you edit could not be found by browsing. Reuses the
                      app's generic checkbox-row layout. */}
                  <label
                    class="tl-settings-check"
                    title="Show dotfiles (.gitignore, .env, …)"
                  >
                    <input
                      type="checkbox"
                      checked={s.showHidden()}
                      onChange={() => void s.toggleHidden()}
                    />
                    <span>Hidden</span>
                  </label>
                  <button type="button" class="tl-btn" onClick={() => s.closeBrowse()}>
                    Done
                  </button>
                </div>
                <Switch>
                  <Match when={s.browseStatus() === "loading"}>
                    <div class="tl-preview-note">Loading…</div>
                  </Match>
                  <Match when={s.browseStatus() === "error"}>
                    <div class="tl-preview-note tl-preview-error">
                      {s.browseError()}
                    </div>
                  </Match>
                  <Match when={s.browseEntries().length === 0}>
                    <div class="tl-preview-note">Empty directory</div>
                  </Match>
                  <Match when={s.browseEntries().length > 0}>
                    <div class="tl-preview-entries">
                      <For each={s.browseEntries()}>
                        {(entry) => (
                          <button
                            type="button"
                            class="tl-preview-entry"
                            classList={{ dir: entry.isDir }}
                            onClick={() =>
                              entry.isDir
                                ? void s.browse(entry.path)
                                : void s.open(entry.path)
                            }
                          >
                            <span class="tl-preview-entry-icon">
                              {entry.isDir ? "📁" : "📄"}
                            </span>
                            <span class="tl-preview-entry-name">{entry.name}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Match>
                </Switch>
              </div>
            </Match>

            {/* ---- idle: nothing opened yet ------------------------------- */}
            <Match when={s.status() === "idle"}>
              <div class="tl-preview-note">
                {s.recentFiles().length > 0
                  ? "Pick a recent file above, or type an absolute path."
                  : "Type an absolute file path above to preview it."}
              </div>
            </Match>

            <Match when={s.status() === "loading"}>
              <div class="tl-preview-note">Loading…</div>
            </Match>

            <Match when={s.status() === "error"}>
              <div class="tl-preview-note tl-preview-error">{s.error()}</div>
            </Match>

            {/* ---- loaded: render by kind (or the editor) --------------- */}
            <Match when={s.status() === "loaded"}>
              {/* quick-edit mode swaps the read-only body for CodeMirror. */}
              <Show when={s.editing()}>
                {/* Seeded from the DRAFT, not the last saved text: the browse
                    pane replaces this whole body, so CodeMirror is torn down
                    and rebuilt around it. Seeding from s.text() brought the
                    editor back showing the file on disk while the store still
                    held the draft — a dirty dot over the wrong content, one
                    Save away from writing something the user could not see.
                    On a fresh Edit the two are equal (entering seeds
                    draft = text), so nothing else changes. */}
                <CodeEditor
                  initialText={s.draft()}
                  language={s.editLanguage()}
                  onChange={(txt) => s.setDraft(txt)}
                  onSave={() => void s.save()}
                />
              </Show>
              <Show when={!s.editing()}>
              <Switch>
                <Match when={s.kind() === "image"}>
                  <Show
                    when={imgError() === null}
                    fallback={
                      <div class="tl-preview-note tl-preview-error">
                        {imgError()}
                      </div>
                    }
                  >
                    <div class="tl-preview-image">
                      <img
                        src={fileReadUrl(s.path()!)}
                        alt={s.name()}
                        onError={onImgError}
                      />
                    </div>
                  </Show>
                </Match>

                <Match when={s.kind() === "markdown"}>
                  <Show
                    when={s.mode() === "rendered"}
                    fallback={<CodeView code={s.text()} language="markdown" />}
                  >
                    <div class="tl-preview-md">
                      <Markdown text={s.text()} base={mdBase()} />
                    </div>
                  </Show>
                </Match>

                <Match when={s.kind() === "html"}>
                  <Show
                    when={s.mode() === "rendered"}
                    fallback={<CodeView code={s.text()} language="xml" />}
                  >
                    {/* SANDBOXED: srcdoc + empty sandbox — no scripts, no
                        same-origin, opaque origin. Never set `src`. */}
                    <iframe
                      class="tl-preview-iframe"
                      title="HTML preview"
                      sandbox={HTML_SANDBOX}
                      srcdoc={s.text()}
                      referrerpolicy="no-referrer"
                    />
                  </Show>
                </Match>

                <Match when={s.kind() === "code"}>
                  <CodeView code={s.text()} language={s.language()} />
                </Match>

                <Match when={s.kind() === "binary"}>
                  <div class="tl-preview-note">
                    Binary file — preview unavailable
                    <Show when={s.size() !== null}>
                      {" "}
                      ({fmtBytes(s.size())})
                    </Show>
                    .
                  </div>
                </Match>
              </Switch>
              </Show>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
};
