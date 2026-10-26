/**
 * Per-call permission gating (non-yolo, non-plan sessions).
 *
 * Five answers per prompt: allow once, allow this session (per tool), allow the
 * call that was asked about after reading an explanation of it, reject, or let
 * the model decide. "Let the model decide" keys the class by
 * tool + first shell command and caches one verdict per class for the rest of
 * the session: the class never prompts again.
 *
 * `allow_once` is the answer to the prompt the user sees after reading an
 * explanation: this call runs, the gate keeps no memory of it, and the next call
 * of the same kind asks again. `deny` is single-shot too — nothing is remembered
 * about a refusal — while `ai_decide` covers the whole class for the session.
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

/** The same prompt, for a UI that can also answer `"explain"` (see `PermissionGate.explain`). */
export type PermissionExplanationPrompter = (
	info: PermissionCallInfo,
) => Promise<PermissionDecision | "explain" | undefined>;

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
	/** Calls whose prompt already led to an explanation. */
	private readonly explainedCalls = new Set<string>();
	private readonly prompter: PermissionPrompter;
	/** Prompter that may also answer `"explain"` (webui); see `explain()`. */
	private readonly explanationPrompter: PermissionExplanationPrompter | undefined;
	private readonly judge: PermissionJudge;

	constructor(
		prompter: PermissionPrompter,
		judge: PermissionJudge,
		explanationPrompter?: PermissionExplanationPrompter,
	) {
		this.prompter = prompter;
		this.judge = judge;
		this.explanationPrompter = explanationPrompter;
	}

	/** Whether the UI can ask for an explanation, which is what makes `explain()` useful. */
	get canExplain(): boolean {
		return this.explanationPrompter !== undefined;
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

	/**
	 * Pause a call for an explanation, keeping the call itself pending.
	 *
	 * Returns the answer to the prompt afterwards, so the caller can ask again for
	 * a UI whose answer may be "explain" — that answer arrives, nothing runs, and
	 * the same call asks once more when the user has read the explanation. Only
	 * one pause per call: a second "explain" for the same callId is refused, which
	 * keeps two explanation turns from stacking on one blocked call.
	 */
	async explain(info: PermissionCallInfo): Promise<PermissionOutcome | undefined> {
		const prompter = this.explanationPrompter;
		if (!prompter) return undefined;
		// Claimed before the wait so a second pause cannot start while this one
		// is in flight.
		if (!this.explainedCalls.add(info.callId)) return undefined;
		const decision = await prompter(info);
		if (decision === "explain") {
			// Nothing ran: the call still waits for its answer, and the same call
			// may be paused again after the user reads the explanation.
			this.explainedCalls.delete(info.callId);
			return undefined;
		}
		if (this.approvedCalls.delete(info.callId)) return { action: "allow" };
		switch (decision) {
			case "allow_once":
			case "allow":
				return { action: "allow" };
			case "allow_session":
				this.sessionAllowedTools.add(info.toolName);
				return { action: "allow" };
			case "ai_decide": {
				const verdict = await this.judge(info);
				this.judgedClasses.set(classKey(info), verdict);
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
			// `allow_once` is the same outcome as `allow` — run this call, remember
			// nothing — and stays a separate answer because the flow offers it after
			// an explanation, where "once" is what the user just agreed to.
			case "allow_once":
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
	/** The user asked for an explanation of the outstanding prompt. */
	| { type: "explain"; info: PermissionCallInfo }
	| { type: "resolved"; callId: string; decision: PermissionDecision | undefined };

interface BrokerEntry {
	info: PermissionCallInfo;
	/** Ordinary answer path: the gate settles the call with it. */
	resolve: (decision: PermissionDecision | undefined) => void;
	/** Explanation path: the card's answer, delivered to `explanationPrompter`. */
	resolveChoice: (answer: PermissionPromptAnswer | undefined) => void;
	explanationGranted?: boolean;
}

/** Answers a card can send: the decisions, or `"explain"` for a pause. */
export type PermissionPromptAnswer = PermissionDecision | "explain";

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
			this.queue.push({ info, resolve, resolveChoice: () => {} });
			this.pump();
		});

	/**
	 * Prompter behind the gate's `explain()`: resolves with the card's next
	 * answer, which may be `"explain"`. The entry stays active across the
	 * explanation turn, so the card keeps waiting for its real answer, and that
	 * answer lands here.
	 */
	readonly explanationPrompter: PermissionExplanationPrompter = (info) =>
		new Promise((resolve) => {
			const active = this.active;
			if (!active || active.info.callId !== info.callId) {
				resolve(undefined);
				return;
			}
			active.resolveChoice = resolve;
		});

	private pump(): void {
		if (this.active || this.queue.length === 0) return;
		this.active = this.queue.shift();
		if (!this.active) return;
		this.emit({ type: "prompt", info: this.active.info });
	}

	/**
	 * Answer the outstanding prompt. Returns false when nothing matches.
	 *
	 * `"explain"` does not settle the prompt: it flags the entry and emits
	 * `explain`, so the listener can hand the card over to the explanation while
	 * the call stays gated.
	 */
	answer(callId: string | undefined, toolName: string | undefined, decision: PermissionPromptAnswer): boolean {
		const active = this.active;
		if (!active) return false;
		if (callId !== undefined && active.info.callId !== callId) return false;
		if (callId === undefined && toolName !== undefined && active.info.toolName !== toolName) return false;
		if (decision === "explain") {
			// One explanation per prompt: asking twice would stack two turns on the
			// same blocked call.
			if (active.explanationGranted) return false;
			active.explanationGranted = true;
			// The gate is parked on this prompt and learns "explain" here; a prompt
			// nobody is waiting on has no one to explain to.
			const paused = active.resolveChoice;
			active.resolveChoice = () => {};
			this.emit({ type: "explain", info: active.info });
			paused(decision);
			return true;
		}
		this.active = undefined;
		this.emit({ type: "resolved", callId: active.info.callId, decision });
		active.resolve(decision);
		// The explanation path delivers the real answer to `explanationPrompter`.
		active.resolveChoice(decision);
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
			entry.resolveChoice(undefined);
		}
	}

	private emit(event: PermissionBrokerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
