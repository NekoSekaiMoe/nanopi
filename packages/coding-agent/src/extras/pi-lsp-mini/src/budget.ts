/**
 * One deadline shared by a whole operation (a call-graph walk, a directory
 * scan) instead of one deadline per request.
 *
 * Problem: `depth=3` on a wide call graph is dozens of sequential requests. A
 * per-request deadline of 30s is then a 15-minute ceiling on the tool call, and
 * every request that expires leaves work running on the server. Per-request
 * timeouts cannot express "this tool call gets 30s, all of it, however it is
 * split".
 *
 * So the first request gets the time it needs (up to `timeoutMs`), and every
 * later one gets only what is left. When the budget is gone, the requests stop
 * and the caller says so, instead of the walk running quietly for minutes.
 */
export interface Budget {
	/** Time left for the next request; undefined means "no overall limit". */
	readonly remainingMs: number | undefined;
	/** Aborts when the shared deadline expires; pass to a request to cancel it. */
	readonly signal: AbortSignal | undefined;
	readonly timeoutMs: number | undefined;
	/** True once the shared deadline has passed. */
	readonly expired: boolean;
}

export interface BudgetOptions {
	/** Per-call `timeoutMs` from the tool parameters. */
	timeoutMs?: number;
	/** What a single request would get anyway (server `requestTimeout`). */
	defaultTimeoutMs: number;
	/** The tool call's own abort signal. */
	signal?: AbortSignal;
}

export function createBudget(options: BudgetOptions): Budget {
	const total = options.timeoutMs ?? options.defaultTimeoutMs;
	const controller = options.timeoutMs === undefined ? undefined : new AbortController();
	const timer = controller ? setTimeout(() => controller.abort(), total) : undefined;
	timer?.unref?.();
	options.signal?.addEventListener("abort", () => controller?.abort(), { once: true });
	const started = Date.now();
	// `remainingMs` is a whole number of milliseconds, so a caller that is one
	// millisecond into the budget reads `total - 1`. The first request would
	// then be armed with 299ms while the budget's own timer still fires at
	// 300ms, and the deadline that ends it reports 299ms — a number the caller
	// never asked for. Flooring the elapsed time keeps the first request at the
	// full budget; every later request only loses the whole milliseconds that
	// actually passed.
	let readAt = started;
	const elapsed = () => {
		readAt = Math.max(readAt, Date.now());
		return Math.floor(readAt - started);
	};

	return {
		timeoutMs: options.timeoutMs,
		signal: controller?.signal,
		get remainingMs(): number | undefined {
			if (options.timeoutMs === undefined) return undefined;
			return Math.max(0, total - elapsed());
		},
		get expired(): boolean {
			return this.remainingMs !== undefined && this.remainingMs <= 0;
		},
	};
}
