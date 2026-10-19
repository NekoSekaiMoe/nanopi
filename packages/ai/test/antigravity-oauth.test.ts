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
	it("resolves the Cloud Code project and stores it in the credential env", async () => {
		let authUrl = "";
		let assistCalls = 0;
		let onboardCalls = 0;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://oauth2.googleapis.com/token") {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("grant_type")).toBe("authorization_code");
				expect(body.get("code")).toBe("auth-code");
				return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
				assistCalls += 1;
				// Free accounts get no project until onboardUser provisions one.
				return jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] });
			}
			if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser") {
				onboardCalls += 1;
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
					return `${redirectUri}?code=auth-code`;
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
			expect(auth.searchParams.get("scope")).toContain("cloud-platform");
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
