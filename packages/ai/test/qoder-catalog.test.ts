import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQoderModelList, parseQoderModelList, qoderModelEntry } from "../src/qoder/catalog.ts";
import { qoderFingerprint, qoderSignedHeaders, qoderSigningPath } from "../src/qoder/cosy.ts";
import { qoderEndpoints } from "../src/qoder/endpoints.ts";
import type { AnyModel } from "../src/types.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Qoder model list", () => {
	it("keeps enabled models of the first non-empty bucket and reads their context tiers", () => {
		const models = parseQoderModelList({
			assistant: [
				{
					key: "qmodel_38max",
					display_name: "Ultimate",
					enable: true,
					is_default: true,
					is_reasoning: true,
					max_input_tokens: 200000,
					context_config: { "200K": { token_count: 200000 }, "1M": { token_count: 1000000, is_default: true } },
				},
				{ key: "dmodel", display_name: "Efficient", enable: false },
			],
			chat: [{ key: "gmodel", display_name: "Chat only", enable: true }],
		});

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ key: "qmodel_38max", displayName: "Ultimate", isReasoning: true });
		// The tier the upstream marks default wins over the list order.
		expect(models[0].contextWindow).toBe(1000000);
	});

	it("falls back to the largest tier, then to max_input_tokens", () => {
		expect(
			parseQoderModelList({
				assistant: [
					{ key: "a", enable: true, context_config: { s: { token_count: 200000 }, l: { token_count: 400000 } } },
					{ key: "b", enable: true, max_input_tokens: 128000 },
				],
			}).map((model) => model.contextWindow),
		).toEqual([400000, 128000]);
	});

	it("builds subscription-cost entries from a listed model", () => {
		const entry = qoderModelEntry({
			provider: "qoder",
			baseUrl: "https://api2.qoder.sh/v1",
			listed: { key: "cmodel", displayName: "Sonus", isDefault: false, isReasoning: false, contextWindow: 200000 },
		});

		expect(entry).toMatchObject({
			id: "cmodel",
			name: "Sonus",
			provider: "qoder",
			api: "openai-completions",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
		});
	});

	it("signs the list request with the COSY bearer and the derived device headers", async () => {
		const endpoints = qoderEndpoints("global");
		let headers: Headers | undefined;
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(endpoints.modelListUrl);
			headers = new Headers(init?.headers);
			return jsonResponse({ assistant: [{ key: "auto", display_name: "Auto", enable: true }] });
		});

		const models = await fetchQoderModelList("global", { uid: "u-1", token: "dt-abc" }, neverAbortedSignal);

		expect(models.map((model) => model.key)).toEqual(["auto"]);
		expect(headers?.get("authorization")?.startsWith("Bearer COSY.")).toBe(true);
		expect(headers?.get("cosy-key")).toBeTruthy();
		expect(headers?.get("cosy-machineid")).toBe(qoderFingerprint("u-1").machineId);
		expect(headers?.get("cosy-user")).toBe("u-1");
	});

	it("reports an upstream rejection instead of an empty catalog", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ code: "101", message: "Signature invalid" }, 403));

		await expect(fetchQoderModelList("global", { uid: "u-1", token: "dt-abc" }, neverAbortedSignal)).rejects.toThrow(
			/model list failed \(HTTP 403\): Signature invalid/,
		);
	});

	it("derives a stable device identity per account and signs the path without /algo", () => {
		expect(qoderFingerprint("u-1")).toEqual(qoderFingerprint("u-1"));
		expect(qoderFingerprint("u-1").machineId).not.toBe(qoderFingerprint("u-2").machineId);
		expect(qoderSigningPath("https://api2.qoder.sh/algo/api/v2/model/list?Encode=1")).toBe("/api/v2/model/list");

		const first = qoderSignedHeaders({
			identity: { uid: "u-1", token: "dt-abc" },
			fingerprint: qoderFingerprint("u-1"),
			path: "/api/v2/model/list",
			body: "",
		});
		const second = qoderSignedHeaders({
			identity: { uid: "u-1", token: "dt-abc" },
			fingerprint: qoderFingerprint("u-1"),
			path: "/api/v2/model/list",
			body: "",
		});
		// Fresh key and request id per request; the device headers stay put.
		expect(first["cosy-key"]).not.toBe(second["cosy-key"]);
		expect(first.authorization).not.toBe(second.authorization);
		expect(first["cosy-machineid"]).toBe(second["cosy-machineid"]);
	});
});

describe("Qoder provider catalog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("publishes the account's list as the catalog", async () => {
		const { qoderProvider } = await import("../src/providers/qoder.ts");
		const provider = qoderProvider();
		// The packaged entry is what /model shows before the first refresh.
		expect(provider.getModels().map((model) => model.id)).toEqual(["auto"]);
		let published: readonly AnyModel[] = [];

		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				assistant: [
					{
						key: "qmodel_38max",
						display_name: "Ultimate",
						enable: true,
						is_reasoning: true,
						max_input_tokens: 200000,
					},
					{ key: "dmodel", display_name: "Efficient", enable: false },
				],
			}),
		);

		await provider.refreshModels?.({
			credential: {
				type: "oauth",
				access: "dt-abc",
				refresh: "drt-abc",
				expires: Date.now() + 60_000,
				env: { QODER_ACCOUNT_ID: "u-1", QODER_DEVICE_TOKEN: "dt-abc" },
			},
			allowNetwork: true,
			signal: neverAbortedSignal,
			publish: async (publication) => {
				published = publication.persist?.models ?? [];
				return true;
			},
		});

		// One entry per enabled model the account may use; the disabled one is gone.
		expect(published.map((model) => ({ id: model.id, name: model.name, provider: model.provider }))).toEqual([
			{ id: "qmodel_38max", name: "Ultimate", provider: "qoder" },
		]);
		expect(published[0]).toMatchObject({ reasoning: true, contextWindow: 200000 });
	});

	it("leaves the packaged entry in place without an account id to sign with", async () => {
		const { qoderProvider } = await import("../src/providers/qoder.ts");
		const provider = qoderProvider();
		vi.stubGlobal("fetch", async () => {
			throw new Error("No request may be made without an account");
		});

		let published = -1;
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "dt-abc" },
			allowNetwork: true,
			signal: neverAbortedSignal,
			publish: async (publication) => {
				published = publication.persist?.models?.length ?? 0;
				return true;
			},
		});

		// Nothing is persisted, so the runtime overlay stays empty and the
		// packaged entry remains what `/model` shows.
		expect(published).toBe(0);
		expect(provider.getModels().map((model) => model.id)).toEqual(["auto"]);
	});
});
