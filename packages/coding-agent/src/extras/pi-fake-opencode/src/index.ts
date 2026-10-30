/**
 * pi-fake-opencode — builtin module entry point
 *
 * Makes nanopi's requests to OpenCode Zen look like they come from the
 * official OpenCode client, which is what Zen's free tier requires
 * ("apiKey": "public" from any non-OpenCode app answers with):
 *
 *   Error: OpenAI API error (403):
 *   {"type":"FreeTierError","message":"Error from provider (Console):
 *    OpenCode's free tier can only be used from within OpenCode"}
 *
 * The gate checks three things and all must hold (verified against the live
 * gateway; experiment log in README):
 *
 *   1. Composite User-Agent `opencode/{v} ai-sdk/provider-utils/{v}
 *      runtime/bun/{v}` plus the x-opencode-* identity headers.
 *   2. Well-formed opencode ids: DESCENDING `ses_` session ids and ASCENDING
 *      `msg_` request ids (see headers.ts).
 *   3. An agent-shaped body: the official CLI system prompt at the head, the
 *      official tool definitions in the tool list, `stream: true`, and
 *      `max_completion_tokens` (see payload.ts).
 *
 * Identity headers set here (mirroring the official CLI's request path):
 *
 *   User-Agent:            opencode/{version} ai-sdk/provider-utils/{version} runtime/bun/{version}
 *   x-opencode-session-id: ses_…  (stable per session, descending id)
 *   x-opencode-session:    same value
 *   x-opencode-request:    msg_…  (one per user turn, ascending id)
 *   x-opencode-client:     cli (honors $OPENCODE_CLIENT)
 *   x-opencode-project:    40-hex git commit id
 *
 * Authorization, the endpoint, and every other header stay exactly as nanopi /
 * pi-ai configured them — including pi's own auth, so `/login opencode` or
 * `OPENCODE_API_KEY` work as usual.
 *
 * Scope: requests whose provider is `opencode` / `opencode-go`, whose base URL
 * contains `opencode.ai`, whose provider id is listed in
 * `PI_FAKE_OPENCODE_PROVIDERS`, or any request when `PI_FAKE_OPENCODE_ALL` is
 * set. Body shaping applies to OpenAI-completions payloads, the documented
 * free-tier path; other API shapes get the headers only.
 */

import type { ModuleApi } from "@nanopi/pi-coding-agent";
import {
	buildClient,
	buildProjectId,
	buildRequestId,
	buildSessionId,
	buildUserAgent,
	shouldSpoof,
	userTurnFingerprint,
} from "./headers.ts";
import { shapeForGateway } from "./payload.ts";

/**
 * The last body shaped for a spoofed request, keyed by session.
 *
 * Headers are assembled before the body (pi-ai builds the request after the
 * header transform runs), so the user-turn fingerprint the `x-opencode-request`
 * id needs is only available from the previous request of the same session.
 * An empty fingerprint reuses the session's latest id.
 */
const lastBodies = new Map<string, unknown>();

export default function (pi: ModuleApi): void {
	// Identity headers: fired after request headers are assembled and before the
	// HTTP call. Handlers mutate `headers` in place.
	pi.on("before_provider_headers", (event, ctx) => {
		if (!shouldSpoof(ctx.model?.provider, ctx.model?.baseUrl)) return;

		// Overwrite nanopi's identity with the official client's; leave every other
		// header (Authorization, content-type, …) alone.
		const session = buildSessionId(ctx.sessionManager.getSessionId());
		event.headers["User-Agent"] = buildUserAgent();
		event.headers["x-opencode-session-id"] = session;
		event.headers["x-opencode-session"] = session;
		event.headers["x-opencode-request"] = buildRequestId(
			session,
			userTurnFingerprint(lastBodies.get(ctx.sessionManager.getSessionId())),
		);
		event.headers["x-opencode-client"] = buildClient();
		event.headers["x-opencode-project"] = buildProjectId(ctx.cwd);
	});

	// Body shaping: the gate only accepts an official-looking agent request.
	pi.on("before_provider_request", (event, ctx) => {
		if (!shouldSpoof(ctx.model?.provider, ctx.model?.baseUrl)) return;
		if (ctx.model?.api !== "openai-completions") return;

		lastBodies.set(ctx.sessionManager.getSessionId(), event.payload);
		shapeForGateway(event.payload, { modelId: ctx.model.id, cwd: ctx.cwd });
	});
}
