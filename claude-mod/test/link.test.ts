import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../hooks/lib/link.ts';
import type { LinkDeps, Reply } from '../hooks/lib/link.ts';
import { Pending } from '../hooks/lib/pending.ts';
import type { HelloBody } from '../hooks/lib/wire.ts';
import { ack, ask, level, permission, row } from './events.ts';

// A manual clock: timers and sleeps fire only when the test advances time.
class FakeClock {
  now = 0;
  timers: { at: number; fn: () => void }[] = [];
  after = (ms: number, fn: () => void) => { this.timers.push({ at: this.now + ms, fn }); };
  sleep = (ms: number) => new Promise<void>((resolve) => this.after(ms, resolve));
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      await settle();
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
    this.now = end;
    await settle();
  }
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

type Call = { method: string; path: string; body?: unknown };

// A scripted server: each route answers from a queue of replies, or a default.
class FakeServer {
  calls: Call[] = [];
  replies: Record<string, (Reply | Error | (() => Promise<Reply>))[]> = {};
  defaults: Record<string, Reply | Error> = {
    hello: { status: 200, body: { token: 'tok1', history: false } },
    events: { status: 204, body: null },
    poll: { status: 200, body: { commands: [] } },
  };
  holdPoll = true;
  pollWaiters: ((r: Reply) => void)[] = [];

  route(path: string) {
    if (path.startsWith('/mod/v1/hello')) return 'hello';
    if (path.startsWith('/mod/v1/events')) return 'events';
    return 'poll';
  }

  async answer(method: string, path: string, body?: unknown): Promise<Reply> {
    this.calls.push({ method, path, body });
    const r = this.route(path);
    const next = this.replies[r]?.shift();
    const reply = next ?? (r === 'poll' && this.holdPoll ? undefined : this.defaults[r]);
    if (reply === undefined) return new Promise((resolve) => this.pollWaiters.push(resolve));
    if (typeof reply === 'function') return reply();
    if (reply instanceof Error) throw reply;
    return reply;
  }

  of(route: string) {
    return this.calls.filter((c) => this.route(c.path) === route);
  }
}

// A hello body whose `session` counts the hellos built.
function helloBody(n: number): Omit<HelloBody, 'dropped'> {
  return {
    sid: 's1', pane: '%1', tmux: '', session: `n${n}`, cwd: '/w', model: 'm', version: 'v', mod: '0.3.0',
    instance: 'i1', ops: [],
  };
}

function setup(over: Partial<LinkDeps> = {}) {
  const clock = new FakeClock();
  const server = new FakeServer();
  const commands: unknown[] = [];
  let helloN = 0;
  const deps: LinkDeps = {
    post: (path, body) => server.answer('POST', path, body),
    get: (path) => server.answer('GET', path),
    now: () => clock.now,
    after: clock.after,
    sleep: clock.sleep,
    random: () => 0,
    hello: async () => helloBody(++helloN),
    history: async () => ({ messages: [{ role: 'user', text: 'earlier', toolUses: [] }], running: true }),
    onCommand: (c) => { commands.push(c); },
    ...over,
  };
  const link = new Link(deps);
  return { clock, server, link, commands };
}

test('start says hello and then posts queued events with the token', async () => {
  const { clock, server, link } = setup();
  link.send(row('a'));
  link.start();
  await clock.advance(100);
  assert.equal(server.of('hello').length, 1);
  assert.deepEqual(server.of('hello')[0]?.body, { ...helloBody(1), dropped: 0 });
  const ev = server.of('events');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0]?.body, { token: 'tok1', events: [row('a')] });
});

test('only one events request is in flight; the rest wait and go together', async () => {
  const { clock, server, link } = setup();
  let release!: () => void;
  server.replies.events = [() => new Promise((resolve) => { release = () => resolve({ status: 204, body: null }); })];
  link.start();
  await clock.advance(10);
  link.send(row('a'));
  await clock.advance(100);
  link.send(row('b'));
  link.send(row('c'));
  await clock.advance(500);
  assert.equal(server.of('events').length, 1, 'second batch waits for the first');
  release();
  await clock.advance(100);
  const ev = server.of('events');
  assert.equal(ev.length, 2);
  assert.deepEqual((ev[1]?.body as { events: unknown[] }).events, [row('b'), row('c')]);
});

test('flushes are at least 50 ms apart', async () => {
  const { clock, server, link } = setup();
  link.start();
  await clock.advance(1);
  link.send(row('a'));
  await clock.advance(1);
  const first = server.of('events').length;
  link.send(row('b'));
  await clock.advance(20);
  assert.equal(server.of('events').length, first, 'no second flush inside 50 ms');
  await clock.advance(60);
  assert.equal(server.of('events').length, first + 1);
});

test('hello failure retries with backoff and never throws', async () => {
  const { clock, server, link } = setup();
  server.replies.hello = [new Error('ECONNREFUSED'), { status: 502, body: null }];
  link.send(row('a'));
  link.start();
  await clock.advance(10);
  assert.equal(server.of('hello').length, 1);
  await clock.advance(500); // backoff 0 -> 500 ms at random 0
  assert.equal(server.of('hello').length, 2);
  await clock.advance(980);
  assert.equal(server.of('hello').length, 2, 'second backoff is 1000 ms');
  await clock.advance(20);
  assert.equal(server.of('hello').length, 3);
  await clock.advance(100);
  assert.deepEqual((server.of('events')[0]?.body as { events: unknown[] }).events, [row('a')]);
});

test('a 409 on events re-hellos and resends the batch', async () => {
  const { clock, server, link } = setup();
  server.replies.hello = [
    { status: 200, body: { token: 'tok1', history: false } },
    { status: 200, body: { token: 'tok2', history: false } },
  ];
  server.replies.events = [{ status: 409, body: null }];
  link.start();
  link.send(row('a'));
  await clock.advance(200);
  assert.equal(server.of('hello').length, 2);
  const ev = server.of('events');
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[1]?.body, { token: 'tok2', events: [row('a')] });
});

// Wire contract v3, item 5: the history is the snapshot, so content queued
// before it would replay behind it (the tail of the conversation shown twice,
// T-F2). Acks, the summary and command failures are not in any snapshot.
test('history:true drops queued content but keeps acks, the summary and failures', async () => {
  const { clock, server, link } = setup();
  server.replies.hello = [{ status: 200, body: { token: 'tok1', history: true } }];
  link.send(row('a'));
  link.send(ack('c1'));
  link.send({ type: 'summary', t: 0, text: 'Title' });
  link.send({ type: 'command_failed', t: 0, id: 'c2', op: 'prompt', error: 'dropped: no' });
  link.send({ type: 'turn_end', t: 0, turnId: 'T', aborted: false, answer: '', durationMs: 0 });
  link.start();
  await clock.advance(100);
  const events = (server.of('events')[0]?.body as { events: { type: string }[] }).events;
  assert.deepEqual(events.map((e) => e.type), ['history', 'ack', 'summary', 'command_failed']);
  const history = events[0] as unknown as { messages: unknown; running: unknown };
  assert.deepEqual(history.messages, [{ role: 'user', text: 'earlier', toolUses: [] }]);
  assert.equal(history.running, true);
});

test('a batch refused with 409 is not replayed behind the history the next hello asks for', async () => {
  const { clock, server, link } = setup();
  server.replies.hello = [
    { status: 200, body: { token: 'tok1', history: false } },
    { status: 200, body: { token: 'tok2', history: true } },
  ];
  server.replies.events = [{ status: 409, body: null }];
  link.start();
  await clock.advance(10);
  link.send(row('gap'));
  await clock.advance(200);
  const ev = server.of('events');
  assert.equal(ev.length, 2);
  assert.deepEqual((ev[1]?.body as { events: { type: string }[] }).events.map((e) => e.type), ['history']);
});

test('history:false keeps the queued content', async () => {
  const { clock, server, link } = setup();
  link.send(row('a'));
  link.start();
  await clock.advance(100);
  assert.deepEqual((server.of('events')[0]?.body as { events: unknown[] }).events, [row('a')]);
});

test('every hello ends with a level, after the history and the open dialogs', async () => {
  const lv = level({ running: true, asks: ['toolu_1'] });
  const { clock, server, link } = setup({ open: () => [ask('toolu_1')], level: async () => lv });
  server.replies.hello = [
    { status: 200, body: { token: 'tok1', history: true } },
    { status: 200, body: { token: 'tok2', history: false } },
  ];
  link.start();
  await clock.advance(100);
  const first = (server.of('events')[0]?.body as { events: { type: string }[] }).events;
  assert.deepEqual(first.map((e) => e.type), ['history', 'ask', 'level']);
  assert.deepEqual(first[2], lv);
  link.rehello();
  link.send(row('b'));
  await clock.advance(100);
  const second = (server.of('events')[1]?.body as { events: { type: string }[] }).events;
  assert.deepEqual(second.map((e) => e.type), ['ask', 'level', 'row']);
});

test('a level that cannot be read leaves the rest of the resend going', async () => {
  const { clock, server, link } = setup({ open: () => [ask('toolu_1')], level: () => Promise.reject(new Error('gone')) });
  link.start();
  await clock.advance(100);
  assert.deepEqual((server.of('events')[0]?.body as { events: { type: string }[] }).events.map((e) => e.type), ['ask']);
});

test('the hello says how many events the queue has dropped', async () => {
  const { clock, server, link } = setup();
  server.defaults.hello = new Error('down');
  link.start();
  // Over the 3.5 M character limit: dropped when the queue next takes a batch.
  link.send({ ...row('huge'), message: { type: 'assistant', content: 'x'.repeat(3_600_000) } });
  await clock.advance(10);
  server.defaults.hello = { status: 200, body: { token: 'tok1', history: false } };
  server.replies.events = [new Error('reset')];
  await clock.advance(1000);
  link.rehello();
  await clock.advance(2000);
  const last = server.of('hello').at(-1)?.body as HelloBody;
  assert.equal(last.dropped, 1);
});

// T-F1: a port above 1024 that session-events let go of can be taken by any
// account; the mod speaks only to a root-owned listener.
test('no hello while the listener is not trusted; the check is asked again with backoff', async () => {
  let trusted = false;
  let asked = 0;
  const { clock, server, link } = setup({ trusted: async () => { asked++; return trusted; } });
  link.start();
  await clock.advance(10);
  assert.equal(asked, 1);
  assert.equal(server.of('hello').length, 0);
  await clock.advance(500);
  assert.equal(asked, 2);
  assert.equal(server.of('hello').length, 0);
  trusted = true;
  await clock.advance(1000);
  assert.equal(server.of('hello').length, 1);
  assert.equal(server.of('poll').length, 1, 'commands are polled only after a trusted hello');
});

test('a network error on events keeps the batch and retries after backoff', async () => {
  const { clock, server, link } = setup();
  server.replies.events = [new Error('reset')];
  link.start();
  link.send(row('a'));
  await clock.advance(100);
  assert.equal(server.of('events').length, 1);
  await clock.advance(600);
  const ev = server.of('events');
  assert.equal(ev.length, 2);
  assert.deepEqual((ev[1]?.body as { events: unknown[] }).events, [row('a')]);
  assert.equal(server.of('hello').length, 1, 'no re-hello for a network error');
});

test('the poll loop hands commands over and polls again', async () => {
  const { clock, server, link, commands } = setup();
  server.replies.poll = [
    { status: 200, body: { commands: [{ id: 'c1', op: 'prompt', text: 'hi' }] } },
    { status: 200, body: { commands: [{ id: 'c2', op: 'abort' }] } },
  ];
  link.start();
  await clock.advance(100);
  assert.deepEqual(commands, [{ id: 'c1', op: 'prompt', text: 'hi' }, { id: 'c2', op: 'abort' }]);
  const polls = server.of('poll');
  assert.equal(polls.length, 3, 'third poll is held open');
  assert.equal(polls[0]?.path, '/mod/v1/poll?token=tok1');
});

test('a 409 on poll re-hellos and the poll uses the new token', async () => {
  const { clock, server, link } = setup();
  server.replies.hello = [
    { status: 200, body: { token: 'tok1', history: false } },
    { status: 200, body: { token: 'tok 2', history: false } },
  ];
  server.replies.poll = [{ status: 409, body: null }];
  link.start();
  await clock.advance(100);
  assert.equal(server.of('hello').length, 2);
  assert.equal(server.of('poll')[1]?.path, '/mod/v1/poll?token=tok%202');
});

test('poll errors back off instead of spinning', async () => {
  const { clock, server, link } = setup();
  server.replies.poll = [new Error('timeout'), new Error('timeout')];
  link.start();
  await clock.advance(10);
  assert.equal(server.of('poll').length, 1);
  await clock.advance(500);
  assert.equal(server.of('poll').length, 2);
  await clock.advance(1000);
  assert.equal(server.of('poll').length, 3);
});

test('a sleep that rejects (timers dropped on unload) ends the poll loop', async () => {
  const { clock, server, link } = setup({ sleep: () => Promise.reject(new Error('unloaded')) });
  server.defaults.poll = new Error('unloaded');
  server.holdPoll = false;
  link.start();
  await clock.advance(10);
  assert.equal(server.of('poll').length, 1);
  await clock.advance(5000);
  assert.equal(server.of('poll').length, 1, 'no spinning');
});

test('a sleep that returns at once cannot make the poll loop spin', async () => {
  const { clock, server, link } = setup({ sleep: () => Promise.resolve() });
  server.defaults.poll = new Error('unloaded');
  server.holdPoll = false;
  link.start();
  await clock.advance(10);
  assert.ok(server.of('poll').length <= 4, `polled ${server.of('poll').length} times`);
});

test('a timer call that throws (module unloaded) stops the link quietly', async () => {
  const { clock, server, link } = setup();
  link.start();
  await clock.advance(100);
  const before = server.calls.length;
  const dead = setup({ after: () => { throw new Error('unloaded'); } });
  dead.link.start();
  dead.link.send(row('x'));
  await dead.clock.advance(1000);
  assert.equal(dead.server.calls.length, 0);
  assert.equal(server.calls.length, before);
});

test('rehello sends a fresh hello and keeps events flowing', async () => {
  const { clock, server, link } = setup();
  link.start();
  await clock.advance(100);
  link.rehello();
  link.send(row('b'));
  await clock.advance(100);
  const hellos = server.of('hello');
  assert.equal(hellos.length, 2);
  assert.deepEqual(hellos[1]?.body, { ...helloBody(2), dropped: 0 });
  assert.deepEqual((server.of('events').at(-1)?.body as { events: unknown[] }).events, [row('b')]);
});

// Measured live 2026-10-02: eight conversations created at once, and three
// never got @claude_transcript. Their first hello went out before Claude had
// written the file, the file appeared while that hello was still in flight,
// and the rehello asked for then was overwritten by the slow hello's token.
test('a rehello asked for while a hello is in flight sends another hello', async () => {
  const { clock, server, link } = setup();
  let release!: (r: Reply) => void;
  server.replies.hello = [() => new Promise<Reply>((resolve) => { release = resolve; })];
  link.start();
  await clock.advance(100);
  assert.equal(server.of('hello').length, 1);
  link.rehello();
  release({ status: 200, body: { token: 'tok1', history: false } });
  await clock.advance(100);
  const hellos = server.of('hello');
  assert.equal(hellos.length, 2, 'the rehello asked for mid-hello must not be lost');
  assert.deepEqual(hellos[1]?.body, { ...helloBody(2), dropped: 0 });
});

test('drain resolves once the queue is posted, or at its deadline', async () => {
  const { clock, server, link } = setup();
  link.start();
  await clock.advance(100);
  link.send(row('z'));
  let done = false;
  link.drain(1000).then(() => { done = true; });
  await clock.advance(100);
  assert.equal(done, true);
  assert.deepEqual((server.of('events').at(-1)?.body as { events: unknown[] }).events, [row('z')]);

  server.defaults.events = new Error('down');
  link.send(row('y'));
  done = false;
  link.drain(1000).then(() => { done = true; });
  await clock.advance(900);
  assert.equal(done, false);
  await clock.advance(200);
  assert.equal(done, true);
});

test('stop ends the loops: nothing is sent afterwards', async () => {
  const { clock, server, link } = setup();
  link.start();
  await clock.advance(100);
  link.stop();
  const before = server.calls.length;
  link.send(row('late'));
  await clock.advance(5000);
  assert.equal(server.calls.length, before);
});

test('a hello whose builder throws is retried like a network failure', async () => {
  let n = 0;
  const { clock, server, link } = setup({
    hello: async () => { if (n++ === 0) throw new Error('tmux gone'); return helloBody(n); },
  });
  link.start();
  await clock.advance(10);
  assert.equal(server.of('hello').length, 0);
  await clock.advance(600);
  assert.equal(server.of('hello').length, 1);
});

test('Pending resolves a waiter by id exactly once and reports gone ids', async () => {
  const p = new Pending<string>();
  const w = p.wait('t1');
  assert.equal(p.has('t1'), true);
  assert.equal(p.resolve('t1', 'yes'), true);
  assert.equal(await w.promise, 'yes');
  assert.equal(p.resolve('t1', 'again'), false);
  assert.equal(p.resolve('nope', 'x'), false);
  const w2 = p.wait('t2');
  w2.cancel();
  assert.equal(p.resolve('t2', 'late'), false);
  assert.equal(p.has('t2'), false);
});

// A session-events restart forgets the dialogs it held. The mod sent each
// one once, when it opened, so without a resend the web could never answer
// a question asked before the restart (2026-10-02, after the 0.94.2 install).
test('after a hello, open dialogs go out again behind the history', async () => {
  const open = ask('toolu_1');
  const { clock, server, link } = setup({ open: () => [open] });
  server.replies.hello = [{ status: 200, body: { token: 'tok1', history: true } }];
  link.start();
  await clock.advance(100);
  const events = (server.of('events')[0]?.body as { events: { type: string }[] }).events;
  assert.deepEqual(events.map((e) => e.type), ['history', 'ask']);
  assert.deepEqual(events[1], open);
});

test('a re-hello without history still resends the open dialogs', async () => {
  const held = permission('toolu_2');
  let open: ReturnType<typeof permission>[] = [];
  const { clock, server, link } = setup({ open: () => open });
  server.replies.hello = [
    { status: 200, body: { token: 'tok1', history: false } },
    { status: 200, body: { token: 'tok2', history: false } },
  ];
  link.start();
  await clock.advance(100);
  assert.equal(server.of('events').length, 0, 'nothing open, nothing sent');
  open = [held];
  link.rehello();
  await clock.advance(100);
  const events = (server.of('events')[0]?.body as { token: string; events: unknown[] });
  assert.equal(events.token, 'tok2');
  assert.deepEqual(events.events, [held]);
});

test('a dialog closed before the hello is not resent', async () => {
  const { clock, server, link } = setup({ open: () => [] });
  server.replies.hello = [{ status: 200, body: { token: 'tok1', history: false } }];
  link.send(row('a'));
  link.start();
  await clock.advance(100);
  const events = (server.of('events')[0]?.body as { events: { type: string }[] }).events;
  assert.deepEqual(events.map((e) => e.type), ['row']);
});
