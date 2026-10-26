import type { AnyModel, Api, Model, ModelsStoreEntry, Provider, RefreshModelsContext } from "@nanopi/pi-ai";
import { describe, expect, it } from "vitest";
import { modelsFromListing, withLiveCatalog } from "../src/core/live-catalog-provider.ts";

function model(id: string, extra: Partial<Record<string, unknown>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...extra,
	} as Model<Api>;
}

function provider(): Provider {
	const baseline = [model("deepseek-v4-pro"), model("deepseek-v4-flash")];
	const unreachable = (): never => {
		throw new Error("the live catalog test never streams");
	};
	return {
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		auth: { apiKey: { env: { vars: ["DEEPSEEK_API_KEY"] } } },
		getModels: () => baseline,
		stream: unreachable,
		streamSimple: unreachable,
	} as unknown as Provider;
}

function context(overrides: Partial<RefreshModelsContext> = {}): {
	context: RefreshModelsContext;
	state: { models: readonly AnyModel[] | undefined; persisted: ModelsStoreEntry | undefined };
} {
	const state: { models: readonly AnyModel[] | undefined; persisted: ModelsStoreEntry | undefined } = {
		models: undefined,
		persisted: undefined,
	};
	return {
		state,
		context: {
			allowNetwork: true,
			signal: new AbortController().signal,
			baseUrl: "https://api.deepseek.com",
			credential: { type: "api_key", key: "sk-test" },
			publish: async (publication) => {
				publication.update?.();
				if (publication.persist) state.persisted = publication.persist;
				return true;
			},
			...overrides,
		},
	};
}

describe("modelsFromListing", () => {
	it("keeps the baseline metadata of an id the snapshot knows", () => {
		const baseline = [model("deepseek-v4-pro", { contextWindow: 65_000 })];
		const [listed] = modelsFromListing(baseline, [{ id: "deepseek-v4-pro" }]);
		expect((listed as Model<Api> | undefined)?.contextWindow).toBe(65_000);
	});

	it("gives an id the snapshot misses the baseline shape", () => {
		const [listed] = modelsFromListing([model("deepseek-v4-pro")], [{ id: "deepseek-chat", name: "DeepSeek Chat" }]);
		expect(listed).toMatchObject({
			id: "deepseek-chat",
			name: "DeepSeek Chat",
			provider: "deepseek",
			api: "openai-completions",
		});
	});
});

describe("withLiveCatalog", () => {
	it("replaces the packaged catalog with what the endpoint lists", async () => {
		const wrapped = withLiveCatalog(provider());
		const fetchMock = async () =>
			new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }), {
				status: 200,
			});
		const original = globalThis.fetch;
		globalThis.fetch = fetchMock as typeof fetch;
		try {
			const { context: ctx, state } = context();
			await wrapped.refreshModels?.(ctx);
			expect(state.persisted).toBeUndefined();
		} finally {
			globalThis.fetch = original;
		}
		expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
	});

	it("keeps the packaged catalog when the endpoint rejects the key", async () => {
		const wrapped = withLiveCatalog(provider());
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
		try {
			const { context: ctx } = context();
			await wrapped.refreshModels?.(ctx);
		} finally {
			globalThis.fetch = original;
		}
		expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
	});

	it("restores a previous overlay from the store before asking again", async () => {
		const wrapped = withLiveCatalog(provider());
		const stored: ModelsStoreEntry = { models: [model("deepseek-chat")], checkedAt: Date.now() };
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("should not be reached inside the freshness window");
		}) as typeof fetch;
		try {
			const { context: ctx } = context({ stored });
			await wrapped.refreshModels?.(ctx);
		} finally {
			globalThis.fetch = original;
		}
		expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["deepseek-chat"]);
	});
});
