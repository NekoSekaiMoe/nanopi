import { afterEach, describe, expect, it, vi } from "vitest";
import { checkinQoder } from "../src/qoder/checkin.ts";
import { qoderEndpoints } from "../src/qoder/endpoints.ts";

const endpoints = qoderEndpoints("global");
const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Qoder daily check-in", () => {
	it("claims a claimable campaign against the region host", async () => {
		const calls: { url: string; method: string }[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url, method: init?.method ?? "GET" });
			if (url.endsWith("/sash/api/v1/me/campaigns")) {
				return jsonResponse({ campaigns: [campaign()] });
			}
			return jsonResponse({
				status: "CLAIMED",
				replayed: false,
				benefit: { kind: "CREDITS", amount: 100 },
			});
		});

		const result = await checkinQoder("dt-token", endpoints, neverAbortedSignal);

		expect(result).toMatchObject({ status: "claimed", amount: 100 });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET https://${endpoints.openApiHost}/sash/api/v1/me/campaigns`,
			`POST https://${endpoints.openApiHost}/sash/api/v1/me/campaigns/campaign-1/claim`,
		]);
	});

	it("reports a replayed claim as already claimed", async () => {
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/sash/api/v1/me/campaigns")) return jsonResponse({ campaigns: [campaign()] });
			return jsonResponse({ status: "CLAIMED", replayed: true, benefit: { amount: 100 } });
		});

		const result = await checkinQoder("dt-token", endpoints, neverAbortedSignal);

		expect(result.status).toBe("already_claimed");
		expect(result.amount).toBe(100);
	});

	it("skips the claim when the campaign is already claimed", async () => {
		const methods: string[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			methods.push(init?.method ?? "GET");
			return jsonResponse({ campaigns: [campaign({ claimStatus: "CLAIMED" })] });
		});

		const result = await checkinQoder("dt-token", endpoints, neverAbortedSignal);

		expect(result.status).toBe("already_claimed");
		expect(methods).toEqual(["GET"]);
	});

	it("reports no campaign when nothing is claimable", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ campaigns: [{ campaignId: "other", actionType: "READ_DOCS", claimStatus: "CLAIMABLE" }] }),
		);

		const result = await checkinQoder("dt-token", endpoints, neverAbortedSignal);

		expect(result.status).toBe("no_campaign");
	});

	it("surfaces the server message when the lookup fails", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ message: "TOKEN_EXPIRE" }, 401));

		const result = await checkinQoder("dt-token", endpoints, neverAbortedSignal);

		expect(result.status).toBe("error");
		expect(result.message).toContain("401");
		expect(result.message).toContain("TOKEN_EXPIRE");
	});

	it("does not call the API without a token", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkinQoder("  ", endpoints, neverAbortedSignal);

		expect(result.status).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
