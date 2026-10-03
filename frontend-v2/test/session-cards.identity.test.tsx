/**
 * A sidebar card keeps its DOM node when its session is renamed.
 *
 * A session is renamed seconds after it is created, when its first title lands
 * (ADR-0022), and its optimistic card is replaced by the server's row on the
 * first poll that lists it. Keyed by object, both read as a new session and
 * the card was rebuilt. Keyed by birth name, the same node relabels.
 *
 * Asserted against a real render, because "the array looks right" and "the
 * DOM node survived" are different claims and only the second is the feature.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SessionsByIdentity } from "../src/components/SessionsByIdentity";
import { noteBirthNames } from "../src/store/keepalive";
import type { Session } from "../src/types/lobby";

const row = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

describe("cards keyed by birth name", () => {
  beforeEach(() => noteBirthNames([], "wizard"));

  it("keeps the node from the optimistic card through the rename", () => {
    const id = "bw8k5gt9v314";
    const [list, setList] = createSignal<Session[]>([row(id, { title: "Fix the deploy", bornAs: id })]);
    const { container } = render(() => (
      <SessionsByIdentity each={list()} me="wizard">
        {(s) => <div class="card">{s().title}</div>}
      </SessionsByIdentity>
    ));
    const before = container.querySelector(".card");

    // The first poll lists it under the id; a later one under its new name.
    noteBirthNames([row(id, { bornAs: id })], "wizard");
    setList([row(id, { title: "Fix the deploy", bornAs: id })]);
    noteBirthNames([row("fix-the-deploy", { bornAs: id })], "wizard");
    setList([row("fix-the-deploy", { title: "Fix the deploy pipeline", bornAs: id })]);

    const after = container.querySelector(".card");
    expect(after).toBe(before);
    expect(after?.textContent).toBe("Fix the deploy pipeline");
  });

  it("builds a new card for a different session", () => {
    const [list, setList] = createSignal<Session[]>([row("alpha")]);
    const { container } = render(() => (
      <SessionsByIdentity each={list()} me="wizard">
        {(s) => <div class="card">{s().name}</div>}
      </SessionsByIdentity>
    ));
    const before = container.querySelector(".card");
    setList([row("beta")]);
    expect(container.querySelector(".card")).not.toBe(before);
  });
});
