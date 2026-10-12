/** Data types for the permission gate; separate from the gate logic for testability. */

/** A gated tool call about to prompt. */
export interface PermissionCallInfo {
	/** Tool call id (used to match answers). */
	callId: string;
	toolName: string;
	/** Short human-readable description shown in the prompt/card. */
	summary: string;
	/** Raw tool arguments (for the webui card and the model judge). */
	args: unknown;
	/** First shell word for shell tools; keys the AI-decide class. */
	firstCommand?: string;
}

/** Result of gating one call. */
export type PermissionOutcome = { action: "allow" } | { action: "deny"; reason: string };
