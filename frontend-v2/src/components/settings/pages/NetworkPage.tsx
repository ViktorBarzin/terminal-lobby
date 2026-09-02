import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  readStoredTier,
  readTierPreference,
  writeTierPreference,
  type TierPreference,
} from "../../../diagnostics/connection";
import {
  aggregate,
  commitResetSince,
  formatBytes,
  readStore,
  resetStore,
  type Bucket,
  type PeriodKey,
  type UsageAggregate,
} from "../../../diagnostics/usage";
import {
  currentNetwork,
  networkIsStale,
  onNetworkChange,
  refreshNetwork,
  type NetworkInfo,
} from "../../../diagnostics/network";
import { diagnosticsWanted } from "../../../telemetry/diag";
import { Group, Row, Segmented } from "../controls";
import { RightNow } from "../RightNow";
import type { ConnectionControl } from "../../../diagnostics/status-store";

/** What each bucket is called on screen. Feature names rather than endpoints,
 *  because the breakdown exists to be acted on. */
const BUCKET_LABEL: Record<Bucket, string> = {
  term: "Terminal",
  app: "App code",
  text: "Text view",
  files: "Files & images",
  api: "API",
};

const TIERS = ["auto", "full", "slow"] as const;
const TIER_LABEL: Record<TierPreference, string> = {
  auto: "Auto",
  full: "Full",
  slow: "Light",
};

/**
 * This link: what it is, how it is being treated, and what it has cost.
 *
 * The byte breakdown is unchanged from when it was a group in the old column —
 * the same periods, the same named networks, the same `≈` on the modelled
 * compressed streams. What changed is that it gets a page instead of competing
 * with a theme grid, and that the connection tier is a row above it rather than
 * a fieldset buried inside it: the tier is a setting, and everything below it
 * is a readout.
 */
export const NetworkPage: Component<{ connection?: ConnectionControl }> = (props) => {
  // Which period the breakdown is scoped to, and which network narrows it
  // further. One selection drives the whole section: there is no control fixed
  // to a period nobody picked.
  const [period, setPeriod] = createSignal<PeriodKey>("thisMonth");
  const [net, setNet] = createSignal<string | null>(null);
  // Read once on open rather than tracked live: the counters move on a 60s
  // window, and a panel that reflowed while being read would be worse than one
  // that is a minute stale.
  const [usage, setUsage] = createSignal<UsageAggregate>(
    aggregate(readStore(), new Date(), "thisMonth", null),
  );
  // The network is live, unlike the counters: it is the one thing on this panel
  // a person opens Settings to check after landing somewhere, and it changes
  // under them rather than on their input.
  const [network, setNetwork] = createSignal<NetworkInfo | null>(currentNetwork());
  const [tier, setTier] = createSignal<TierPreference>(readTierPreference());
  // What the link actually measured last time, which is a different question
  // from what the pin asks for — and the only thing on screen that answers
  // "why am I in light mode?". connection.ts persists the verdict, not the
  // sample behind it, so the throughput and round trip are not available here.
  const measured = readStoredTier();
  // Read once, like the counters: Privacy owns this switch and lives on another
  // page, so the two are never on screen together, and leaving this page and
  // coming back re-reads it.
  const diagOn = diagnosticsWanted();

  const refreshUsage = () => setUsage(aggregate(readStore(), new Date(), period(), net()));
  const pickPeriod = (p: PeriodKey) => {
    setPeriod(p);
    // A network selected in one period may carry nothing in another, and a
    // breakdown of nothing reads as a bug. Start each period at all networks.
    setNet(null);
    refreshUsage();
  };
  const pickNet = (id: string) => {
    setNet(net() === id ? null : id); // tapping the selected row clears it
    refreshUsage();
  };
  const widest = () => Math.max(...usage().buckets.map((b) => b.bytes), 0);
  const widestNet = () => Math.max(...usage().networks.map((n) => n.bytes), 0);
  const barWidth = (bytes: number) => (widest() > 0 ? `${(bytes / widest()) * 100}%` : "0%");
  const netBarWidth = (bytes: number) =>
    widestNet() > 0 ? `${(bytes / widestNet()) * 100}%` : "0%";

  /** What the bucket bars are showing, spelled out rather than left implied. */
  const scopeLabel = (): string => {
    const p = usage().periods.find((r) => r.key === usage().period);
    const chosen = usage().networks.find((n) => n.id === usage().net);
    return `${p?.label ?? ""} · ${chosen ? chosen.label : "all networks"}`;
  };

  /** How the current network reads on screen: the operator and, when it is
   *  known, the country — which is what tells someone they are somewhere
   *  else. */
  const networkName = (): string => {
    const n = network();
    if (!n) return "Checking this network…";
    if (n.net === "lan") return "Home network";
    const label = n.label || (n.net.startsWith("as") ? n.net.toUpperCase() : "This network");
    return n.cc ? `${label} (${n.cc})` : label;
  };

  const doResetSince = async (): Promise<void> => {
    await commitResetSince();
    refreshUsage();
  };

  // Landing on this page is a moment worth re-asking the server: it is the one
  // interaction that means "tell me about this connection". It used to fire on
  // any Settings open, which asked on behalf of someone who had come to change
  // their theme.
  onMount(() => {
    void refreshNetwork({ force: true });
    onCleanup(onNetworkChange((info) => setNetwork(info)));
  });

  return (
    <>
      {/* Live health first. Someone opening this page mid-problem is asking
          "is it connected?", and the tier and the byte counters below cannot
          answer that — they describe the link, not whether it is carrying
          anything (ADR-0016). */}
      <Show when={props.connection}>{(conn) => <RightNow conn={conn()} />}</Show>

      <Group title="This connection">
        <Row
          label="Experience"
          deviceOnly
          hint={
            <>
              {measured
                ? `Last measured: ${measured === "slow" ? "light" : "full"}.`
                : "This link is not measured yet."}{" "}
              Light trims what a session opens with. Auto measures this link on
              every load and applies the verdict to the next one.
            </>
          }
        >
          <Segmented
            label="Experience on this device"
            options={TIERS}
            value={tier()}
            format={(v) => TIER_LABEL[v]}
            onChange={(v) => {
              writeTierPreference(v);
              setTier(v);
            }}
          />
        </Row>
        <Row label="Network">
          <span class="tl-netusage-current">
            <span class="tl-netusage-netname">{networkName()}</span>
            <Show when={network() && networkIsStale()}>
              <span class="tl-netusage-stalemark">not confirmed</span>
            </Show>
          </span>
        </Row>
        <div class="tl-set-hint tl-set-hint-static">
          {network()?.source === "lan"
            ? "This device is on the house's own network."
            : "Named from the address your requests arrive from. Traffic counted while that is unconfirmed is listed as Unknown network."}
        </div>
      </Group>

      {/* Data used — wire bytes for THIS browser profile. The terminal runs in
          an iframe with its own socket, so its share arrives by postMessage
          and is folded into the same store this reads. */}
      <Group title="Data used">
        <div class="tl-netusage">
          {/* Periods first, one selectable row each. The selection scopes
              everything below it, so "what did July cost me, where, and on
              what" is one tap and no second control. */}
          <div class="tl-netusage-periods" role="radiogroup" aria-label="Period">
            <For each={usage().periods}>
              {(p) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={usage().period === p.key}
                  class="tl-netusage-period"
                  classList={{ "is-on": usage().period === p.key }}
                  onClick={() => pickPeriod(p.key)}
                >
                  <span class="tl-netusage-name">{p.label}</span>
                  <span class="tl-netusage-bytes">{formatBytes(p.bytes)}</span>
                </button>
              )}
            </For>
            <div class="tl-netusage-sincerow">
              <button type="button" class="tl-set-btn" onClick={() => void doResetSince()}>
                Reset this period
              </button>
            </div>
          </div>

          {/* Where the bytes went. Networks are NAMED, never categorised: the
              server identifies the operator exactly and the reader knows which
              row is their SIM, which no heuristic on an operator's name does. */}
          <div class="tl-set-subhead">Where</div>
          <Show
            when={usage().networks.length > 0}
            fallback={
              <div class="tl-set-hint tl-set-hint-static">
                Nothing counted in this period yet.
              </div>
            }
          >
            <div class="tl-netusage-breakdown">
              <For each={usage().networks}>
                {(n) => (
                  <div
                    class="tl-netusage-row"
                    classList={{
                      "is-on": usage().net === n.id,
                      "is-tappable": n.selectable,
                    }}
                    onClick={() => n.selectable && pickNet(n.id)}
                  >
                    <span class="tl-netusage-name">{n.label}</span>
                    <span class="tl-netusage-bytes">{formatBytes(n.bytes)}</span>
                    <span class="tl-netusage-bar" aria-hidden="true">
                      <span style={{ width: netBarWidth(n.bytes) }} />
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="tl-set-subhead">What</div>
          <div class="tl-netusage-scope">{scopeLabel()}</div>
          <div class="tl-netusage-breakdown">
            <For each={usage().buckets}>
              {(b) => (
                <div class="tl-netusage-row">
                  <span class="tl-netusage-name">{BUCKET_LABEL[b.key]}</span>
                  <span class="tl-netusage-bytes">
                    <Show when={b.modelled}>
                      <span class="tl-netusage-approx" aria-label="estimated">
                        ≈
                      </span>{" "}
                    </Show>
                    {formatBytes(b.bytes)}
                  </span>
                  <span class="tl-netusage-bar" aria-hidden="true">
                    <span style={{ width: barWidth(b.bytes) }} />
                  </span>
                </div>
              )}
            </For>
          </div>

          <div class="tl-set-hint tl-set-hint-static">
            ≈ Compressed streams. The browser cannot measure these directly, so
            they are modelled by compressing the same data the same way.
          </div>

          <div class="tl-set-actions">
            <button
              type="button"
              class="tl-set-btn"
              onClick={() => {
                resetStore();
                refreshUsage();
              }}
            >
              Reset counters
            </button>
          </div>
          <div class="tl-set-hint tl-set-hint-static">
            {diagOn
              ? "Counted on this device. Bytes that crossed the link, after compression."
              : "Counted on this device only. Nothing is sent while diagnostics are off."}
          </div>
        </div>
      </Group>
    </>
  );
};
