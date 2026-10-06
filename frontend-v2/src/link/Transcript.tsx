/**
 * An ended link's conversation, read-only (ADR-0040): what a visitor sees once
 * the session behind a public link has been killed. The lobby's own timeline
 * draws it, fed a fixed list of events instead of a live stream, with every
 * picture and full tool result read through the link's routes.
 *
 * Loaded on demand by the link page, so a visitor watching a live terminal
 * never downloads the markdown renderer.
 */
import { createResource, Show, type Component } from "solid-js";
import "../app.css";
import { MessagesTimeline } from "../components/MessagesTimeline";
import { useLinkTranscriptRoutes } from "../lib/config";
import type { Event } from "../types/events";
import { transcriptRoutes } from "./link.logic";

interface TranscriptDoc {
  title: string;
  endedAt: number;
  events: Event[];
}

const Transcript: Component<{ link: string; onGone: () => void }> = (props) => {
  const routes = transcriptRoutes(props.link);
  useLinkTranscriptRoutes(routes);

  const [doc] = createResource(async (): Promise<TranscriptDoc | null> => {
    const res = await fetch(routes.transcript, { credentials: "same-origin" });
    if (res.status === 404) {
      props.onGone();
      return null;
    }
    if (!res.ok) throw new Error(`transcript HTTP ${res.status}`);
    return (await res.json()) as TranscriptDoc;
  });

  const loadFull = async (toolId: string): Promise<string | null> => {
    const res = await fetch(routes.result(toolId), { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { body?: unknown } | null;
    return typeof body?.body === "string" ? body.body : null;
  };

  return (
    <div class="tl-visit-transcript">
      <p class="tl-visit-note" role="status">
        This session has ended. Its conversation is shown read-only.
      </p>
      <Show
        when={doc()}
        fallback={
          <p class="tl-visit-note">
            {doc.error ? "The conversation could not be loaded." : "Loading the conversation…"}
          </p>
        }
      >
        {(d) => (
          // `session` is the link id: the timeline draws a picture only when it
          // has a session to name, and on this page every picture URL comes
          // from the link's routes (useLinkTranscriptRoutes), which ignore it.
          <MessagesTimeline events={d().events} onLoadFull={loadFull} session={props.link} me="" />
        )}
      </Show>
    </div>
  );
};

export default Transcript;
