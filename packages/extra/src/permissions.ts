/**
 * Per-call permission gating (non-yolo, non-plan sessions).
 *
 * Five answers per prompt: allow once, allow this session (per tool), allow the
 * call that was asked about after reading an explanation of it, reject, or let
 * the model decide. "Let the model decide" keys the class by
 * tool + first shell command and caches one verdict per class for the rest of
 * the session: the class never prompts again.
 *
 * `allow_once` is what the explanation flow answers with: the user has just been
 * told what the call does, so this one runs, but the gate keeps no memory of it
 * and the next call of the same kind asks again.
 *
 * A call that carries a hazard (`git reset --hard` in the current checkout) is
 * gated even in a session whose tool was allowed for good, and the hazard is
 * part of its class key: a model verdict on `bash::git` must not quietly cover it.
 */

import type { PermissionCallInfo, PermissionOutcome } from "./permission-types.ts";
import type { PermissionDecision } from "./types.ts";

export type { PermissionCallInfo, PermissionDecision, PermissionOutcome };

/** How the gate asks. Returns undefined when the prompt was dismissed or cannot be shown. */
export type PermissionPrompter = (info: PermissionCallInfo) => Promise<PermissionDecision | undefined>;

/** Model-side judgment injected into the gate (see ai-judge.ts). */
export type PermissionJudge = (info: PermissionCallInfo) => Promise<PermissionOutcome>;

export type JudgeVerdict = PermissionOutcome;

function classKey(info: PermissionCallInfo): string {
	const base = info.firstCommand ? `${info.toolName}::${info.firstCommand}` : info.toolName;
	return info.hazard ? `${base}::${info.hazard}` : base;
}

export class PermissionGate {
	private readonly sessionAllowedTools = new Set<string>();
	private readonly judgedClasses = new Map<string, JudgeVerdict>();
	/** Calls approved out-of-band through `approveOnce()`, consumed by `check()`. */
	private readonly approvedCalls = new Set<string>();
	private readonly prompter: PermissionPrompter;
	private readonly judge: PermissionJudge;

	constructor(prompter: PermissionPrompter, judge: PermissionJudge) {
		this.prompter = prompter;
		this.judge = judge;
	}

	/** Remember a session-wide allowance (used when the webui answers out-of-band). */
	allowToolForSession(toolName: string): void {
		this.sessionAllowedTools.add(toolName);
	}

	/**
	 * Run one call without remembering anything.
	 *
	 * The call arrives as a token so a stale approval cannot be replayed: `check()`
	 * deletes the token when it consumes it, and the tokens of calls that never
	 * reach the gate (the turn was interrupted, the model rerouted the call) are
	 * dropped on the way out of `check()`.
	 */
	approveOnce(callId: string): void {
		this.approvedCalls.add(callId);
	}

	async check(info: PermissionCallInfo): Promise<PermissionOutcome> {
		// Claim the approval before anything can ask: an approved call must not
		// prompt underneath a dialog the user already answered.
		if (this.approvedCalls.delete(info.callId)) return { action: "allow" };

		// A session-wide allowance covers the tool the user was shown, not a
		// command that would destroy work they did not have in mind.
		if (!info.hazard && this.sessionAllowedTools.has(info.toolName)) return { action: "allow" };

		const key = classKey(info);
		const judged = this.judgedClasses.get(key);
		if (judged) return judged;

		const decision = await this.prompter(info);
		// An approval for this call that arrived while the prompt was up (the user
		// read the explanation and continued) wins: no second prompt, no memory.
		if (this.approvedCalls.delete(info.callId)) return { action: "allow" };
		switch (decision) {
			case "allow":
				return { action: "allow" };
			case "allow_session":
				this.sessionAllowedTools.add(info.toolName);
				return { action: "allow" };
			case "ai_decide": {
				const verdict = await this.judge(info);
				this.judgedClasses.set(key, verdict);
				return verdict;
			}
			case "deny":
				return { action: "deny", reason: `The user declined this ${info.toolName} call` };
			default:
				return {
					action: "deny",
					reason: `The permission prompt for this ${info.toolName} call was dismissed`,
				};
		}
	}
}

// ============================================================================
// Webui bridge side: the broker queues prompts and matches answers.
// ============================================================================

export type PermissionBrokerEvent =
	| { type: "prompt"; info: PermissionCallInfo }
	| { type: "resolved"; callId: string; decision: PermissionDecision | undefined };

interface BrokerEntry {
	info: PermissionCallInfo;
	resolve: (decision: PermissionDecision | undefined) => void;
}

/**
 * Queue of permission prompts shared with the webui server (same process).
 * One prompt is outstanding at a time; answers arrive via POST /chat/permission.
 */
export class PermissionBroker {
	private queue: BrokerEntry[] = [];
	private active: BrokerEntry | undefined;
	private readonly listeners = new Set<(event: PermissionBrokerEvent) => void>();

	subscribe(listener: (event: PermissionBrokerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Prompter used by the gate when no interactive UI exists (webui sessions). */
	readonly prompter: PermissionPrompter = (info) =>
		new Promise((resolve) => {
			this.queue.push({ info, resolve });
			this.pump();
		});

	private pump(): void {
		if (this.active || this.queue.length === 0) return;
		this.active = this.queue.shift();
		if (!this.active) return;
		this.emit({ type: "prompt", info: this.active.info });
	}

	/** Answer the outstanding prompt. Returns false when nothing matches. */
	answer(callId: string | undefined, toolName: string | undefined, decision: PermissionDecision): boolean {
		const active = this.active;
		if (!active) return false;
		if (callId !== undefined && active.info.callId !== callId) return false;
		if (callId === undefined && toolName !== undefined && active.info.toolName !== toolName) return false;
		this.active = undefined;
		this.emit({ type: "resolved", callId: active.info.callId, decision });
		active.resolve(decision);
		this.pump();
		return true;
	}

	/** Drop every pending prompt (session shutdown, abort); resolves them as dismissed. */
	cancelAll(): void {
		const all = this.active ? [this.active, ...this.queue] : [...this.queue];
		this.active = undefined;
		this.queue = [];
		for (const entry of all) {
			this.emit({ type: "resolved", callId: entry.info.callId, decision: undefined });
			entry.resolve(undefined);
		}
	}

	private emit(event: PermissionBrokerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
