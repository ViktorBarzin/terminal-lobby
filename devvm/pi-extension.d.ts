// Types for devvm/pi-extension.js, so frontend-v2's tests can import it with
// allowJs off. Only what the tests touch is described; pi's own API types live
// in @earendil-works/pi-coding-agent, which this repository does not install.

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ThinkingModel {
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null | undefined>;
}

export function sessionTotals(entries: unknown): UsageTotals;
export function supportedLevels(model: ThinkingModel | undefined): Promise<string[]>;

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

// The slice of pi's ExtensionAPI the extension calls.
export interface PiApi {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult>;
	setModel(model: unknown): Promise<boolean>;
	getThinkingLevel(): string;
	setThinkingLevel(level: string): void;
}

export default function terminalLobby(pi: PiApi): void;
