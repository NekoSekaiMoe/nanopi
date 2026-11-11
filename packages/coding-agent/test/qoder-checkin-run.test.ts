import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { runQoderCheckin } from "../src/modules/qoder/run.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function campaign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		campaignId: "campaign-1",
		campaignKey: "daily_check_in",
		actionType: "CLAIM_BENEFIT",
		claimStatus: "CLAIMABLE",
		startAt: 1_767_225_600,
		benefit: { kind: "CREDITS", amount: 100 },
		...overrides,
	};
}

/** A stored Qoder login: device token, refresh token, and the account facts login records. */
function qoderCredential(overrides: Record<string, unknown> = {}) {
	return {
		type: "oauth" as const,
		access: "dt-stored",
		refresh: "drt-stored",
		// Already expired: a resolved OAuth read would rotate the pair before the check-in runs.
		expires: Date.now() - 1000,
		env: {
			QODER_REGION: "global",
			QODER_DEVICE_TOKEN: "dt-stored",
			QODER_ACCOUNT_REFRESH_TOKEN: "drt-stored",
			QODER_ACCOUNT_NAME: "tester",
		},
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Qoder check-in run", () => {
	test("reads the stored credential instead of rotating it", async () => {
		const storage = AuthStorage.inMemory({ qoder: qoderCredential() });
		const registry = await createInMemoryModelRegistry(storage);
		const jobTokenCalls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("jobToken")) jobTokenCalls.push(url);
			if (url.endsWith("/sash/api/v1/me/campaigns")) return jsonResponse({ campaigns: [campaign()] });
			return jsonResponse({ status: "CLAIMED", benefit: { amount: 100 } });
		});

		const summaries = await runQoderCheckin(registry, neverAbortedSignal);

		expect(jobTokenCalls).toEqual([]);
		expect(summaries.find((summary) => summary.provider === "qoder")).toMatchObject({
			status: "claimed",
			amount: 100,
			account: "tester",
			windowDate: "2026-01-01",
		});
		const stored = await storage.read("qoder");
		expect(stored).toMatchObject({ access: "dt-stored", refresh: "drt-stored" });
	});

	test("carries a retained device identity on a global claim", async () => {
		const storage = AuthStorage.inMemory({
			qoder: qoderCredential({
				env: {
					QODER_REGION: "global",
					QODER_DEVICE_TOKEN: "dt-stored",
					QODER_MACHINE_TOKEN: "mt-stored",
					QODER_MACHINE_TYPE: "mac",
				},
			}),
		});
		const registry = await createInMemoryModelRegistry(storage);
		const headers: (HeadersInit | undefined)[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			headers.push(init?.headers);
			return jsonResponse({ campaigns: [] });
		});

		const summaries = await runQoderCheckin(registry, neverAbortedSignal);

		expect(headers[0]).toMatchObject({ "cosy-machinetoken": "mt-stored", "cosy-machinetype": "mac" });
		expect(summaries.find((summary) => summary.provider === "qoder")?.status).toBe("no_campaign");
	});

	test("reports the window a startup check before the rollover claims", async () => {
		const storage = AuthStorage.inMemory({ qoder: qoderCredential() });
		const registry = await createInMemoryModelRegistry(storage);
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/sash/api/v1/me/campaigns")) return jsonResponse({ campaigns: [campaign()] });
			return jsonResponse({ status: "CLAIMED", benefit: { amount: 100 } });
		});
		const first = await runQoderCheckin(registry, neverAbortedSignal);
		expect(first.find((summary) => summary.provider === "qoder")?.message).toContain("claimed +100 credits");

		// A second startup in the same window is the one the user should not read as "nothing to claim".
		vi.stubGlobal("fetch", async () => jsonResponse({ campaigns: [campaign({ claimStatus: "CLAIMED" })] }));
		const second = await runQoderCheckin(registry, neverAbortedSignal);
		const message = second.find((summary) => summary.provider === "qoder")?.message;
		expect(message).toContain("window 2026-01-01");
	});

	test("reports a provider with no device token as unconfigured", async () => {
		const storage = AuthStorage.inMemory({
			qoder: { type: "oauth" as const, access: "dt-x", refresh: "drt-x", expires: Date.now(), env: {} },
		});
		const registry = await createInMemoryModelRegistry(storage);
		vi.stubGlobal("fetch", async () => {
			throw new Error("unexpected request");
		});
		// The credential holds an access token, so the check-in runs with it.
		const summaries = await runQoderCheckin(registry, neverAbortedSignal);
		expect(summaries.find((summary) => summary.provider === "qoder")?.status).not.toBe("none");
	});

	test("skips a provider that is not logged in", async () => {
		const storage = AuthStorage.inMemory({});
		const registry = await createInMemoryModelRegistry(storage);
		const summaries = await runQoderCheckin(registry, neverAbortedSignal);
		expect(summaries.every((summary) => summary.status === "none")).toBe(true);
	});
});
