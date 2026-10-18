/**
 * Structured-input broker: the ask-lite questionnaire, surfaced to the webui.
 *
 * The tool renders itself with `ctx.ui.custom()` in the TUI, which the webui
 * (a headless session, no dialog-capable UI) cannot do — so in a webui session
 * every ask_user_question call used to fail with "UI not available". The webui
 * already ships a card for exactly this payload (the webui UserInputCard,
 * fed by `user_input_request` SSE and answered at `/chat/user-input`); only the
 * daemon-side half was missing.
 *
 * Same shape as PermissionBroker: one outstanding request, answers matched by
 * request id, session shutdown drops the queue.
 */

/** One question, in the webui's wire shape (see UserInputQuestion in api.ts). */
export interface AskBrokerQuestion {
	header: string;
	question: string;
	mode: "single" | "multiple" | "text";
	options: Array<{ label: string; description?: string }>;
	custom?: boolean;
}

/** One answer body, in the webui's wire shape (see UserInputResponseBody). */
export interface AskBrokerAnswer {
	declined: boolean;
	selected: string[];
	text: string | null;
}

/** `responses` for a batch request, or a single flat answer. */
export type AskBrokerResolution =
	| { type: "single"; answer: AskBrokerAnswer }
	| { type: "batch"; answers: AskBrokerAnswer[] };

export type AskBrokerEvent =
	| { type: "prompt"; requestId: number; questions: AskBrokerQuestion[] }
	| { type: "resolved"; requestId: number };

interface BrokerEntry {
	requestId: number;
	questions: AskBrokerQuestion[];
	resolve: (resolution: AskBrokerResolution | undefined) => void;
}

export class AskBroker {
	private nextRequestId = 1;
	private queue: BrokerEntry[] = [];
	private active: BrokerEntry | undefined;
	private readonly listeners = new Set<(event: AskBrokerEvent) => void>();

	subscribe(listener: (event: AskBrokerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Ask the webui and wait. Resolves undefined when the request is dropped
	 * (session shutdown) or answered with a `declined` payload.
	 */
	ask(questions: AskBrokerQuestion[]): Promise<AskBrokerResolution | undefined> {
		if (questions.length === 0) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			this.queue.push({ requestId: this.nextRequestId++, questions, resolve });
			this.pump();
		});
	}

	private pump(): void {
		if (this.active) return;
		this.active = this.queue.shift();
		if (!this.active) return;
		this.emit({ type: "prompt", requestId: this.active.requestId, questions: this.active.questions });
	}

	/** Answer the outstanding request. Returns false when the id does not match. */
	answer(requestId: number, resolution: AskBrokerResolution): boolean {
		const active = this.active;
		if (!active || active.requestId !== requestId) return false;
		this.active = undefined;
		this.emit({ type: "resolved", requestId });
		active.resolve(resolution);
		this.pump();
		return true;
	}

	/** Drop every pending request (session shutdown, abort). */
	cancelAll(): void {
		const all = this.active ? [this.active, ...this.queue] : [...this.queue];
		this.active = undefined;
		this.queue = [];
		for (const entry of all) {
			this.emit({ type: "resolved", requestId: entry.requestId });
			entry.resolve(undefined);
		}
	}

	private emit(event: AskBrokerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
