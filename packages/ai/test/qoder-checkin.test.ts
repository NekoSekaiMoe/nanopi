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

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

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

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		expect(result.status).toBe("already_claimed");
		expect(result.amount).toBe(100);
	});

	it("skips the claim when the campaign is already claimed", async () => {
		const methods: string[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			methods.push(init?.method ?? "GET");
			return jsonResponse({ campaigns: [campaign({ claimStatus: "CLAIMED" })] });
		});

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		expect(result.status).toBe("already_claimed");
		expect(methods).toEqual(["GET"]);
	});

	it("reports no campaign when nothing is claimable", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ campaigns: [{ campaignId: "other", actionType: "READ_DOCS", claimStatus: "CLAIMABLE" }] }),
		);

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		expect(result.status).toBe("no_campaign");
		expect(result.message).toContain("1 campaign(s)");
	});

	it("says the server listed nothing when the campaign list is empty", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ campaigns: [] }));

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		expect(result.status).toBe("no_campaign");
		expect(result.message).toContain("listed no campaign");
	});

	it("sends a stored device identity with the claim", async () => {
		const headers: (HeadersInit | undefined)[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			headers.push(init?.headers);
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith("/sash/api/v1/me/campaigns")) return jsonResponse({ campaigns: [campaign()] });
			return jsonResponse({ status: "CLAIMED", benefit: { amount: 100 } });
		});

		await checkinQoder(
			"dt-token",
			endpoints,
			{ device: { machineToken: "mt-1", machineType: "mac" } },
			neverAbortedSignal,
		);

		for (const entry of headers) {
			expect(entry).toMatchObject({ "cosy-machinetoken": "mt-1", "cosy-machinetype": "mac" });
		}
	});

	it("sends every captured identity field the credential holds", async () => {
		const headers: (HeadersInit | undefined)[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			headers.push(init?.headers);
			return jsonResponse({ campaigns: [] });
		});

		await checkinQoder(
			"dt-token",
			endpoints,
			{
				device: {
					machineToken: "mt-1",
					machineType: "5",
					machineId: "mi-1",
					machineCode: "mc-1",
					version: "0.4.8",
					clientType: "10",
					hostname: "box",
					machineOs: "aarch64_darwin",
				},
			},
			neverAbortedSignal,
		);

		expect(headers[0]).toMatchObject({
			"cosy-version": "0.4.8",
			"cosy-machineid": "mi-1",
			"cosy-machinetoken": "mt-1",
			"cosy-machinetype": "5",
			"cosy-machinecode": "mc-1",
			"cosy-machinehostname": "box",
			"cosy-machineos": "aarch64_darwin",
		});
	});

	it("reports the identity it carried and the campaigns the server listed", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				campaigns: [
					{ campaignId: "c-1", actionType: "CLAIM_BENEFIT", claimStatus: "PENDING" },
					{ campaignId: "c-2", actionType: "SOTA_PACKAGE", claimStatus: "CLAIMABLE" },
				],
			}),
		);

		const result = await checkinQoder(
			"dt-token",
			endpoints,
			{ device: { machineToken: "mt-1" } },
			neverAbortedSignal,
		);

		expect(result.status).toBe("no_campaign");
		expect(result.fingerprint).toBe(true);
		expect(result.fingerprintFields).toEqual(["machinetoken"]);
		expect(result.campaigns).toEqual(["CLAIM_BENEFIT/PENDING", "SOTA_PACKAGE/CLAIMABLE"]);
		expect(result.raw).toContain("CLAIM_BENEFIT");
	});

	it("reports a missing identity when the campaign list is empty", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ campaigns: [] }));

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		expect(result.fingerprint).toBe(false);
		expect(result.fingerprintFields).toBeUndefined();
		expect(result.campaigns).toEqual([]);
	});

	it("sends no device identity when none is known", async () => {
		const headers: (HeadersInit | undefined)[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			headers.push(init?.headers);
			return jsonResponse({ campaigns: [] });
		});

		await checkinQoder("dt-token", endpoints, { device: {} }, neverAbortedSignal);

		expect(headers[0]).not.toHaveProperty("cosy-machinetoken");
	});

	it("reports the IDE client when no capture says otherwise", async () => {
		const headers: (HeadersInit | undefined)[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			headers.push(init?.headers);
			return jsonResponse({ campaigns: [] });
		});

		await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		// Same pair the signed calls present (qoderDeviceHeaders), so one account
		// does not look like two clients depending on the endpoint it talks to.
		expect(headers[0]).toMatchObject({ "cosy-clienttype": "5", "cosy-version": "0.4.4" });
	});

	it("reports the client id that belongs to the captured version", async () => {
		const headers: (HeadersInit | undefined)[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			headers.push(init?.headers);
			return jsonResponse({ campaigns: [] });
		});

		await checkinQoder(
			"dt-token",
			endpoints,
			{ device: { machineToken: "mt-1", version: "1.1.69" } },
			neverAbortedSignal,
		);
		await checkinQoder(
			"dt-token",
			endpoints,
			{ device: { machineToken: "mt-1", version: "0.4.8" } },
			neverAbortedSignal,
		);

		expect(headers[0]).toMatchObject({ "cosy-clienttype": "10", "cosy-version": "1.1.69" });
		expect(headers[1]).toMatchObject({ "cosy-clienttype": "5", "cosy-version": "0.4.8" });
	});

	it("counts a listed campaign that carries no id", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ campaigns: [{ actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE" }] }),
		);

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		// The count is the evidence a user acts on, so an entry without an id is
		// still listed rather than dropped from it.
		expect(result.status).toBe("no_campaign");
		expect(result.message).toContain("1 campaign(s)");
		expect(result.campaigns).toEqual(["CLAIM_BENEFIT/CLAIMABLE"]);
	});

	it("names the window when a claim covers a window the machine already finished", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ campaigns: [campaign({ claimStatus: "CLAIMED" })] }));

		const result = await checkinQoder(
			"dt-token",
			endpoints,
			{ previousWindowDate: "2026-01-01" },
			neverAbortedSignal,
		);

		expect(result.windowDate).toBe("2026-01-01");
		expect(result.message).toContain("window 2026-01-01");
	});

	it("keeps the plain message for a window the machine did not claim yet", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ campaigns: [campaign({ claimStatus: "CLAIMED" })] }));

		const result = await checkinQoder(
			"dt-token",
			endpoints,
			{ previousWindowDate: "2025-12-31" },
			neverAbortedSignal,
		);

		expect(result.windowDate).toBe("2026-01-01");
		expect(result.message).toBe("already claimed today");
	});

	it("surfaces the server message when the lookup fails", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ message: "TOKEN_EXPIRE" }, 401));

		const result = await checkinQoder("dt-token", endpoints, {}, neverAbortedSignal);

		expect(result.status).toBe("error");
		expect(result.message).toContain("401");
		expect(result.message).toContain("TOKEN_EXPIRE");
	});

	it("keeps device headers off the CN site", async () => {
		const headers: (HeadersInit | undefined)[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			headers.push(init?.headers);
			return jsonResponse({ campaigns: [] });
		});

		const cn = qoderEndpoints("cn");
		await checkinQoder("dt-token", cn, {}, neverAbortedSignal);

		expect(headers[0]).not.toHaveProperty("cosy-machinetoken");
	});

	it("does not call the API without a token", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkinQoder("  ", endpoints, {}, neverAbortedSignal);

		expect(result.status).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
