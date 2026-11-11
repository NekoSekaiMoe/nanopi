import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@nanopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { isOpenCodeModel } from "../src/core/provider-attribution.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * Regression: OpenCode's session header went missing from requests that carried no attribution
 * of their own.
 *
 * `transformHeaders` output belongs to one request, while `ModelRuntime.prepareRequest` builds
 * the options a provider adapter sees. Attribution is merged there now, underneath the caller's
 * headers, so an adapter that assigns options headers over its own set keeps the block.
 */
describe("provider attribution headers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `nanopi-attribution-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		delete process.env.NANOPI_TELEMETRY;
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function createModel(provider: string, baseUrl: string): Model<Api> {
		return {
			id: `${provider}-test-model`,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function completedStream(model: Model<Api>) {
		const stream = createAssistantMessageEventStream();
		stream.end({
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as AssistantMessage);
		return stream;
	}

	/** The headers an OpenAI-family adapter puts on the wire: its own set, then the options'. */
	function createWireHeaders(options: SimpleStreamOptions | undefined): ProviderHeaders {
		const headers: ProviderHeaders = { "User-Agent": "nanopi/1.0" };
		Object.assign(headers, options?.headers);
		return headers;
	}

	async function captureWireHeaders(model: Model<Api>, requests: number): Promise<ProviderHeaders[]> {
		const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "test-api-key" } });
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		const headers: ProviderHeaders[] = [];

		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_model, _context, options) => {
				headers.push(createWireHeaders(options));
				return completedStream(model);
			},
		});

		const runtime = getModelRuntime(modelRegistry);
		const context = normalizeContext({ messages: [] });
		try {
			for (let index = 0; index < requests; index++) {
				await runtime.streamSimple(model, context, { sessionId: "attribution-session" }).result();
			}
			return headers;
		} finally {
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("sends OpenCode's session and client headers on every request", async () => {
		const model = createModel("opencode", "https://opencode.ai/inference/openai/v1");

		const headers = await captureWireHeaders(model, 2);

		expect(headers).toHaveLength(2);
		for (const request of headers) {
			expect(request["x-opencode-session"]).toBe("attribution-session");
			expect(request["x-opencode-client"]).toBe("nanopi");
		}
	});

	it("sends OpenRouter's attribution headers on every request", async () => {
		const model = createModel("openrouter", "https://openrouter.ai/api/v1");

		const headers = await captureWireHeaders(model, 2);

		for (const request of headers) {
			expect(request["HTTP-Referer"]).toBe("https://github.com/NekoSekaiMoe/nanopi");
			expect(request["X-OpenRouter-Title"]).toBe("nanopi");
			expect(request["X-OpenRouter-Categories"]).toBe("cli-agent");
		}
	});

	it("sends no identity headers once install telemetry is off", async () => {
		const model = createModel("opencode", "https://opencode.ai/inference/openai/v1");
		process.env.NANOPI_TELEMETRY = "0";

		const headers = await captureWireHeaders(model, 1);

		expect(headers[0]).toEqual({ "User-Agent": "nanopi/1.0" });
	});

	it("adds nothing for a provider that has no attribution", async () => {
		const model = createModel("local-proxy", "https://proxy.example/v1");

		const headers = await captureWireHeaders(model, 2);

		expect(headers[0]).toEqual({ "User-Agent": "nanopi/1.0" });
		expect(headers[1]).toEqual({ "User-Agent": "nanopi/1.0" });
	});
});

describe("isOpenCodeModel", () => {
	function model(provider: string, baseUrl: string): Model<Api> {
		return {
			id: "model",
			name: "Model",
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	it("recognises the built-in OpenCode providers", () => {
		expect(isOpenCodeModel(model("opencode", "https://opencode.ai/inference/openai/v1"))).toBe(true);
		expect(isOpenCodeModel(model("opencode-go", "https://opencode.ai/inference/go/openai/v1"))).toBe(true);
	});

	it("recognises a custom provider that points at the gateway", () => {
		expect(isOpenCodeModel(model("my-zen", "https://opencode.ai/zen/v1"))).toBe(true);
	});

	it("ignores a provider id that only mentions opencode", () => {
		expect(isOpenCodeModel(model("opencode-not-really", "https://example.test/v1"))).toBe(false);
	});
});
