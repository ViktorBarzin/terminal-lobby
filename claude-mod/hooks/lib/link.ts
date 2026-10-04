// The connection to session-events: hello, one events POST in flight at a
// time, and the command long-poll. Everything outside is injected, so the
// logic runs the same under `node --test` and inside Claude Code.

import { EventQueue } from './queue.ts';
import { backoffMs, historyEvents } from './shape.ts';
import type { DialogEvent, HelloBody, LevelEvent, ModEvent, ModEventType } from './wire.ts';

export type Reply = { status: number; body: unknown };

export type LinkDeps = {
  post: (path: string, body: unknown) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
  now: () => number;
  after: (ms: number, fn: () => void) => void;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  // Whether the server answering on the port is the real one (lib/listener.ts),
  // asked before every hello. False waits and asks again, like a failed hello.
  trusted?: () => Promise<boolean>;
  // The hello body; the link adds how many events its queue has dropped.
  hello: () => Promise<Omit<HelloBody, 'dropped'>>;
  // The `history` event's fields: `messages`, and `running` (a main-thread turn in flight).
  history: () => Promise<{ messages: unknown; running: boolean }>;
  // The dialogs still on screen. Each went out once, when it opened; a
  // server that restarted since has forgotten it, so every hello sends them
  // again, behind the history.
  open?: () => DialogEvent[];
  // The mod's whole view now, sent last after every hello so the server
  // writes every option from it rather than from what it remembers.
  level?: () => Promise<LevelEvent>;
  onCommand: (command: unknown) => void;
};

// What survives a hello that answers history: true. Everything else queued is
// in the snapshot that follows (wire contract v3, item 5); replaying it behind
// the snapshot showed the conversation's tail twice and replayed stale turns.
const KEPT_BY_SNAPSHOT: ReadonlySet<ModEventType> = new Set(['ack', 'summary', 'command_failed']);

export const FLUSH_GAP_MS = 50;

export class Link {
  #deps: LinkDeps;
  #queue = new EventQueue();
  #token: string | null = null;
  #started = false;
  #stopped = false;
  #timer = false;
  #busy = false;
  #lastFlush = -Infinity;
  #helloFails = 0;
  // Bumped by every rehello, so a hello that was already in flight when one
  // was asked for knows it answered the wrong question (see #hello).
  #helloAsks = 0;
  #sendFails = 0;
  #retryAt = 0;
  #tokenWaiters: (() => void)[] = [];
  #idleWaiters: (() => void)[] = [];

  constructor(deps: LinkDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule(0);
    void this.#pollLoop();
  }

  stop(): void {
    this.#stopped = true;
    this.#wakeToken();
    this.#wakeIdle();
  }

  send(ev: ModEvent): void {
    if (this.#stopped) return;
    this.#queue.push(ev);
    if (this.#started) this.#schedule(this.#gap());
  }

  // The conversation ended (/clear, resume): what a snapshot keeps (acks, the
  // summary, command failures) belongs to it and not to the next one, whose
  // hello asks for a snapshot that drops everything else.
  forgetConversation(): void {
    this.#queue.dropTypes(KEPT_BY_SNAPSHOT);
  }

  // Forget the token and say hello again, e.g. after the tmux session was
  // renamed or the conversation was cleared.
  rehello(): void {
    this.#helloAsks++;
    this.#token = null;
    if (this.#started) this.#schedule(0);
  }

  // Resolves once everything queued has been posted, or after `ms`.
  drain(ms: number): Promise<void> {
    if (this.#idle()) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      this.#idleWaiters.push(finish);
      this.#deps.after(ms, finish);
    });
  }

  #idle(): boolean {
    return this.#queue.size === 0 && !this.#busy;
  }

  #gap(): number {
    return Math.max(0, this.#lastFlush + FLUSH_GAP_MS - this.#deps.now(), this.#retryAt - this.#deps.now());
  }

  #schedule(ms: number): void {
    if (this.#timer || this.#busy || this.#stopped) return;
    this.#timer = true;
    try {
      this.#deps.after(ms, () => {
        this.#timer = false;
        void this.#pump();
      });
    } catch {
      // No timers any more: the module was unloaded.
      this.#timer = false;
      this.stop();
    }
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    this.#busy = true;
    try {
      if (this.#token === null) await this.#hello();
      else if (this.#queue.size > 0) await this.#flush(this.#token);
    } catch {
      // #hello and #flush catch their own failures; nothing may escape a timer.
    } finally {
      this.#busy = false;
    }
    if (this.#stopped) return;
    if (this.#token === null || this.#queue.size > 0) this.#schedule(this.#gap());
    else this.#wakeIdle();
  }

  async #hello(): Promise<void> {
    const asked = this.#helloAsks;
    let reply: Reply | null = null;
    try {
      if (this.#deps.trusted && !(await this.#deps.trusted())) throw new Error('untrusted listener');
      const body: HelloBody = { ...(await this.#deps.hello()), dropped: this.#queue.dropped };
      reply = await this.#deps.post('/mod/v1/hello', body);
    } catch {
      reply = null;
    }
    const body = reply?.body as { token?: unknown; history?: unknown } | null | undefined;
    if (!reply || reply.status !== 200 || typeof body?.token !== 'string') {
      this.#retryAt = this.#deps.now() + backoffMs(this.#helloFails++, this.#deps.random);
      return;
    }
    // A rehello asked for while this one was in flight: the body went out
    // with what was true before it (the old session name, no transcript yet),
    // so the token is dropped and #pump says hello again. Keeping it lost the
    // second hello, and with it the transcript stamp, for 3 of 8 conversations
    // created together on 2026-10-02. Asked again below, after the snapshot is
    // read: the first row lands, or the session is renamed, during that read too.
    if (this.#helloAsks !== asked) return;
    const resent: ModEvent[] = [];
    // What is queued now is in the snapshot about to be read, and goes once it
    // has been; anything queued while it is read follows it.
    const covered = body.history === true ? this.#queue.snapshot() : null;
    if (covered) {
      try {
        const h = await this.#deps.history();
        resent.push(...historyEvents(this.#deps.now(), h.messages, h.running));
      } catch {
        // The server asks for a history only in a hello's reply, so a read
        // that failed is a failed hello: say it again later, queue untouched.
        this.#retryAt = this.#deps.now() + backoffMs(this.#helloFails++, this.#deps.random);
        return;
      }
    }
    // Read after the history, so a dialog answered meanwhile is not resent.
    try {
      resent.push(...(this.#deps.open?.() ?? []));
    } catch {
      // Nothing to resend; the dialogs stay with Claude's own menus.
    }
    try {
      if (this.#deps.level) resent.push(await this.#deps.level());
    } catch {
      // The next level, at most 30 s away, says it instead.
    }
    if (this.#helloAsks !== asked) return;
    this.#helloFails = 0;
    this.#retryAt = 0;
    if (covered) this.#queue.drop(covered, KEPT_BY_SNAPSHOT);
    if (resent.length > 0) this.#queue.prepend(...resent);
    this.#token = body.token;
    this.#wakeToken();
  }

  async #flush(token: string): Promise<void> {
    const batch = this.#queue.take();
    this.#lastFlush = this.#deps.now();
    let status = 0;
    try {
      status = (await this.#deps.post('/mod/v1/events', { token, events: batch })).status;
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      this.#sendFails = 0;
      this.#retryAt = 0;
      return;
    }
    this.#queue.requeue(batch);
    if (status === 409) {
      if (this.#token === token) this.#token = null;
      return;
    }
    this.#retryAt = this.#deps.now() + backoffMs(this.#sendFails++, this.#deps.random);
  }

  async #pollLoop(): Promise<void> {
    let fails = 0;
    let shortWaits = 0;
    while (!this.#stopped) {
      const token = this.#token;
      if (token === null) {
        await new Promise<void>((resolve) => this.#tokenWaiters.push(resolve));
        continue;
      }
      let reply: Reply | null = null;
      try {
        reply = await this.#deps.get(`/mod/v1/poll?token=${encodeURIComponent(token)}`);
      } catch {
        reply = null;
      }
      if (this.#stopped) return;
      if (reply?.status === 200) {
        fails = 0;
        const commands = (reply.body as { commands?: unknown } | null)?.commands;
        if (Array.isArray(commands)) for (const c of commands) this.#deps.onCommand(c);
        continue;
      }
      if (reply?.status === 204) {
        fails = 0;
        continue;
      }
      if (reply?.status === 409) {
        if (this.#token === token) this.rehello();
        continue;
      }
      // After a reload the old module's fetches and timers fail at once. A
      // loop that kept going would spin without yielding and wedge the hooks
      // worker every plugin shares, so a wait that did not wait ends it.
      const ms = backoffMs(fails++, this.#deps.random);
      const before = this.#deps.now();
      try {
        await this.#deps.sleep(ms);
      } catch {
        this.stop();
        return;
      }
      if (this.#deps.now() - before < ms / 2 && ++shortWaits >= 3) {
        this.stop();
        return;
      }
    }
  }

  #wakeToken(): void {
    const waiters = this.#tokenWaiters.splice(0);
    for (const w of waiters) w();
  }

  #wakeIdle(): void {
    const waiters = this.#idleWaiters.splice(0);
    for (const w of waiters) w();
  }
}
