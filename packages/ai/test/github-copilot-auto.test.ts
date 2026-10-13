import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCopilotAutoRouterDecision, fetchCopilotAutoSession } from "../src/providers/github-copilot-auto.ts";

const neverAbortedSignal = new AbortController().signal;
const copilotBase = "https://api.individual.githubcopilot.com";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function stubAutoFetch(handler: (url: string, init: RequestInit) => Response) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		return handler(getUrl(input), init ?? {});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchCopilotAutoSession", () => {
	it("parses the session response", async () => {
		const fetchMock = stubAutoFetch((url, init) => {
			expect(url).toBe(`${copilotBase}/models/session`);
			expect(init.method).toBe("POST");
			expect(JSON.parse(String(init.body))).toEqual({ auto_mode: { model_hints: ["auto"] } });
			const headers = new Headers(init.headers);
			expect(headers.get("Authorization")).toBe("Bearer copilot-token");
			expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
			return jsonResponse({
				session_token: "session-token",
				expires_at: 4102444800,
				available_models: ["claude-haiku-4.5", "gpt-5.4"],
				selected_model: "claude-haiku-4.5",
			});
		});
		const session = await fetchCopilotAutoSession(copilotBase, "copilot-token", { signal: neverAbortedSignal });
		expect(session).toEqual({
			sessionToken: "session-token",
			expiresAt: 4102444800 * 1000,
			availableModelIds: ["claude-haiku-4.5", "gpt-5.4"],
			selectedModelId: "claude-haiku-4.5",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("accepts an object selected_model dialect and a missing expiry", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		stubAutoFetch(() =>
			jsonResponse({
				session_token: "session-token",
				available_models: ["gpt-5.4", 42, "gpt-5-mini"],
				selected_model: { id: "gpt-5-mini" },
			}),
		);
		try {
			const session = await fetchCopilotAutoSession(copilotBase, "copilot-token", { signal: neverAbortedSignal });
			expect(session.availableModelIds).toEqual(["gpt-5.4", "gpt-5-mini"]);
			expect(session.selectedModelId).toBe("gpt-5-mini");
			expect(session.expiresAt).toBe(1_000_000 + 30 * 60_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects on HTTP errors with the response body", async () => {
		stubAutoFetch(() => new Response("no auto for you", { status: 403, statusText: "Forbidden" }));
		await expect(
			fetchCopilotAutoSession(copilotBase, "copilot-token", { signal: neverAbortedSignal }),
		).rejects.toThrow("Copilot Auto session request failed with HTTP 403 Forbidden: no auto for you");
	});

	it("rejects invalid payloads", async () => {
		stubAutoFetch(() => jsonResponse({ available_models: ["gpt-5.4"] }));
		await expect(
			fetchCopilotAutoSession(copilotBase, "copilot-token", { signal: neverAbortedSignal }),
		).rejects.toThrow("invalid session response");
	});

	it("propagates caller aborts", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			fetchCopilotAutoSession(copilotBase, "copilot-token", { signal: controller.signal }),
		).rejects.toThrow();
	});
});

describe("fetchCopilotAutoRouterDecision", () => {
	it("posts the prompt facts and parses the decision", async () => {
		const fetchMock = stubAutoFetch((url, init) => {
			expect(url).toBe(`${copilotBase}/models/session/intent`);
			const headers = new Headers(init.headers);
			expect(headers.get("Copilot-Session-Token")).toBe("session-token");
			expect(JSON.parse(String(init.body))).toEqual({
				prompt: "refactor this file",
				available_models: ["gpt-5.4", "claude-haiku-4.5"],
				previous_model: "gpt-5.4",
				turn_number: 2,
				reference_count: 0,
				prompt_char_count: 18,
			});
			return jsonResponse({ chosen_model: "claude-haiku-4.5", candidate_models: ["gpt-5.4"] });
		});
		const decision = await fetchCopilotAutoRouterDecision(
			copilotBase,
			"copilot-token",
			"session-token",
			{
				prompt: "refactor this file",
				availableModelIds: ["gpt-5.4", "claude-haiku-4.5"],
				previousModelId: "gpt-5.4",
				turnNumber: 2,
				referenceCount: 0,
			},
			{ signal: neverAbortedSignal },
		);
		expect(decision).toEqual({ chosenModelId: "claude-haiku-4.5", candidateModelIds: ["gpt-5.4"] });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("accepts the selected_model dialect", async () => {
		stubAutoFetch(() => jsonResponse({ selected_model: "gpt-5.4" }));
		const decision = await fetchCopilotAutoRouterDecision(
			copilotBase,
			"copilot-token",
			"session-token",
			{ prompt: "hi", availableModelIds: ["gpt-5.4"] },
			{ signal: neverAbortedSignal },
		);
		expect(decision).toEqual({ chosenModelId: "gpt-5.4", candidateModelIds: [] });
	});

	it("resolves undefined on HTTP errors and empty decisions", async () => {
		stubAutoFetch(() => new Response("throttled", { status: 429 }));
		expect(
			await fetchCopilotAutoRouterDecision(
				copilotBase,
				"copilot-token",
				"session-token",
				{ prompt: "hi", availableModelIds: ["gpt-5.4"] },
				{ signal: neverAbortedSignal },
			),
		).toBeUndefined();

		stubAutoFetch(() => jsonResponse({ confidence: 0.2 }));
		expect(
			await fetchCopilotAutoRouterDecision(
				copilotBase,
				"copilot-token",
				"session-token",
				{ prompt: "hi", availableModelIds: ["gpt-5.4"] },
				{ signal: neverAbortedSignal },
			),
		).toBeUndefined();
	});

	it("propagates caller aborts", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			fetchCopilotAutoRouterDecision(
				copilotBase,
				"copilot-token",
				"session-token",
				{ prompt: "hi", availableModelIds: ["gpt-5.4"] },
				{ signal: controller.signal },
			),
		).rejects.toThrow();
	});
});
