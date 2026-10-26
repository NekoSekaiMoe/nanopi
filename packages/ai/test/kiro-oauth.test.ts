import { afterEach, describe, expect, it, vi } from "vitest";
import { kiroOAuth } from "../src/auth/oauth/kiro.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;
const OAUTH_ENDPOINT = "https://prod.us-east-1.auth.desktop.kiro.dev";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function deviceAuthorizationResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		deviceCode: "device-code",
		userCode: "ABCD-1234",
		verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
		expiresIn: 600,
		interval: 5,
		...overrides,
	};
}

function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600, ...overrides };
}

type DeviceCodeInfo = { userCode: string; verificationUri: string; intervalSeconds?: number };

function loginKiroForTest(options: {
	onDeviceCode: (info: DeviceCodeInfo) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredential> {
	return kiroOAuth.login({
		signal: options.signal ?? neverAbortedSignal,
		prompt: () => {
			throw new Error("Unexpected prompt");
		},
		notify: (event) => {
			if (event.type !== "device_code") return;
			options.onDeviceCode({
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				intervalSeconds: event.intervalSeconds,
			});
		},
	});
}

describe("Kiro OAuth device flow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("registers a client, announces the device code, and stores the client on the credential", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-10-26T08:00:00Z");
		vi.setSystemTime(startTime);
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = requestUrl(input);
			if (url === `${OAUTH_ENDPOINT}/client/register`) {
				const body = requestBody(init);
				expect(body.clientType).toBe("public");
				expect(body.grantTypes).toEqual(["device_code", "refresh_token"]);
				return jsonResponse({ clientId: "client-id", clientSecret: "client-secret" });
			}
			if (url === `${OAUTH_ENDPOINT}/device_authorization`) {
				const body = requestBody(init);
				expect(body.clientId).toBe("client-id");
				expect(body.clientSecret).toBe("client-secret");
				expect(body.startUrl).toBe("https://view.awsapps.com/start");
				return jsonResponse(deviceAuthorizationResponse());
			}
			if (url === `${OAUTH_ENDPOINT}/token`) {
				const body = requestBody(init);
				expect(body.grantType).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(body.deviceCode).toBe("device-code");
				return jsonResponse(tokenResponse());
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const deviceCodes: DeviceCodeInfo[] = [];
		const loginPromise = loginKiroForTest({ onDeviceCode: (info) => deviceCodes.push(info) });
		// The first poll waits one interval, so nothing has completed yet.
		await vi.advanceTimersByTimeAsync(0);
		expect(deviceCodes).toEqual([
			{ userCode: "ABCD-1234", verificationUri: "https://device.sso.us-east-1.amazonaws.com/", intervalSeconds: 5 },
		]);

		await vi.advanceTimersByTimeAsync(5000);
		await expect(loginPromise).resolves.toEqual({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime.getTime() + 5000 + 3_600_000,
			clientId: "client-id",
			clientSecret: "client-secret",
			region: "us-east-1",
		});
	});

	it("honors KIRO_REGION for an enterprise install", async () => {
		const previous = process.env.KIRO_REGION;
		process.env.KIRO_REGION = "eu-central-1";
		try {
			vi.useFakeTimers();
			const urls: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown) => {
					const url = requestUrl(input);
					urls.push(url);
					if (url === "https://prod.eu-central-1.auth.desktop.kiro.dev/client/register") {
						return jsonResponse({ clientId: "c", clientSecret: "s" });
					}
					if (url.endsWith("/device_authorization"))
						return jsonResponse(deviceAuthorizationResponse({ interval: 1 }));
					return jsonResponse(tokenResponse());
				}),
			);

			const loginPromise = loginKiroForTest({ onDeviceCode: () => {} });
			await vi.advanceTimersByTimeAsync(1000);
			const credential = await loginPromise;
			expect(credential.region).toBe("eu-central-1");
			expect(urls.every((url) => url.startsWith("https://prod.eu-central-1.auth.desktop.kiro.dev"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.KIRO_REGION;
			else process.env.KIRO_REGION = previous;
		}
	});

	it("keeps polling while AWS reports authorization_pending", async () => {
		vi.useFakeTimers();
		let polls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = requestUrl(input);
				if (url.endsWith("/client/register")) return jsonResponse({ clientId: "c", clientSecret: "s" });
				if (url.endsWith("/device_authorization"))
					return jsonResponse(deviceAuthorizationResponse({ interval: 1 }));
				polls += 1;
				return polls < 3 ? jsonResponse({ error: "authorization_pending" }, 400) : jsonResponse(tokenResponse());
			}),
		);

		const loginPromise = loginKiroForTest({ onDeviceCode: () => {} });
		await vi.advanceTimersByTimeAsync(5000);
		await expect(loginPromise).resolves.toMatchObject({ access: "access-token" });
		expect(polls).toBe(3);
	});

	it("fails when the device authorization is denied", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = requestUrl(input);
				if (url.endsWith("/client/register")) return jsonResponse({ clientId: "c", clientSecret: "s" });
				if (url.endsWith("/device_authorization"))
					return jsonResponse(deviceAuthorizationResponse({ interval: 1 }));
				return jsonResponse({ error: "access_denied" }, 400);
			}),
		);

		const loginPromise = loginKiroForTest({ onDeviceCode: () => {} });
		const assertion = expect(loginPromise).rejects.toThrow("Kiro login was denied");
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
	});

	it("cancels while waiting for the first token poll", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = requestUrl(input);
				if (url.endsWith("/client/register")) return jsonResponse({ clientId: "c", clientSecret: "s" });
				return jsonResponse(deviceAuthorizationResponse());
			}),
		);

		const loginPromise = loginKiroForTest({
			onDeviceCode: () => controller.abort(),
			signal: controller.signal,
		});
		await expect(loginPromise).rejects.toThrow("Login cancelled");
	});

	it("refreshes with the stored client registration and keeps it on the credential", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(requestUrl(input)).toBe(`${OAUTH_ENDPOINT}/token`);
			const body = requestBody(init);
			expect(body).toMatchObject({
				clientId: "client-id",
				clientSecret: "client-secret",
				refreshToken: "old-refresh",
				grantType: "refresh_token",
			});
			return jsonResponse({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await kiroOAuth.refresh(
			{
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: 0,
				clientId: "client-id",
				clientSecret: "client-secret",
				region: "us-east-1",
			},
			neverAbortedSignal,
		);
		expect(refreshed).toMatchObject({
			access: "new-access",
			refresh: "new-refresh",
			clientId: "client-id",
			clientSecret: "client-secret",
			region: "us-east-1",
		});
	});

	it("refuses to refresh a credential without the client registration it was issued to", async () => {
		await expect(
			kiroOAuth.refresh(
				{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
				neverAbortedSignal,
			),
		).rejects.toThrow("no client registration");
	});

	it("describes itself as a subscription login and authenticates with the access token", async () => {
		expect(kiroOAuth.name).toBe("Kiro (AWS)");
		expect(kiroOAuth.isSubscription).toBe(true);
		expect(kiroOAuth.loginLabel).toBe("Sign in with Kiro");
		await expect(kiroOAuth.toAuth({ type: "oauth", access: "token", refresh: "r", expires: 0 })).resolves.toEqual({
			apiKey: "token",
		});
	});
});
