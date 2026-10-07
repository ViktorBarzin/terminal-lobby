/**
 * A shared session's conversation, read-only (ADR-0040, ADR-0041): what a
 * public link shows. The lobby's own timeline draws it, fed the events the
 * link's routes serve, with every picture and full tool result read through
 * those routes too. While the session runs it re-reads every few seconds and
 * appends what is new; once the session ends it stops.
 */
import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import "../app.css";
import { MessagesTimeline } from "../components/MessagesTimeline";
import { useLinkTranscriptRoutes } from "../lib/config";
import type { Event } from "../types/events";
import { mergeEvents, POLL_MS, transcriptRoutes } from "./link.logic";

interface TranscriptAnswer {
  title: string;
  live: boolean;
  last: number;
  events: Event[];
}

const Transcript: Component<{
  link: string;
  /** The link was revoked or expired while the page was open. */
  onGone: () => void;
  /** The session is running (true) or has ended (false). */
  onLive: (live: boolean) => void;
  onTitle: (title: string) => void;
}> = (props) => {
  const routes = transcriptRoutes(props.link);
  useLinkTranscriptRoutes(routes);

  const [events, setEvents] = createSignal<Event[] | null>(null);
  const [failed, setFailed] = createSignal(false);
  let after = 0;
  let timer = 0;
  let stopped = false;

  const read = async (): Promise<void> => {
    try {
      const res = await fetch(routes.transcript(after), { credentials: "same-origin" });
      if (res.status === 404) {
        stopped = true;
        props.onGone();
        return;
      }
      if (!res.ok) throw new Error(`transcript HTTP ${res.status}`);
      const a = (await res.json()) as TranscriptAnswer;
      setEvents((held) => mergeEvents(held ?? [], a.events, after));
      after = a.last;
      setFailed(false);
      props.onTitle(a.title);
      props.onLive(a.live);
      if (!a.live) stopped = true;
    } catch {
      // A network blip on a phone: keep what is drawn and try again.
      if (events() === null) setFailed(true);
    }
    if (!stopped) timer = window.setTimeout(() => void read(), POLL_MS);
  };
  onMount(() => void read());
  onCleanup(() => {
    stopped = true;
    window.clearTimeout(timer);
  });

  const loadFull = async (toolId: string): Promise<string | null> => {
    const res = await fetch(routes.result(toolId), { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { body?: unknown } | null;
    return typeof body?.body === "string" ? body.body : null;
  };

  return (
    <div class="tl-visit-transcript">
      <Show
        when={events()}
        fallback={
          <p class="tl-visit-note">
            {failed()
              ? "The conversation could not be loaded. Retrying…"
              : "Loading the conversation…"}
          </p>
        }
      >
        {(ev) => (
          // `session` is the link id: the timeline draws a picture only when it
          // has a session to name, and on this page every picture URL comes
          // from the link's routes (useLinkTranscriptRoutes), which ignore it.
          <MessagesTimeline events={ev()} onLoadFull={loadFull} session={props.link} me="" />
        )}
      </Show>
    </div>
  );
};

export default Transcript;
