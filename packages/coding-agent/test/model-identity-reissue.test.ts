import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@nanopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

function assistantMessages(messages: ReadonlyArray<{ role: string }>) {
	return messages.filter((message) => message.role === "assistant");
}

describe("silent model-identity check", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "nanopi-model-identity-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createModel(): Model<Api> {
		return {
			id: "requested-model",
			name: "Requested Model",
			api: "openai-completions",
			provider: "relay",
			baseUrl: "https://relay.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "relay",
			model: "requested-model",
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
		};
	}

	/**
	 * A relay that answers the first `substitutedResponses` requests with another model's echo
	 * header, then answers on the requested model.
	 */
	async function runSession(substitutedResponses: number) {
		const model = createModel();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let requests = 0;
		const requestedIds: string[] = [];
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (requestModel, _context, options: SimpleStreamOptions | undefined) => {
				const substituted = requests < substitutedResponses;
				requests++;
				requestedIds.push(requestModel.id);
				const stream = createAssistantMessageEventStream();
				void (async () => {
					await options?.onResponse?.(
						{
							status: 200,
							headers: { "x-request-id": "req", "x-model": substituted ? "other-model" : requestModel.id },
						},
						requestModel,
					);
					stream.end(createDoneMessage());
				})();
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({}),
			sessionManager,
		});
		return {
			session,
			requests: () => requests,
			requestedIds: () => requestedIds,
			messages: () => sessionManager.buildSessionContext().messages,
			dispose: () => {
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	it("re-issues the request on the requested model when a relay substitutes one", async () => {
		const fixture = await runSession(1);
		try {
			await fixture.session.prompt("test");
			expect(fixture.requests()).toBe(2);
			expect(fixture.requestedIds()).toEqual(["requested-model", "requested-model"]);
			// The substituted turn is not kept: one user message, one answer.
			expect(assistantMessages(fixture.messages())).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});

	it("does not re-issue when the endpoint answers on the requested model", async () => {
		const fixture = await runSession(0);
		try {
			await fixture.session.prompt("test");
			expect(fixture.requests()).toBe(1);
			expect(assistantMessages(fixture.messages())).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});

	it("stops retrying when the endpoint substitutes a second time", async () => {
		const fixture = await runSession(Number.POSITIVE_INFINITY);
		try {
			await fixture.session.prompt("test");
			// One user turn re-issues at most once, so a hard substitution cannot loop.
			expect(fixture.requests()).toBe(2);
			expect(assistantMessages(fixture.messages())).toHaveLength(1);
		} finally {
			fixture.dispose();
		}
	});
});
