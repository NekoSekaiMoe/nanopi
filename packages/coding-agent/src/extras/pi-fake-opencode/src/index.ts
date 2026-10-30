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
 * The gate checks three things and all must hold (re-checked against
 * opencode2api's captures of a live client; experiment log in README):
 *
 *   1. The User-Agent and x-opencode-* identity headers of the lane the base
 *      URL belongs to (see headers.ts).
 *   2. Well-formed opencode ids: DESCENDING `ses_` session ids and ASCENDING
 *      `msg_` request ids (see headers.ts).
 *   3. An agent-shaped body: the official CLI system prompt at the head of the
 *      system slot, the official tool definitions in the tool list, the
 *      CLI's streaming fields (see payload.ts, one shape per wire protocol).
 *
 * Identity headers set here (mirroring the official CLI's request path):
 *
 *   User-Agent:            opencode/latest/2.1.1/cli   (v2)
 *                          opencode/1.19.3 ai-sdk/… runtime/bun/…  (v1)
 *   x-opencode-session-id: ses_…  (stable per session, descending id)
 *   x-opencode-session:    same value
 *   x-opencode-request:    msg_…  (one per user turn, ascending id)
 *   x-opencode-client:     cli (honors $OPENCODE_CLIENT)
 *   x-opencode-project:    40-hex git commit id
 *
 * Authorization, the endpoint, and every other header stay exactly as nanopi /
 * pi-ai configured them — including pi's own auth, so `OPENCODE_API_KEY` works
 * as usual.
 *
 * Scope: requests whose provider is `opencode` / `opencode-go`, whose base URL
 * contains `opencode.ai`, whose provider id is listed in
 * `PI_FAKE_OPENCODE_PROVIDERS`, or any request when `PI_FAKE_OPENCODE_ALL` is
 * set. Body shaping covers the four chat protocols the gate inspects; System
 * One decision payloads are not agent traffic and are left alone.
 */

import type { ModuleApi } from "@nanopi/pi-coding-agent";
import {
	buildClient,
	buildProjectId,
	buildRequestId,
	buildSessionId,
	buildUserAgent,
	isV2InferenceBaseUrl,
	laneForBaseUrl,
	shouldSpoof,
	userTurnFingerprint,
} from "./headers.ts";
import { type GatewayApi, shapeForGateway } from "./payload.ts";

const SHAPED_APIS = new Set<string>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

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
		const lane = laneForBaseUrl(ctx.model?.baseUrl);
		const session = buildSessionId(ctx.sessionManager.getSessionId());
		event.headers["User-Agent"] = buildUserAgent(lane);
		event.headers["x-opencode-session-id"] = session;
		event.headers["x-opencode-session"] = session;
		event.headers["x-opencode-request"] = buildRequestId(
			session,
			userTurnFingerprint(lastBodies.get(ctx.sessionManager.getSessionId())),
		);
		event.headers["x-opencode-client"] = buildClient();
		event.headers["x-opencode-project"] = buildProjectId(ctx.cwd);
	});

	// Body shaping: the gate only accepts an official-looking agent request, in
	// the shape of the protocol the model is wired to.
	pi.on("before_provider_request", (event, ctx) => {
		if (!shouldSpoof(ctx.model?.provider, ctx.model?.baseUrl)) return;
		const model = ctx.model;
		if (!model?.api || !SHAPED_APIS.has(model.api)) return;

		lastBodies.set(ctx.sessionManager.getSessionId(), event.payload);
		shapeForGateway(event.payload, model.api as GatewayApi, {
			modelId: model.id,
			cwd: ctx.cwd,
			lane: laneForBaseUrl(model.baseUrl),
		});
	});
}
