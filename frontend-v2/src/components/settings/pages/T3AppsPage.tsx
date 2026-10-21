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
import { generate } from "lean-qr/nano";
import {
  listDevices,
  pairDevice,
  revokeDevice,
  type DeviceView,
  type PairCode,
} from "../../../lib/devices-api";
import {
  countdown,
  deviceKind,
  groupCode,
  lastUsedLabel,
  pairLink,
  pairStep,
  qrPath,
  secondsLeft,
  type PairEvent,
  type PairState,
} from "../../../t3/pairing.logic";
import { copyText } from "../../copy-text";
import { Group } from "../controls";

/** tmux-api's device routes, as the page uses them. Tests pass their own. */
export interface DevicesApi {
  pair: () => Promise<PairCode>;
  list: () => Promise<DeviceView[]>;
  revoke: (id: string) => Promise<void>;
}

const realApi: DevicesApi = { pair: pairDevice, list: listDevices, revoke: revokeDevice };

/** The modules of quiet zone a scanner wants around a QR code. */
const QR_PAD = 4;

const dateOf = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** The pairing link as a QR code, dark on light whatever the theme, since
 *  that is what a phone's camera reads best. */
const PairQr: Component<{ link: string }> = (props) => {
  const drawn = () => {
    const bitmap = generate(props.link);
    return { side: bitmap.size + 2 * QR_PAD, d: qrPath(bitmap, QR_PAD) };
  };
  return (
    <svg
      class="tl-t3-qr"
      viewBox={`0 0 ${drawn().side} ${drawn().side}`}
      role="img"
      aria-label="QR code of the pairing link"
      shape-rendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="#fff" />
      <path d={drawn().d} fill="#000" />
    </svg>
  );
};

/**
 * Settings → T3 apps (ADR-0045, design decision 8): pair T3's web, desktop or
 * phone app with this lobby account, and revoke the ones already paired.
 *
 * "Pair a device" asks tmux-api for a code good for five minutes and one use,
 * shown as a link, a QR code of the link, and the code itself. When it lapses
 * the card offers a new one. `origin` is where T3's apps connect
 * (`defaultT3Origin`); null on a dev server, which shows the code alone.
 *
 * App leaves the page out of a lens tab: tmux-api refuses to pair or revoke
 * under act-as.
 */
export const T3AppsPage: Component<{
  origin: string | null;
  api?: DevicesApi;
  /** confirm seam for Revoke (tests inject). */
  confirm?: (message: string) => boolean;
}> = (props) => {
  const api = props.api ?? realApi;
  const confirm = props.confirm ?? ((message: string) => window.confirm(message));

  const [pair, setPair] = createSignal<PairState>({ kind: "idle" });
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [copied, setCopied] = createSignal("");
  const step = (event: PairEvent): void => {
    setPair((state) => pairStep(state, event));
  };

  const requestCode = async (): Promise<void> => {
    if (pair().kind === "requesting") return;
    step({ type: "request" });
    setCopied("");
    try {
      const { code, expiresAt } = await api.pair();
      setNowMs(Date.now());
      step({ type: "granted", code, expiresAt });
    } catch (e) {
      step({ type: "failed", message: (e as Error).message });
    }
  };

  // The countdown ticks only while a code is showing.
  createEffect(() => {
    if (pair().kind !== "showing") return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      step({ type: "tick", nowMs: now });
    }, 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  const showing = () => {
    const state = pair();
    return state.kind === "showing" ? state : null;
  };
  const link = () => {
    const state = showing();
    return state && props.origin ? pairLink(props.origin, state.code) : null;
  };

  const pairError = () => {
    const state = pair();
    return state.kind === "error" ? state.message : "";
  };

  let linkEl: HTMLInputElement | undefined;
  const copy = async (): Promise<void> => {
    const url = link();
    if (!url) return;
    setCopied((await copyText(url, linkEl)) ? "Copied" : "Selected. Press Ctrl+C to copy");
  };

  const [devices, setDevices] = createSignal<DeviceView[] | null>(null);
  const [listError, setListError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const reload = async (): Promise<void> => {
    try {
      setDevices(await api.list());
      setListError("");
    } catch (e) {
      setListError((e as Error).message);
    }
  };
  onMount(() => void reload());

  const revoke = async (device: DeviceView): Promise<void> => {
    const name = device.label || "this app";
    if (!confirm(`Revoke ${name}? It disconnects now and has to be paired again.`)) return;
    setStatus("");
    try {
      await api.revoke(device.id);
    } catch (e) {
      setStatus(`Could not revoke: ${(e as Error).message}`);
    }
    await reload();
  };

  return (
    <>
      <Group title="Pair a device">
        <div class="tl-set-note">
          Open T3 (web, desktop or phone), go to Settings → Connections → Add environment, and paste
          the link or scan the QR code. Each code works once, for five minutes.
        </div>
        <Switch>
          <Match when={showing()}>
            {(code) => (
              <div class="tl-t3-pair">
                <Show
                  when={link()}
                  fallback={
                    <div class="tl-set-hint tl-set-hint-static">
                      This lobby has no T3 address (a dev server without a domain), so there is no
                      link. Type the code into T3 instead.
                    </div>
                  }
                >
                  {(url) => (
                    <>
                      <PairQr link={url()} />
                      <div class="tl-share-url">
                        <input
                          ref={linkEl}
                          class="tl-share-url-field"
                          type="text"
                          readOnly
                          value={url()}
                          aria-label="Pairing link"
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <button
                          type="button"
                          class="tl-set-btn tl-set-btn-go"
                          onClick={() => void copy()}
                        >
                          Copy
                        </button>
                      </div>
                    </>
                  )}
                </Show>
                <div class="tl-t3-code-line">
                  <span class="tl-t3-code-label">Code</span>
                  <code class="tl-t3-code">{groupCode(code().code)}</code>
                  <span class="tl-t3-countdown" aria-live="off">
                    expires in {countdown(secondsLeft(code().expiresAt, nowMs()))}
                  </span>
                </div>
                <Show when={copied()}>
                  <div class="tl-set-note">{copied()}.</div>
                </Show>
              </div>
            )}
          </Match>
          <Match when={pair().kind === "expired"}>
            <div class="tl-t3-pair-row">
              <span class="tl-set-hint tl-set-hint-static">That code has expired.</span>
              <button
                type="button"
                class="tl-set-btn tl-set-btn-go"
                onClick={() => void requestCode()}
              >
                New code
              </button>
            </div>
          </Match>
          <Match when={true}>
            <div class="tl-t3-pair-row">
              <button
                type="button"
                class="tl-set-btn tl-set-btn-go"
                disabled={pair().kind === "requesting"}
                onClick={() => void requestCode()}
              >
                Pair a device
              </button>
              <Show when={pairError()}>
                <span class="tl-set-hint tl-set-hint-static" role="alert">
                  {pairError()}
                </span>
              </Show>
            </div>
          </Match>
        </Switch>
      </Group>

      <Group title="Paired apps">
        <Show
          when={devices() !== null}
          fallback={<div class="tl-set-hint tl-set-hint-static">{listError() || "Loading…"}</div>}
        >
          <Show
            when={(devices() ?? []).length > 0}
            fallback={<div class="tl-set-hint tl-set-hint-static">No T3 apps paired yet.</div>}
          >
            <For each={devices() ?? []}>
              {(device) => (
                <div class="tl-link-row tl-t3-device">
                  <div class="tl-link-meta">
                    <div class="tl-link-line">
                      <span class="tl-link-session">{device.label || "T3 app"}</span>
                      <Show when={deviceKind(device)}>
                        <span class="tl-link-expiry">{deviceKind(device)}</span>
                      </Show>
                    </div>
                    <div class="tl-link-note">
                      paired {dateOf(device.created)}, {lastUsedLabel(device.lastSeen, dateOf)}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="tl-set-btn tl-set-btn-danger"
                    aria-label={`Revoke ${device.label || "T3 app"}`}
                    onClick={() => void revoke(device)}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </For>
          </Show>
          <Show when={listError()}>
            <div class="tl-set-hint tl-set-hint-static">{listError()}</div>
          </Show>
        </Show>
        <Show when={status()}>
          <div class="tl-set-hint tl-set-hint-static">{status()}</div>
        </Show>
      </Group>
    </>
  );
};
