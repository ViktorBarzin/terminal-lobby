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
 * images. Escape / backdrop click closes (Escape steps out of Browse first).
 *
 * SECURITY: user HTML is rendered ONLY via <iframe srcdoc> with the empty
 * sandbox (HTML_SANDBOX), giving it a unique opaque origin and no script
 * execution. It must never run against the authed lobby origin.
 */
function fmtBytes(n: number | null): string {
  if (n === null || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const FilePreview: Component<{ store: PreviewStore }> = (props) => {
  const s = props.store;
  const [pathInput, setPathInput] = createSignal("");
  const [imgError, setImgError] = createSignal(false);

  // Reset the image-error latch whenever the previewed path changes.
  createEffect(() => {
    s.path();
    setImgError(false);
  });

  // Keyboard handling (capture + stop so it never leaks to the shell's other
  // handlers). Cmd/Ctrl-S saves while editing (regardless of focus in the
  // overlay); Escape steps out of edit → browse → close, in that order.
  const onKey = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      if (!s.editing()) return; // let the browser keep native Ctrl-S elsewhere
      e.preventDefault();
      e.stopPropagation();
      void s.save();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (s.editing()) s.requestExitEdit();
    else if (s.browsing()) s.closeBrowse();
    else s.close();
  };
  onMount(() => document.addEventListener("keydown", onKey, true));
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

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
      <div class="tl-preview-panel" role="dialog" aria-label="File preview">
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
          <Show when={s.path()}>
            <button
              type="button"
              class="tl-btn"
              onClick={() => void s.browse(dirname(s.path()!))}
            >
              Browse
            </button>
          </Show>
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
                  <button type="button" class="tl-btn" onClick={() => s.browseUp()}>
                    ⬆ Up
                  </button>
                  <span class="tl-preview-browse-dir" title={s.browseDir() ?? ""}>
                    {s.browseDir()}
                  </span>
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
                <CodeEditor
                  initialText={s.text()}
                  language={s.editLanguage()}
                  onChange={(txt) => s.setDraft(txt)}
                  onSave={() => void s.save()}
                />
              </Show>
              <Show when={!s.editing()}>
              <Switch>
                <Match when={s.kind() === "image"}>
                  <Show
                    when={!imgError()}
                    fallback={
                      <div class="tl-preview-note tl-preview-error">
                        Couldn't load image.
                      </div>
                    }
                  >
                    <div class="tl-preview-image">
                      <img
                        src={fileReadUrl(s.path()!)}
                        alt={s.name()}
                        onError={() => setImgError(true)}
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
                      <Markdown text={s.text()} />
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
