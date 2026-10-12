/**
 * "Let the AI decide": one-shot model judgment of a gated tool call.
 *
 * Uses the session's current model through the extension context's model
 * registry. Any failure (no model, auth, unparsable answer) denies the call:
 * the gate must fail closed.
 */

import type { PermissionCallInfo, PermissionOutcome } from "./permission-types.ts";

/** Minimal structural view of the pieces of ctx the judge needs. */
export type JudgeModelRegistry = {
	complete(
		model: unknown,
		context: { system: string; messages: Array<{ role: "user"; content: string }> },
		options?: { signal?: AbortSignal },
	): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const SYSTEM_PROMPT = [
	"You are the permission gate of a coding agent running in a user's repository.",
	"Decide whether the tool call below is safe to run.",
	"Benign calls (reading files, listing, building, testing, editing project sources) are allowed.",
	"Destructive or risky calls (deleting data outside build artifacts, force-pushing, installing",
	"untrusted code, touching credentials, curling secrets into shell history) are denied.",
	'Answer with exactly one JSON object: {"allow": true|false, "reason": "short explanation"}',
].join("\n");

function parseVerdict(text: string): { allow: boolean; reason: string } | undefined {
	const stripped = text.replace(/```(?:json)?/g, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
		if (parsed && typeof parsed === "object" && typeof (parsed as { allow?: unknown }).allow === "boolean") {
			const record = parsed as { allow: boolean; reason?: unknown };
			return { allow: record.allow, reason: typeof record.reason === "string" ? record.reason : "" };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Judge one call. Never throws; failures deny. */
export async function judgeWithModel(
	info: PermissionCallInfo,
	model: unknown,
	registry: JudgeModelRegistry | undefined,
	options?: { cwd?: string; signal?: AbortSignal },
): Promise<PermissionOutcome> {
	if (!model || !registry) {
		return { action: "deny", reason: "AI decision unavailable (no model); denied by default" };
	}
	try {
		const response = await registry.complete(
			model,
			{
				system: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `cwd: ${options?.cwd ?? "(unknown)"}\ntool: ${info.toolName}\narguments: ${JSON.stringify(info.args)}`,
					},
				],
			},
			{ signal: options?.signal },
		);
		const text = (response.content ?? [])
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text ?? "")
			.join("");
		const verdict = parseVerdict(text);
		if (!verdict) {
			return { action: "deny", reason: "AI decision could not be parsed; denied by default" };
		}
		if (verdict.allow) return { action: "allow" };
		return {
			action: "deny",
			reason: `AI decision: denied this ${info.toolName} call${verdict.reason ? ` (${verdict.reason})` : ""}`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { action: "deny", reason: `AI decision failed (${message}); denied by default` };
	}
}
