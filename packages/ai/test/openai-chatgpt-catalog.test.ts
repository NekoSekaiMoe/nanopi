import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { builtinModels } from "../src/providers/all.ts";

const CHATGPT_MODELS_URL = "https://chatgpt.com/backend-api/models";
const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function oauthCredential(extra: Record<string, unknown> = {}): OAuthCredential {
	return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, ...extra };
}

async function availableOpenAIIds(credential: OAuthCredential): Promise<string[]> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => credential);
	return (await builtinModels({ credentials }).getAvailable("openai")).map((model) => model.id);
}

describe("OpenAI ChatGPT account catalog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reads the account catalog from the ChatGPT backend", async () => {
		const fetchMock = vi.fn(async (input: unknown) => {
			expect(String(input)).toBe(CHATGPT_MODELS_URL);
			return jsonResponse({ models: [{ id: "gpt-5.5" }, { id: "gpt-5.6-luna" }, { id: "gpt-5.5" }, {}] });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			openaiChatGPTOAuth.refreshAvailability?.(oauthCredential(), neverAbortedSignal),
		).resolves.toMatchObject({ modelIds: ["gpt-5.5", "gpt-5.6-luna"] });
	});

	it("keeps the stored catalog when the backend does not answer usefully", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "nope" }, 501)),
		);
		const credential = oauthCredential({ modelIds: ["gpt-5.5"] });
		await expect(openaiChatGPTOAuth.refreshAvailability?.(credential, neverAbortedSignal)).resolves.toBe(credential);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ models: "gpt-5.5" })),
		);
		await expect(openaiChatGPTOAuth.refreshAvailability?.(credential, neverAbortedSignal)).resolves.toBe(credential);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		await expect(openaiChatGPTOAuth.refreshAvailability?.(credential, neverAbortedSignal)).resolves.toBe(credential);
	});

	it("hides bundled models that the signed-in plan cannot use", async () => {
		const ids = await availableOpenAIIds(oauthCredential({ modelIds: ["gpt-5.5", "gpt-5-mini"] }));
		expect(ids).toEqual(["gpt-5-mini", "gpt-5.5"]);
	});

	it("keeps every chat model when the account has no catalog yet", async () => {
		const ids = await availableOpenAIIds(oauthCredential());
		expect(ids).toContain("gpt-6-sol");
		expect(ids).toContain("gpt-6-astra");
	});

	it("leaves API key availability untouched", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "secret" }));
		const models = builtinModels({ credentials });
		expect((await models.getAvailable("openai")).map((model) => model.id)).toContain("gpt-6-sol");
	});
});
