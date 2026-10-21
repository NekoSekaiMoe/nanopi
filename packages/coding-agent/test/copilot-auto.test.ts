import { type Credential, InMemoryCredentialStore, InMemoryModelsStore, type Message, type Model } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CopilotAutoState, copilotAutoVirtualModel } from "../src/core/copilot-auto.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const copilotAccess = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";

function oauthCredential(availableModelIds: string[]): Credential {
	return {
		type: "oauth",
		refresh: "ghu_refresh",
		access: copilotAccess,
		expires: Date.now() + 60 * 60_000,
		availableModelIds,
	};
}

async function createRuntimeWithCredential(availableModelIds: string[]): Promise<ModelRuntime> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("github-copilot", async () => oauthCredential(availableModelIds));
	const runtime = await ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

function stubAutoFetch(handler: (url: string, init: RequestInit) => Response) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		return handler(url, init ?? {});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function sessionResponse(availableModels: string[], sessionToken = "session-token"): Response {
	return new Response(
		JSON.stringify({
			session_token: sessionToken,
			expires_at: 4102444800,
			available_models: availableModels,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function userMessage(content: Message["content"]): Message {
	return { role: "user", content, timestamp: Date.now() } as Message;
}

interface TestHostOptions {
	apiKey?: string;
	models?: Record<string, Pick<Model<string>, "input">>;
}

function testHost(options: TestHostOptions = {}) {
	return {
		getAuth: async () => ({
			auth: { apiKey: options.apiKey ?? "copilot-token", baseUrl: "https://api.copilot.test" },
		}),
		getModel: (_provider: string, id: string) => {
			const input = options.models?.[id]?.input;
			if (!input) return undefined;
			return {
				id,
				name: id,
				api: "openai-responses",
				provider: "github-copilot",
				baseUrl: "https://api.copilot.test",
				reasoning: false,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 64_000,
			} satisfies Model<string>;
		},
	};
}

function routeRequest(overrides: Partial<Parameters<ReturnType<typeof copilotAutoVirtualModel>["route"]>[0]> = {}) {
	const request = {
		model: { id: "auto", provider: "github-copilot" } as Model<string>,
		thinkingLevel: "off" as const,
		reason: "user" as const,
		messages: [userMessage("refactor the parser")],
		signal: new AbortController().signal,
		...overrides,
	};
	return request;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("github-copilot/auto availability", () => {
	it("stays available when the account catalog offers no picker models (Copilot Free)", async () => {
		const runtime = await createRuntimeWithCredential([]);
		const available = await runtime.getAvailable("github-copilot");
		expect(available.map((model) => model.id)).toEqual(["auto"]);
	});

	it("is listed alongside picker models for accounts that keep them", async () => {
		const runtime = await createRuntimeWithCredential(["gpt-5.6-luna", "claude-haiku-4.5"]);
		const available = await runtime.getAvailable("github-copilot");
		expect(available.map((model) => model.id).sort()).toEqual(["auto", "claude-haiku-4.5", "gpt-5.6-luna"]);
	});

	it("resolves through ModelRuntime with the session token headers", async () => {
		const runtime = await createRuntimeWithCredential([]);
		const auto = runtime.getModel("github-copilot", "auto");
		expect(auto).toMatchObject({ provider: "github-copilot", id: "auto", contextWindow: 128_000 });

		// The router needs a live Copilot session; verify it resolves without one only failing
		// on the network call, proving auth and catalog wiring.
		stubAutoFetch(() => sessionResponse(["gpt-5.6-luna"]));
		const route = await runtime.resolveModel(auto!, [userMessage("hello")], {
			reason: "user",
			thinkingLevel: "off",
		});
		expect(route.model.id).toBe("gpt-5.6-luna");
		expect(route.headers).toEqual({ "Copilot-Session-Token": "session-token" });
	});
});

describe("github-copilot/auto routing", () => {
	it("routes to the router's chosen model and records state", async () => {
		const host = testHost({
			models: {
				"gpt-5.6-luna": { input: ["text", "image"] },
				"claude-haiku-4.5": { input: ["text", "image"] },
			},
		});
		let intentCalls = 0;
		stubAutoFetch((url) => {
			if (url.endsWith("/models/session"))
				return sessionResponse(["gpt-5.6-luna", "claude-haiku-4.5", "unknown-model"]);
			if (url.endsWith("/models/session/intent")) {
				intentCalls++;
				return new Response(
					JSON.stringify({ chosen_model: "claude-haiku-4.5", candidate_models: ["gpt-5.6-luna"] }),
					{
						status: 200,
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const definition = copilotAutoVirtualModel(host);
		const route = await definition.route(routeRequest());
		expect(route.model.id).toBe("claude-haiku-4.5");
		expect(route.state).toEqual({ modelId: "claude-haiku-4.5" });
		expect(route.headers).toEqual({ "Copilot-Session-Token": "session-token" });
		expect(intentCalls).toBe(1);
	});

	it("keeps a valid sticky selection without consulting the router again", async () => {
		const host = testHost({
			models: {
				"gpt-5.6-luna": { input: ["text"] },
				"claude-haiku-4.5": { input: ["text"] },
			},
		});
		let intentCalls = 0;
		stubAutoFetch((url) => {
			if (url.endsWith("/models/session")) return sessionResponse(["gpt-5.6-luna", "claude-haiku-4.5"]);
			if (url.endsWith("/models/session/intent")) {
				intentCalls++;
				return new Response(JSON.stringify({}), { status: 200 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const definition = copilotAutoVirtualModel(host);
		const first = await definition.route(routeRequest());
		expect(first.model.id).toBe("gpt-5.6-luna"); // Router decision empty: first eligible model.

		const intentCallsAfterFirst = intentCalls;
		const second = await definition.route(
			routeRequest({ state: first.state as CopilotAutoState, reason: "continuation" }),
		);
		expect(second.model.id).toBe("gpt-5.6-luna");
		expect(intentCalls).toBe(intentCallsAfterFirst);
	});

	it("moves off the failed model on retry", async () => {
		const host = testHost({
			models: {
				"gpt-5.6-luna": { input: ["text"] },
				"claude-haiku-4.5": { input: ["text"] },
			},
		});
		stubAutoFetch((url) => {
			if (url.endsWith("/models/session")) return sessionResponse(["gpt-5.6-luna", "claude-haiku-4.5"]);
			if (url.endsWith("/models/session/intent")) {
				return new Response(
					JSON.stringify({ chosen_model: "gpt-5.6-luna", candidate_models: ["claude-haiku-4.5"] }),
					{
						status: 200,
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const definition = copilotAutoVirtualModel(host);
		const failed = { model: { ...host.getModel("github-copilot", "gpt-5.6-luna")! }, message: {} as never };
		const route = await definition.route(
			routeRequest({ state: { modelId: "gpt-5.6-luna" }, reason: "retry", failed }),
		);
		expect(route.model.id).toBe("claude-haiku-4.5");
	});

	it("requires a vision-capable model when the request has images", async () => {
		const host = testHost({
			models: {
				"gpt-5.6-luna": { input: ["text"] },
				"claude-haiku-4.5": { input: ["text", "image"] },
			},
		});
		let sessionModels: string[] = [];
		stubAutoFetch((url) => {
			if (url.endsWith("/models/session")) {
				sessionModels = ["gpt-5.6-luna", "claude-haiku-4.5"];
				return sessionResponse(sessionModels);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const definition = copilotAutoVirtualModel(host);
		const route = await definition.route(
			routeRequest({
				messages: [userMessage([{ type: "image", data: "aGk=", mimeType: "image/png" }])],
			}),
		);
		expect(route.model.id).toBe("claude-haiku-4.5");
		expect(route.model.input).toContain("image");
	});

	it("fails with an actionable error when the pool has no known models", async () => {
		const host = testHost({ models: {} });
		stubAutoFetch((url) => {
			if (url.endsWith("/models/session")) return sessionResponse(["mystery-model"]);
			throw new Error(`Unexpected URL: ${url}`);
		});
		const definition = copilotAutoVirtualModel(host);
		await expect(definition.route(routeRequest())).rejects.toThrow(/no models known to this catalog/);
	});

	it("fails when the provider has no credential", async () => {
		const host = {
			getAuth: async () => undefined,
			getModel: (_provider: string, _id: string) => undefined,
		};
		const definition = copilotAutoVirtualModel(host);
		await expect(definition.route(routeRequest())).rejects.toThrow(/not authenticated/);
	});
});
