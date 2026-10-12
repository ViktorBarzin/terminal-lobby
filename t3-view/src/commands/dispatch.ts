/**
 * T3's commands as lobby requests (the design's "T3 to lobby" table, with the
 * corrections the challenger reviews made).
 *
 *   message.dispatch, start_immediately  POST /prompt, T3's command id as the prompt id
 *   message.dispatch, steer_active       POST /prompt mid-turn: held, then steered in (ADR-0042)
 *   message.dispatch, queue_after_active POST /prompt {wait}: held until the turn ends
 *   message.dispatch, restart_active     POST /cancel {restoreQueue}, POST /prompt, the queue re-held
 *   message.dispatch with sourcePlanRef  the held plan approved (POST /answer), no prompt
 *   queued-run.cancel                    POST /prompt/cancel-queued, by text (the queue has no ids)
 *   queued-run.edit                      cancel-queued, then the new text queued under the same message
 *   run.interrupt                        POST /cancel
 *   run.interrupt, holdQueue             POST /cancel {restoreQueue}: the prompts come back and wait as held runs
 *   queue.resume                         each held run's text, POST /prompt {wait}, oldest first
 *   a held run's cancel or edit          the sidecar alone holds its text, so it changes there
 *   runtime-request.respond              POST /answer naming the tool call
 *   runtime / interaction mode           POST /model {mode}
 *   thread.model-selection.set           POST /model {model, effort}; 409 while a turn runs
 *
 * Every send records messageId -> text first (pending.ts), so the user row
 * Claude writes comes back under the browser's own id. A read-only session
 * refuses sends with the lobby's reason, and a refusal from the lobby is
 * returned with the lobby's own words.
 */
import type {
  MessageId,
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import type { Identity, RelayCredentials } from "../auth.ts";
import { type AnswerReply, type LobbyApi, LobbyError } from "../lobby/api.ts";
import type { DirectoryEntry, DirectoryProject } from "../shell/directory.ts";
import * as Ids from "../threads/ids.ts";
import type { LiveThread } from "../threads/live.ts";
import { lobbyModeFor, lobbyModeForInteraction } from "../threads/modes.ts";
import type { PendingDispatches } from "../threads/pending.ts";
import { approvalAnswer, promptIdOf, questionAnswers, resolveDispatchMode } from "./policy.ts";

/** A command the lobby refused or the sidecar cannot carry out, in words for the person. */
export class CommandFailure extends Error {
  override readonly name = "CommandFailure";
}

export type LobbyCalls = Pick<
  LobbyApi,
  "prompt" | "cancel" | "cancelQueued" | "answer" | "mode" | "model" | "prewarm" | "claim"
>;

export interface ThreadHandle {
  readonly entry: DirectoryEntry;
  readonly live: LiveThread;
}

export interface CommandDeps {
  readonly api: LobbyCalls;
  readonly pending: PendingDispatches;
  readonly now: () => number;
  /** The thread a command names, for this user; undefined when the lobby lists no such session. */
  readonly thread: (identity: Identity, threadId: string) => Promise<ThreadHandle | undefined>;
  /** For launchThread. */
  readonly project: (
    identity: Identity,
    projectId: string,
  ) => Promise<DirectoryProject | undefined>;
  /** Records the thread id T3 minted for a session the sidecar created (aliases.ts). */
  readonly alias: (identity: Identity, minted: string, threadId: string) => void;
  /** The models the composer offers (models.ts); a send leaves any other model alone. */
  readonly knownModels?: ReadonlySet<string>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly mintName?: () => string;
  readonly log?: (message: string) => void;
}

type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

const READ_ONLY = "This session is shared with you to watch, not to drive.";

/**
 * Why a mode walk did not apply that can change on its own: a pane the walk
 * cannot read yet (a session still starting), a press it could not confirm,
 * or a dialog that closes. Anything else (a mode the session does not offer)
 * stays the same however often it is asked.
 */
const TRANSIENT_MODE_REASONS = new Set(["unreadable", "unverified", "dialog-open"]);

/**
 * Waits before each try of a new session's first prompt, in ms: the browser's
 * own ladder (frontend-v2 lib/first-prompt.ts) with a longer last rung. Each
 * try is held by session-events until the Claude says hello, up to 25s.
 */
const FIRST_PROMPT_LADDER: readonly number[] = [0, 1600, 3000, 6000, 10_000];
const MINT_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function mintSessionName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => MINT_ALPHABET[b % MINT_ALPHABET.length]).join("");
}

/** The lobby's refusal in its own words. */
function lobbyReason(error: unknown): string {
  if (error instanceof LobbyError) {
    const body = error.body.trim();
    if (error.status === 503) {
      return body !== "" ? body : "The session's Claude is not connected to the lobby yet.";
    }
    return body !== "" ? body : `The lobby answered ${error.status}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function effortOf(selection: { readonly options?: unknown }): string | undefined {
  if (!Array.isArray(selection.options)) return undefined;
  for (const option of selection.options as ReadonlyArray<{ id?: unknown; value?: unknown }>) {
    if (option.id === "effort" && typeof option.value === "string") return option.value;
  }
  return undefined;
}

export class Commands {
  readonly #d: CommandDeps;

  constructor(deps: CommandDeps) {
    this.#d = deps;
  }

  async dispatch(identity: Identity, command: OrchestrationV2Command): Promise<void> {
    if (command.type === "thread.visit") {
      const handle = await this.#d.thread(identity, command.threadId);
      const at = Date.parse(command.visitedAt);
      if (handle !== undefined && Number.isFinite(at)) {
        handle.live.commit(handle.live.model.mapper.visited(at));
      }
      return;
    }
    if (!("threadId" in command)) {
      throw new CommandFailure(`${command.type} is not something a lobby session can do yet.`);
    }
    const what = `${identity.osUser}: ${command.type} on ${command.threadId}`;
    this.#d.log?.(what);
    try {
      await this.#dispatch(identity, command);
    } catch (error) {
      this.#d.log?.(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async #dispatch(
    identity: Identity,
    command: Extract<OrchestrationV2Command, { readonly threadId: unknown }>,
  ): Promise<void> {
    const handle = await this.#d.thread(identity, command.threadId);
    if (handle === undefined) throw new CommandFailure("The lobby lists no such session.");
    const { entry, live } = handle;
    const relay = identity.relay;
    const where = { session: entry.name, owner: entry.owner };
    const readOnly = entry.access === "ro";
    const refuseIfReadOnly = () => {
      if (readOnly) throw new CommandFailure(READ_ONLY);
    };
    const call = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        return await f();
      } catch (error) {
        throw new CommandFailure(lobbyReason(error));
      }
    };
    switch (command.type) {
      case "message.dispatch":
        refuseIfReadOnly();
        return this.#message(identity, handle, command);
      case "run.interrupt": {
        refuseIfReadOnly();
        // T3's Stop holds the queue: without restoreQueue the turn's end
        // would send every held prompt straight after the interrupt.
        const hold = command.holdQueue === true;
        const mapper = live.model.mapper;
        if (hold) live.commit(mapper.holdQueue());
        live.commit(mapper.interruptRequested());
        try {
          const reply = await call(() =>
            this.#d.api.cancel(relay, where.session, where.owner, hold),
          );
          if (hold) live.commit(mapper.holdReturned(reply.queue));
        } catch (error) {
          mapper.interruptRefused();
          if (hold) live.commit(mapper.releaseHold());
          throw error;
        }
        return;
      }
      case "queued-run.cancel": {
        refuseIfReadOnly();
        if (live.model.mapper.isHeld(command.runId)) {
          live.commit(live.model.mapper.cancelHeld(command.runId));
          return;
        }
        const queued = live.model.mapper.queuedRuns.find((q) => q.run.id === command.runId);
        if (queued === undefined) throw new CommandFailure("That message is no longer queued.");
        const reply = await call(() =>
          this.#d.api.cancelQueued(relay, where.session, where.owner, queued.text),
        );
        if (!reply.restored) throw new CommandFailure("That message already reached Claude.");
        return;
      }
      case "queued-run.edit": {
        refuseIfReadOnly();
        const mapper = live.model.mapper;
        if (mapper.isHeld(command.runId)) {
          live.commit(mapper.retextHeld(command.runId, command.text));
          return;
        }
        const queued = mapper.queuedRuns.find((q) => q.run.id === command.runId);
        if (queued === undefined || !mapper.expectEdit(command.runId, command.text)) {
          throw new CommandFailure("That message is no longer queued.");
        }
        try {
          const reply = await call(() =>
            this.#d.api.cancelQueued(relay, where.session, where.owner, queued.text),
          );
          if (!reply.restored) throw new CommandFailure("That message already reached Claude.");
          await this.#send(handle, relay, queued.run.userMessageId, command.text, { wait: true });
        } catch (error) {
          mapper.editFailed(command.runId);
          throw error;
        }
        return;
      }
      case "queued-message.promote-to-steer": {
        refuseIfReadOnly();
        const mapper = live.model.mapper;
        const heldRun = mapper.heldRuns.find((r) => r.runId === command.queuedRunId);
        if (heldRun !== undefined) {
          live.commit(mapper.resumeHeld([heldRun.runId]));
          try {
            await this.#send(handle, relay, heldRun.messageId, heldRun.text, {});
          } catch (error) {
            live.commit(mapper.reholdHeld([heldRun.runId]));
            throw error;
          }
          return;
        }
        const queued = live.model.mapper.queuedRuns.find((q) => q.run.id === command.queuedRunId);
        if (queued === undefined) throw new CommandFailure("That message is no longer queued.");
        const reply = await call(() =>
          this.#d.api.cancelQueued(relay, where.session, where.owner, queued.text),
        );
        if (!reply.restored) throw new CommandFailure("That message already reached Claude.");
        await this.#send(handle, relay, queued.run.userMessageId, queued.text, {});
        return;
      }
      case "queue.resume": {
        refuseIfReadOnly();
        const mapper = live.model.mapper;
        const held = mapper.heldRuns;
        live.commit(mapper.resumeHeld(held.map((r) => r.runId)));
        // With wait, each goes behind whatever turn runs, and the first one
        // starts a turn on an idle session that the rest then wait for.
        for (const [i, run] of held.entries()) {
          try {
            await this.#send(handle, relay, run.messageId, run.text, { wait: true });
          } catch (error) {
            live.commit(mapper.reholdHeld(held.slice(i).map((r) => r.runId)));
            throw error;
          }
        }
        return;
      }
      case "runtime-request.respond":
      case "thread.user-input.dismiss": {
        refuseIfReadOnly();
        const toolId = Ids.toolIdOfRequest(command.requestId);
        const dialog = toolId === undefined ? undefined : live.model.mapper.dialog(toolId);
        if (toolId === undefined || dialog === undefined) {
          throw new CommandFailure("That request has already been answered.");
        }
        let body: Readonly<Record<string, unknown>>;
        if (command.type === "thread.user-input.dismiss") {
          body = { toolId, chat: "" };
        } else if (dialog.kind === "ask") {
          const answers =
            command.answers === undefined
              ? undefined
              : questionAnswers(dialog.questions, command.answers);
          if (answers === undefined) throw new CommandFailure("Every question needs an answer.");
          body = { toolId, answers };
        } else {
          body = approvalAnswer(dialog.kind, toolId, command.decision ?? "decline");
        }
        const reply = await call(() => this.#d.api.answer(relay, where.session, where.owner, body));
        failUnlessApplied(reply);
        return;
      }
      case "thread.runtime-mode.set": {
        refuseIfReadOnly();
        await this.#setMode(handle, relay, lobbyModeFor(command.runtimeMode));
        return;
      }
      case "thread.interaction-mode.set": {
        refuseIfReadOnly();
        const runtime = live.model.mapper.thread.runtimeMode;
        await this.#setMode(
          handle,
          relay,
          lobbyModeForInteraction(command.interactionMode, runtime),
        );
        return;
      }
      case "thread.model-selection.set": {
        refuseIfReadOnly();
        await this.#setModel(handle, relay, command.modelSelection, true);
        return;
      }
      default:
        throw new CommandFailure(`${command.type} is not something a lobby session can do yet.`);
    }
  }

  async #message(identity: Identity, handle: ThreadHandle, command: Dispatch): Promise<void> {
    const { entry, live } = handle;
    const relay = identity.relay;
    const mapper = live.model.mapper;
    // Implement on a plan the session is holding approves it: the plan's
    // turn carries it out, and the text T3 composes for its own flow is not
    // a prompt the lobby should send.
    if (command.sourcePlanRef !== undefined) {
      const plan = mapper.openDialogs.find((d) => d.kind === "plan");
      if (plan !== undefined) {
        const reply = await this.#answer(
          relay,
          entry,
          approvalAnswer("plan", plan.toolId, "accept"),
        );
        failUnlessApplied(reply);
        return;
      }
    }
    // The composer can only show a model the provider lists. On a session
    // running another (a pre-warm alias such as claude-haiku-5-5) it falls
    // back to its default, so its selection there is not a choice to apply.
    const current = mapper.thread.modelSelection.model;
    if (
      command.modelSelection !== undefined &&
      mapper.activeRun === undefined &&
      (this.#d.knownModels === undefined || this.#d.knownModels.has(current))
    ) {
      await this.#setModel(handle, relay, command.modelSelection, false);
    }
    const mode = resolveDispatchMode(mapper.runs, command.dispatchMode, command.deliveryIntent);
    const id = promptIdOf(command.commandId);
    switch (mode.type) {
      case "queue_after_active":
        await this.#send(handle, relay, command.messageId, command.text, { wait: true });
        return;
      case "restart_active": {
        let took: ReadonlyArray<string> = [];
        try {
          took = (await this.#d.api.cancel(relay, entry.name, entry.owner, true)).queue;
        } catch (error) {
          throw new CommandFailure(lobbyReason(error));
        }
        await this.#send(
          handle,
          relay,
          command.messageId,
          command.text,
          id === undefined ? {} : { id },
        );
        for (const text of took) {
          await this.#send(handle, relay, undefined, text, { wait: true });
        }
        return;
      }
      case "steer_active":
        await this.#send(handle, relay, command.messageId, command.text, {});
        return;
      default:
        await this.#send(
          handle,
          relay,
          command.messageId,
          command.text,
          id === undefined ? {} : { id },
        );
    }
  }

  async #send(
    handle: ThreadHandle,
    relay: RelayCredentials,
    messageId: MessageId | undefined,
    text: string,
    options: { readonly wait?: boolean; readonly id?: string; readonly awaitReady?: boolean },
    unready?: { readonly ladder: readonly number[]; readonly sleep: (ms: number) => Promise<void> },
  ): Promise<void> {
    const key = handle.live.pendingKey;
    if (messageId !== undefined) this.#d.pending.add(key, { messageId, text, at: this.#d.now() });
    const ladder = unready?.ladder ?? [0];
    for (let rung = 0; ; rung++) {
      if (rung > 0) await unready?.sleep(ladder[rung] ?? 0);
      try {
        await this.#d.api.prompt(relay, handle.entry.name, handle.entry.owner, {
          text,
          ...options,
        });
        return;
      } catch (error) {
        // 503 is session-events saying the session's Claude has not said hello
        // yet. Each attempt looks for the mod again (a claimed slot's mod is
        // still under the slot's name until asked), as the browser's ladder does.
        const notReady = error instanceof LobbyError && error.status === 503;
        if (notReady && rung + 1 < ladder.length) continue;
        if (messageId !== undefined) this.#d.pending.remove(key, messageId);
        throw new CommandFailure(lobbyReason(error));
      }
    }
  }

  async #answer(
    relay: RelayCredentials,
    entry: DirectoryEntry,
    body: Readonly<Record<string, unknown>>,
  ): Promise<AnswerReply> {
    try {
      return await this.#d.api.answer(relay, entry.name, entry.owner, body);
    } catch (error) {
      throw new CommandFailure(lobbyReason(error));
    }
  }

  /**
   * Walks a new session into `mode`, asking again while the walk cannot read
   * a pane that is still starting (about 30 seconds, as the claim waits), and
   * fails the launch when it does not take.
   */
  async #modeBeforeFirstPrompt(
    handle: ThreadHandle,
    relay: RelayCredentials,
    mode: string,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    let reason = "no answer";
    for (let attempt = 0; attempt < 40; attempt++) {
      if (attempt > 0) await sleep(750);
      let reply: Awaited<ReturnType<LobbyCalls["mode"]>>;
      try {
        reply = await this.#d.api.mode(relay, handle.entry.name, handle.entry.owner, mode);
      } catch (error) {
        reason = lobbyReason(error);
        continue;
      }
      if (reply.applied === true) {
        handle.live.commit(handle.live.model.mapper.confirmMode(reply.mode ?? mode));
        return;
      }
      reason = reply.reason ?? "not applied";
      if (!TRANSIENT_MODE_REASONS.has(reason)) break;
    }
    this.#d.log?.(`launch ${handle.entry.name}: mode ${mode}: ${reason}`);
    throw new CommandFailure(
      `The new session could not be put in ${mode} mode (${reason}), so the first message was not sent.`,
    );
  }

  async #setMode(handle: ThreadHandle, relay: RelayCredentials, mode: string): Promise<void> {
    let reply: Awaited<ReturnType<LobbyCalls["mode"]>>;
    try {
      reply = await this.#d.api.mode(relay, handle.entry.name, handle.entry.owner, mode);
    } catch (error) {
      throw new CommandFailure(lobbyReason(error));
    }
    if (reply.applied !== true) {
      throw new CommandFailure(
        `The session stayed in its mode${reply.reason === undefined ? "" : ` (${reply.reason})`}.`,
      );
    }
    // The transcript reports a mode only with the next record, so the lobby's
    // confirmation is what moves the composer now.
    handle.live.commit(handle.live.model.mapper.confirmMode(reply.mode ?? mode));
  }

  /**
   * Sets the model and effort. `strict` fails the command on a refusal (the
   * model picker); otherwise the refusal becomes a notice and the message
   * still goes (an effort riding on a send).
   */
  async #setModel(
    handle: ThreadHandle,
    relay: RelayCredentials,
    selection: { readonly model: string; readonly options?: unknown },
    strict: boolean,
  ): Promise<void> {
    const current = handle.live.model.mapper.thread.modelSelection;
    const effort = effortOf(selection);
    if (selection.model === current.model && (effort === undefined || effort === effortOf(current)))
      return;
    try {
      const reply = await this.#d.api.model(relay, handle.entry.name, handle.entry.owner, {
        model: selection.model,
        ...(effort === undefined ? {} : { effort }),
      });
      handle.live.commit(
        handle.live.model.mapper.confirmModel({
          model: reply.model ?? selection.model,
          ...(reply.effort !== undefined
            ? { effort: reply.effort }
            : effort === undefined
              ? {}
              : { effort }),
        }),
      );
    } catch (error) {
      const reason = lobbyReason(error);
      if (strict) throw new CommandFailure(reason);
      handle.live.commit(handle.live.model.mapper.notice(`Model not changed: ${reason}`));
    }
  }

  /**
   * A new thread is a new lobby session in that project: a pre-warm slot
   * claimed under a minted name and placed by tmux-api (claim.go), put in the
   * mode the person chose, then the first prompt, sent with awaitReady so
   * session-events holds it until the session's Claude has said hello.
   *
   * The mode goes first. A slot starts in bypassPermissions, and a walk sent
   * after the prompt would run while Claude already acts on it, so a thread
   * started in Plan or Supervised would begin its first turn with no plan
   * and no approvals. When the mode does not take, the prompt is not sent.
   */
  async launch(
    identity: Identity,
    input: OrchestrationV2ThreadLaunchInput,
  ): Promise<{ readonly threadId: string; readonly projection: OrchestrationV2ThreadProjection }> {
    const what = `${identity.osUser}: launch ${input.threadId ?? "(no thread id)"}`;
    this.#d.log?.(`${what} in ${input.projectId}`);
    try {
      return await this.#launch(identity, input);
    } catch (error) {
      this.#d.log?.(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async #launch(
    identity: Identity,
    input: OrchestrationV2ThreadLaunchInput,
  ): Promise<{ readonly threadId: string; readonly projection: OrchestrationV2ThreadProjection }> {
    const project = await this.#d.project(identity, input.projectId);
    if (project === undefined || project.id.startsWith("shared:")) {
      throw new CommandFailure("New sessions go in one of your own projects.");
    }
    const relay = identity.relay;
    const name = (this.#d.mintName ?? mintSessionName)();
    const threadId = input.threadId ?? name;
    const model = input.modelSelection.model;
    const effort = effortOf(input.modelSelection);
    const slot = {
      dir: project.dir,
      ...(model === "" ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    };
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // T3 sends the launch again when the first attempt failed after the
    // session was claimed (its first prompt refused, say). The thread id is
    // aliased by then, so that session takes the prompt rather than a second
    // one being started beside it.
    const started =
      input.threadId === undefined ? undefined : await this.#d.thread(identity, input.threadId);
    const handle =
      started ?? (await this.#claimNew(identity, project, name, threadId, slot, sleep));
    const wantMode = lobbyModeForInteraction(input.interactionMode, input.runtimeMode);
    const message = input.initialMessage;
    if (message !== undefined && message.text.trim() !== "") {
      await this.#modeBeforeFirstPrompt(handle, relay, wantMode, sleep);
      const messageId = message.messageId;
      await this.#send(
        handle,
        relay,
        messageId,
        message.text,
        {
          awaitReady: true,
          ...(promptIdOf(input.commandId) === undefined
            ? {}
            : { id: promptIdOf(input.commandId) as string }),
        },
        { ladder: FIRST_PROMPT_LADDER, sleep },
      );
    } else {
      // No prompt rides on it, so a mode that did not take is a notice; the
      // composer shows the mode the session reports.
      await this.#setMode(handle, relay, wantMode).catch((error: unknown) => {
        this.#d.log?.(`launch ${handle.entry.name}: mode ${wantMode}: ${String(error)}`);
        handle.live.commit(
          handle.live.model.mapper.notice(
            `Mode not set: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    }
    await handle.live.ready(5_000);
    return { threadId: handle.entry.threadId, projection: handle.live.projection };
  }

  /** A pre-warm slot claimed under a minted name, aliased to T3's thread id, once it is listed. */
  async #claimNew(
    identity: Identity,
    project: DirectoryProject,
    name: string,
    threadId: string,
    slot: { readonly dir: string; readonly model?: string; readonly effort?: string },
    sleep: (ms: number) => Promise<void>,
  ): Promise<ThreadHandle> {
    const relay = identity.relay;
    try {
      await this.#d.api.prewarm(relay, slot);
      let claimed = false;
      for (let attempt = 0; attempt < 40 && !claimed; attempt++) {
        if (attempt > 0) await sleep(750);
        const reply = await this.#d.api.claim(relay, {
          name,
          ...slot,
          ...(project.layoutName === undefined || project.layoutName === ""
            ? {}
            : { project: project.layoutName }),
        });
        claimed = reply.claimed;
      }
      if (!claimed) throw new CommandFailure("No session could be started for that project.");
    } catch (error) {
      if (error instanceof CommandFailure) throw error;
      throw new CommandFailure(lobbyReason(error));
    }
    this.#d.alias(identity, name, threadId);
    // tmux-api serves /sessions from a cache of a few seconds, so the claimed
    // session can take that long to be listed.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await sleep(750);
      const handle = await this.#d.thread(identity, threadId);
      if (handle !== undefined) return handle;
    }
    throw new CommandFailure("The new session did not appear in the lobby.");
  }
}

function failUnlessApplied(reply: AnswerReply): void {
  if (reply.applied === true) return;
  const reasons: Record<string, string> = {
    "not-held": "That question was already answered.",
    "not-drawn": "That prompt is no longer open.",
    "unknown-option": "That choice is not on the prompt any more.",
    incomplete: "Every question needs an answer.",
    unverified:
      "The lobby could not confirm the answer; look at the session before answering again.",
  };
  throw new CommandFailure(
    reasons[reply.reason ?? ""] ?? `The answer was not applied (${reply.reason ?? "no reason"}).`,
  );
}
