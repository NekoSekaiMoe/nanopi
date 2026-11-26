import { describe, expect, it, vi } from "vitest";
import { antigravityOAuth } from "../src/auth/oauth/antigravity.ts";
import type { AuthEvent } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe("Antigravity OAuth", () => {
	it("uses the official client login shape: PKCE, state, aicode, and native Cloud Code headers", async () => {
		let authUrl = "";
		const headers: Record<string, Record<string, string>> = {};
		let assistCalls = 0;
		let onboardCalls = 0;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://oauth2.googleapis.com/token") {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("grant_type")).toBe("authorization_code");
				expect(body.get("code")).toBe("auth-code");
				expect(body.get("code_verifier")).toBeTruthy();
				return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
				assistCalls += 1;
				headers.loadCodeAssist = Object.fromEntries(new Headers(init?.headers).entries());
				// Free accounts get no project until onboardUser provisions one.
				return jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] });
			}
			if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser") {
				onboardCalls += 1;
				headers.onboardUser = Object.fromEntries(new Headers(init?.headers).entries());
				if (onboardCalls < 2) return jsonResponse({ done: false });
				return jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "project-42" } } });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			const credential = await antigravityOAuth.login({
				signal: neverAbortedSignal,
				notify: (event: AuthEvent) => {
					if (event.type === "auth_url") authUrl = event.url;
				},
				prompt: async () => {
					const redirectUri = new URL(authUrl).searchParams.get("redirect_uri");
					if (!redirectUri) throw new Error("Missing redirect_uri in auth URL");
					const state = new URL(authUrl).searchParams.get("state");
					return `${redirectUri}?code=auth-code&state=${state}`;
				},
			});

			expect(credential.access).toBe("access-1");
			expect(credential.refresh).toBe("refresh-1");
			expect(credential.env?.ANTIGRAVITY_PROJECT_ID).toBe("project-42");
			expect(assistCalls).toBe(1);
			expect(onboardCalls).toBe(2);
			const auth = new URL(authUrl);
			expect(auth.searchParams.get("access_type")).toBe("offline");
			expect(auth.searchParams.get("prompt")).toBe("consent");
			expect(auth.searchParams.get("scope")).toBe(
				"https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/aicode",
			);
			expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
			const challenge = auth.searchParams.get("code_challenge");
			expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
			const state = auth.searchParams.get("state");
			expect(state).toMatch(/^[0-9a-f]{64}$/);
			// The verifier is in the token exchange, not in the browser URL.
			const tokenBody = fetchMock.mock.calls.find(
				(call) => getUrl(call[0]) === "https://oauth2.googleapis.com/token",
			)?.[1]?.body as string;
			const verifier = new URLSearchParams(tokenBody).get("code_verifier") ?? "";
			const expectedChallenge = Buffer.from(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
			).toString("base64url");
			expect(expectedChallenge).toBe(challenge);
			for (const callHeaders of Object.values(headers)) {
				expect(callHeaders["user-agent"]).toContain("antigravity/hub/");
				expect(callHeaders["x-client-name"]).toBe("antigravity");
				expect(callHeaders["x-client-version"]).toBeTruthy();
				expect(callHeaders["x-goog-api-client"]).toContain("antigravity/");
			}
			const tokenHeaders = fetchMock.mock.calls.find(
				(call) => getUrl(call[0]) === "https://oauth2.googleapis.com/token",
			)?.[1]?.headers as Record<string, string> | undefined;
			expect(tokenHeaders?.cookie).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rejects a pasted redirect with a mismatched state", async () => {
		const fetchMock = vi.fn(async (): Promise<Response> => {
			throw new Error("token request should not run after a state mismatch");
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(
				antigravityOAuth.login({
					signal: neverAbortedSignal,
					notify: () => undefined,
					prompt: async () => "http://localhost:51121/oauth-callback?code=auth-code&state=wrong-state",
				}),
			).rejects.toThrow("state mismatch");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps the stored project across refreshes", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			expect(getUrl(input)).toBe("https://oauth2.googleapis.com/token");
			return jsonResponse({ access_token: "access-2", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const refreshed = await antigravityOAuth.refresh(
				{
					type: "oauth",
					access: "access-1",
					refresh: "refresh-1",
					expires: 0,
					env: { ANTIGRAVITY_PROJECT_ID: "project-42" },
				},
				neverAbortedSignal,
			);
			expect(refreshed.access).toBe("access-2");
			// Google does not rotate refresh tokens; the stored one is kept.
			expect(refreshed.refresh).toBe("refresh-1");
			expect(refreshed.env?.ANTIGRAVITY_PROJECT_ID).toBe("project-42");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
