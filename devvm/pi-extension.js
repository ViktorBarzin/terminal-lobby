// terminal-lobby's extension for pi (https://pi.dev), the third harness the
// lobby starts beside Claude Code and Codex
// (docs/plans/2026-09-25-pi-harness-design.md).
//
// Shipped by the terminal-lobby package to
// /usr/share/terminal-lobby/pi-extension.js and linked into each roster user's
// ~/.pi/agent/extensions/terminal-lobby.js by the provisioner. Plain
// JavaScript, so pi loads it without a TypeScript transpile.
//
// What it does, by pi event:
//
//   session_start          apply the launch model and thinking level handed
//                          over in TL_PI_MODEL / TL_PI_THINKING (once per
//                          process), stamp `done`, stamp the model details
//   project_trust          stamp `awaiting`; decide nothing, so pi still asks
//   agent_start            stamp `running`
//   agent_settled          stamp `done`, post the conversation's running totals
//   ui_prompt_start/_end   stamp `awaiting`, then `running` or `done`
//   model_select,
//   thinking_level_select  re-stamp the model details
//   before_agent_start     add the org policy as a system prompt section
//   session_shutdown       on `quit` only: post the final totals, stamp `clear`
//
// State goes through the same claude-tmux-state script Claude Code's hooks run,
// with empty stdin, so a pi session writes the @claude_state option the lobby's
// consumers already read. The model details go into PANE options:
// @tl_pi_model (provider/id), @tl_pi_thinking, and @tl_pi_levels, the levels
// the current model supports. The running cost goes into @tl_usage_cost, the
// pane option Claude's statusLine recorder keeps.
//
// The contract with pi:
//   - The factory has no side effects. Extensions also load for `pi
//     --list-models` and in print, JSON and RPC modes, and nothing may run there.
//   - The lobby integration acts only in pi's interactive TUI mode inside tmux
//     (ctx.mode "tui" and TMUX_PANE set). The org policy applies in every mode,
//     since it is the same policy for every pi a roster user runs.
//   - Every tmux call runs one at a time on a single promise chain, so two
//     quick stamps cannot land out of order.
//   - Every failure is silent. A broken extension must never break pi: every
//     handler catches everything and returns normally.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";

// The overrides exist for the tests and the dev harness, the same rationale as
// tl-usage-record's TL_USAGE_ENDPOINT: a test run must not stamp through the
// installed script, read the machine's policy or post into the production
// store. Nothing in production sets them.
const STATE_SCRIPT = process.env.TL_PI_STATE_SCRIPT || "/usr/local/bin/claude-tmux-state";
const ORG_POLICY = process.env.TL_PI_ORG_POLICY || "/etc/pi/org-policy.md";
const USAGE_ENDPOINT = process.env.TL_PI_USAGE_ENDPOINT || "http://localhost:7685/hooks/pi-usage";

// Pi's thinking levels, in pi's order (pi-ai's EXTENDED_THINKING_LEVELS).
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// The system prompt section the org policy goes into. Pi wraps a section in a
// tag of its own name, and a name must match /^[a-z][a-z0-9_-]*$/.
const POLICY_SECTION = "org_policy";

// How long one tmux call may take, and how long a quit waits for the last
// stamps and the final post before letting pi exit anyway.
const EXEC_TIMEOUT_MS = 5000;
const SHUTDOWN_WAIT_MS = 2000;
const POST_TIMEOUT_MS = 3000;

export default function terminalLobby(pi) {
	// Per runtime. Pi rebuilds the extension runtime for /reload, /new, /resume
	// and /fork, and calls this factory again, so nothing here outlives one
	// session. The launch choice is kept once per PROCESS instead, by taking it
	// out of the environment when it is applied.
	let chain = Promise.resolve();
	let inTurn = false;
	let lastPosted = "";

	const pane = () => process.env.TMUX_PANE || "";
	const lobby = (ctx) => !!ctx && ctx.mode === "tui" && pane() !== "";

	// run queues one command behind every earlier one and resolves with its
	// result, or with null when it could not run. It never rejects.
	const run = (command, args) => {
		const next = chain.then(async () => {
			try {
				return await pi.exec(command, args, { cwd: "/", timeout: EXEC_TIMEOUT_MS });
			} catch {
				return null;
			}
		});
		chain = next.catch(() => null);
		return chain;
	};

	// then queues a step that is not a command (the usage post) on the same
	// chain, so it lands in order with the stamps around it.
	const then = (fn) => {
		chain = chain.then(async () => {
			try {
				await fn();
			} catch {
				// silent: see the file comment
			}
		});
		return chain;
	};

	// stamp hands claude-tmux-state its verb on argv with empty stdin. With no
	// hook_event_name on stdin the script decides by that word alone, which is
	// exactly running, done, awaiting and clear.
	const stamp = (verb) => run(STATE_SCRIPT, [verb]);

	const setOption = (name, value) =>
		value
			? run("tmux", ["set-option", "-p", "-t", pane(), "--", name, value])
			: run("tmux", ["set-option", "-p", "-u", "-t", pane(), name]);

	const notify = (ctx, message) => {
		try {
			ctx?.ui?.notify(message, "warning");
		} catch {
			// silent
		}
	};

	// stampModel writes what the session is on, for the lobby's model chip.
	const stampModel = async (ctx, model) => {
		try {
			const m = model || ctx?.model;
			const ref = m ? `${m.provider}/${m.id}` : "";
			let level = "";
			try {
				level = pi.getThinkingLevel() || "";
			} catch {
				level = ctx?.thinkingLevel || "";
			}
			const levels = m ? await supportedLevels(m) : [];
			setOption("@tl_pi_model", ref);
			setOption("@tl_pi_thinking", level);
			setOption("@tl_pi_levels", levels.join(","));
		} catch {
			// silent
		}
	};

	// applyLaunchChoice puts the session on the model and thinking level picked
	// in the lobby's composer. They arrive in the environment rather than as
	// flags, because `pi --model` with a model the account no longer lists
	// exits 1 and the session would close as it opened. Here, a model pi cannot
	// resolve or has no sign-in for is a notice and the default stays.
	//
	// Taken out of the environment on first use, so a /new, /resume or /reload
	// later in the same process does not undo a switch made since, and nothing
	// pi starts inherits it.
	const applyLaunchChoice = async (ctx) => {
		const ref = process.env.TL_PI_MODEL || "";
		const level = process.env.TL_PI_THINKING || "";
		delete process.env.TL_PI_MODEL;
		delete process.env.TL_PI_THINKING;
		if (ref) {
			try {
				const slash = ref.indexOf("/");
				const model =
					slash > 0 ? ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
				if (!model) {
					notify(ctx, `terminal-lobby: pi does not know the model ${ref}, so this session stays on its default.`);
				} else if (!(await pi.setModel(model))) {
					notify(ctx, `terminal-lobby: ${model.provider} is not signed in, so this session stays on its default model.`);
				}
			} catch {
				notify(ctx, `terminal-lobby: could not switch to ${ref}, so this session stays on its default model.`);
			}
		}
		if (level) {
			try {
				if (LEVELS.includes(level)) {
					// Pi clamps a level the model does not support.
					pi.setThinkingLevel(level);
				} else {
					notify(ctx, `terminal-lobby: ${level} is not a pi thinking level.`);
				}
			} catch {
				notify(ctx, `terminal-lobby: could not set the thinking level to ${level}.`);
			}
		}
	};

	// postUsage sends the conversation's running totals to session-events and
	// stamps the running cost on the pane. Running totals rather than a delta,
	// so a lost post costs nothing once a later one lands; and nothing is sent
	// when the totals have not moved since the last post.
	const postUsage = (ctx) =>
		then(async () => {
			const sm = ctx?.sessionManager;
			if (!sm) return;
			const sessionId = sm.getSessionId();
			if (!sessionId) return;
			const totals = sessionTotals(sm.getEntries());
			const m = ctx.model;
			const reading = {
				sessionId,
				model: m ? `${m.provider}/${m.id}` : "",
				costUsd: round(totals.cost),
				tokens: {
					input: totals.input,
					output: totals.output,
					cacheRead: totals.cacheRead,
					cacheWrite: totals.cacheWrite,
				},
			};
			const key = JSON.stringify(reading);
			if (key === lastPosted) return;
			lastPosted = key;
			// The session's name is read at every post: the lobby renames a
			// session once it has a title, so a name kept from start-up would
			// attribute the spend to a session that no longer exists.
			const res = await pi.exec("tmux", ["display-message", "-p", "-t", pane(), "#{session_name}"], {
				cwd: "/",
				timeout: EXEC_TIMEOUT_MS,
			});
			const session = (res?.stdout || "").trim();
			await pi.exec("tmux", ["set-option", "-p", "-t", pane(), "--", "@tl_usage_cost", String(reading.costUsd)], {
				cwd: "/",
				timeout: EXEC_TIMEOUT_MS,
			});
			if (!session) return;
			await postJSON(USAGE_ENDPOINT, { user: os.userInfo().username, tmux_session: session, ...reading });
		});

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (!lobby(ctx)) return;
			inTurn = false;
			await applyLaunchChoice(ctx);
			stamp("done");
			// model_select fires only on a change, so a session that starts on its
			// default model would otherwise never be stamped.
			await stampModel(ctx);
		} catch {
			// silent
		}
	});

	// The trust question pi raises for a folder with project resources. Stamping
	// awaiting is what puts the session in the sidebar's waiting group while a
	// person has to answer it. `undecided` is pi's "no opinion": the next
	// handler, then pi itself, decides, and pi asks. Returning nothing at all
	// would be reported by pi as this extension's error.
	pi.on("project_trust", (_event, ctx) => {
		try {
			if (ctx && ctx.mode === "tui" && ctx.hasUI && pane() !== "") {
				stamp("awaiting");
			}
		} catch {
			// silent
		}
		return { trusted: "undecided" };
	});

	pi.on("agent_start", (_event, ctx) => {
		try {
			if (!lobby(ctx)) return;
			inTurn = true;
			stamp("running");
		} catch {
			// silent
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		try {
			if (!lobby(ctx)) return;
			inTurn = false;
			stamp("done");
			postUsage(ctx);
		} catch {
			// silent
		}
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		try {
			if (lobby(ctx)) stamp("awaiting");
		} catch {
			// silent
		}
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		try {
			if (lobby(ctx)) stamp(inTurn ? "running" : "done");
		} catch {
			// silent
		}
	});

	pi.on("model_select", async (event, ctx) => {
		try {
			if (lobby(ctx)) await stampModel(ctx, event?.model);
		} catch {
			// silent
		}
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		try {
			if (lobby(ctx)) await stampModel(ctx);
		} catch {
			// silent
		}
	});

	// Usage that lands outside a turn: a /compact or a /tree summary.
	pi.on("session_compact", (_event, ctx) => {
		try {
			if (lobby(ctx)) postUsage(ctx);
		} catch {
			// silent
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		try {
			if (lobby(ctx)) postUsage(ctx);
		} catch {
			// silent
		}
	});

	// Every mode, every turn: the org policy is the same text Claude Code and
	// Codex receive, and it applies to every pi a roster user runs. Read fresh
	// each turn, so a policy change reaches running sessions. A missing or empty
	// file is no section and no error.
	pi.on("before_agent_start", (event) => {
		try {
			const policy = fs.readFileSync(ORG_POLICY, "utf8").trim();
			if (policy && event?.systemPromptOptions?.sections) {
				event.systemPromptOptions.sections[POLICY_SECTION] = policy;
			}
		} catch {
			// silent
		}
	});

	// Only `quit` ends the session. Reload, /new, /resume and /fork replace the
	// runtime and the next session_start stamps again; clearing here would blank
	// the dot for the moment in between. The chain is awaited, briefly, because
	// pi tears the runtime down once this returns and a stamp still queued would
	// never run: `clear` is also what records the exit as deliberate, so the
	// session watcher does not report the session's disappearance as a death.
	pi.on("session_shutdown", async (event, ctx) => {
		try {
			if (!lobby(ctx)) return;
			postUsage(ctx);
			if (event?.reason === "quit") {
				stamp("clear");
				setOption("@tl_pi_model", "");
				setOption("@tl_pi_thinking", "");
				setOption("@tl_pi_levels", "");
			}
			await Promise.race([chain, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
		} catch {
			// silent
		}
	});
}

// sessionTotals adds up a conversation's usage the way pi's own session
// statistics do (AgentSession.getSessionStats): every assistant message, every
// tool result that carries usage, every `usage` entry (cache warming and the
// like), and the usage of compaction and branch summaries. All entries count,
// including history that was compacted away or left on another branch, because
// all of it was billed.
export function sessionTotals(entries) {
	const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const add = (u) => {
		if (!u || typeof u !== "object") return;
		t.input += count(u.input);
		t.output += count(u.output);
		t.cacheRead += count(u.cacheRead);
		t.cacheWrite += count(u.cacheWrite);
		t.cost += money(u.cost && u.cost.total);
	};
	for (const e of Array.isArray(entries) ? entries : []) {
		if (!e || typeof e !== "object") continue;
		if (e.type === "usage") {
			add(e.usage);
		} else if (e.type === "compaction" || e.type === "branch_summary") {
			add(e.usage);
		} else if (e.type === "message" && e.message) {
			if (e.message.role === "assistant") add(e.message.usage);
			else if (e.message.role === "toolResult") add(e.message.usage);
		}
	}
	return t;
}

function count(n) {
	return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function money(n) {
	return Number.isFinite(n) && n > 0 ? n : 0;
}

// round keeps a sum of floats from reading 0.41250000000000003 on the pane.
function round(n) {
	return Math.round(n * 1e6) / 1e6;
}

// supportedLevels is the thinking levels a model offers, from pi-ai's own
// getSupportedThinkingLevels when the module resolves, and from the same rule
// written out when it does not: a model without reasoning has only `off`, a
// level its thinkingLevelMap maps to null is not offered, and xhigh and max
// exist only where the map names them.
let piAi;
export async function supportedLevels(model) {
	if (piAi === undefined) {
		try {
			piAi = await import("@earendil-works/pi-ai");
		} catch {
			piAi = null;
		}
	}
	try {
		if (piAi && typeof piAi.getSupportedThinkingLevels === "function") {
			const levels = piAi.getSupportedThinkingLevels(model);
			if (Array.isArray(levels) && levels.length > 0) return levels.filter((l) => LEVELS.includes(l));
		}
	} catch {
		// fall through to the written-out rule
	}
	if (!model || !model.reasoning) return ["off"];
	const map = model.thinkingLevelMap || {};
	return LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

// postJSON sends one body and ignores the answer. node:http rather than fetch,
// because pi may install a global proxy dispatcher for its own traffic, and a
// post to this machine's loopback must not leave through it.
function postJSON(url, body) {
	return new Promise((resolve) => {
		try {
			const u = new URL(url);
			const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
			if (!lib) return resolve();
			const data = Buffer.from(JSON.stringify(body));
			const req = lib.request(
				u,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "Content-Length": data.length },
					timeout: POST_TIMEOUT_MS,
				},
				(res) => {
					res.resume();
					res.on("end", resolve);
					res.on("error", resolve);
				},
			);
			req.on("timeout", () => req.destroy());
			req.on("error", () => resolve());
			req.end(data);
		} catch {
			resolve();
		}
	});
}
