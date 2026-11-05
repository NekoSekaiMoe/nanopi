import { afterEach, describe, expect, it, vi } from "vitest";
import { qoderCnOAuth, qoderOAuth } from "../src/auth/oauth/qoder-oauth.ts";
import type { AuthEvent, ProviderAuthInteraction } from "../src/auth/types.ts";
import { qoderEndpoints } from "../src/qoder/endpoints.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function interaction(): { events: AuthEvent[]; hooks: ProviderAuthInteraction } {
	const events: AuthEvent[] = [];
	return {
		events,
		hooks: {
			signal: neverAbortedSignal,
			prompt: async () => {
				throw new Error("Qoder login must not prompt");
			},
			notify: (event) => events.push(event),
		},
	};
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Qoder OAuth", () => {
	it("polls until approved, then stores the device token and the account", async () => {
		const endpoints = qoderEndpoints("global");
		let polls = 0;
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = urlOf(input);
			if (url.startsWith(endpoints.pollEndpoint)) {
				polls += 1;
				return polls === 1 ? jsonResponse({ message: "pending" }, 404) : jsonResponse({ token: "dt-abc" });
			}
			if (url === endpoints.userInfo) return jsonResponse({ name: "Ada", email: "ada@example.com", userId: "u1" });
			if (url === endpoints.plan) return jsonResponse({ plan_tier_name: "Pro" });
			throw new Error(`Unexpected request: ${url}`);
		});

		const { events, hooks } = interaction();
		const credential = await qoderOAuth.login(hooks);

		expect(credential.access).toBe("dt-abc");
		expect(credential.env).toMatchObject({
			QODER_REGION: "global",
			QODER_ACCOUNT_NAME: "Ada",
			QODER_ACCOUNT_EMAIL: "ada@example.com",
			QODER_ACCOUNT_ID: "u1",
			QODER_PLAN: "Pro",
		});
		const authUrl = events.find((event) => event.type === "auth_url");
		expect(authUrl).toMatchObject({ type: "auth_url" });
		if (authUrl?.type === "auth_url") {
			expect(authUrl.url.startsWith(endpoints.deviceLoginBase)).toBe(true);
			expect(new URL(authUrl.url).searchParams.get("challenge_method")).toBe("S256");
		}
		expect(polls).toBe(2);
	});

	it("uses the CN endpoints for the CN flow", async () => {
		const endpoints = qoderEndpoints("cn");
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = urlOf(input);
			requested.push(url);
			if (url.startsWith(endpoints.pollEndpoint)) return jsonResponse({ token: "dt-cn" });
			if (url === endpoints.userInfo) return jsonResponse({ name: "Bao" });
			return jsonResponse({}, 404);
		});

		const { events, hooks } = interaction();
		const credential = await qoderCnOAuth.login(hooks);

		expect(credential.access).toBe("dt-cn");
		expect(credential.env?.QODER_REGION).toBe("cn");
		expect(requested[0].startsWith(endpoints.pollEndpoint)).toBe(true);
		const authUrl = events.find((event) => event.type === "auth_url");
		if (authUrl?.type === "auth_url") expect(authUrl.url.startsWith("https://qoder.com.cn/")).toBe(true);
	});

	it("renews an expired pair through the job-token exchange and stores the new refresh token", async () => {
		const endpoints = qoderEndpoints("global");
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = urlOf(input);
			requested.push(url);
			if (url === endpoints.jobTokenUrl) return jsonResponse({ device_token: "dt-new", refresh_token: "drt-new" });
			if (url === endpoints.userInfo) return jsonResponse({ name: "Ada", userId: "u1", userType: "personal_pro" });
			return jsonResponse({}, 404);
		});

		const credential = await qoderOAuth.refresh(
			{ type: "oauth", access: "dt-old", refresh: "drt-old", expires: Date.now() + 1000 },
			neverAbortedSignal,
		);

		expect(requested[0]).toBe(endpoints.jobTokenUrl);
		expect(credential.access).toBe("dt-new");
		expect(credential.refresh).toBe("drt-new");
		expect(credential.env).toMatchObject({
			QODER_DEVICE_TOKEN: "dt-new",
			QODER_ACCOUNT_REFRESH_TOKEN: "drt-new",
			QODER_ACCOUNT_ID: "u1",
			QODER_ACCOUNT_USER_TYPE: "personal_pro",
		});
	});

	it("reports a rejected renewal instead of a token that lapsed", async () => {
		const endpoints = qoderEndpoints("cn");
		vi.stubGlobal("fetch", async () => jsonResponse({ message: "personal token is invalid" }, 200));

		await expect(
			qoderOAuth.refresh(
				{
					type: "oauth",
					access: "dt-old",
					refresh: "drt-old",
					expires: Date.now() + 1000,
					env: { QODER_REGION: "cn" },
				},
				neverAbortedSignal,
			),
		).rejects.toThrow(/token exchange returned no device token/);
		expect(endpoints.jobTokenUrl).toContain("gateway.qoder.com.cn");
	});

	it("derives bearer auth from the stored token", async () => {
		const auth = await qoderOAuth.toAuth({
			type: "oauth",
			access: "dt-abc",
			refresh: "dt-abc",
			expires: Date.now() + 1000,
			env: { QODER_REGION: "global" },
		});

		expect(auth).toEqual({ apiKey: "dt-abc", env: { QODER_REGION: "global" } });
	});
});
