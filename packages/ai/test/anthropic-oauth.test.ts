import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { startOAuthCallbackServer } from "../src/auth/oauth/callback-server.ts";
import type { AuthEvent, AuthPrompt } from "../src/auth/types.ts";

// `platform.claude.com/v1/oauth/token` answers only browser-originated requests (403 otherwise),
// so login exchanges and refreshes against the api.anthropic.com deployment.
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const neverAbortedSignal = new AbortController().signal;
const nativeFetch = globalThis.fetch;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe("Anthropic OAuth", { concurrent: false }, () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("anthropic-beta")).toBe("oauth-2025-04-20");
			expect(new Headers(init?.headers).get("user-agent")).toMatch(/^claude-cli\//);
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("manual-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "browser";
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) throw new Error("Missing OAuth state or redirect_uri in auth URL");
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("offers browser login first and uses the selected Anthropic copy code flow", async () => {
		const selectPrompts: Array<{
			message: string;
			options: readonly { id: string; label: string }[];
		}> = [];
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("copied-code");
			expect(body.state).toBe(new URL(authUrl).searchParams.get("state"));
			expect(body.redirect_uri).toBe("https://platform.claude.com/oauth/code/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") {
					selectPrompts.push(prompt);
					return "copy_code";
				}
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				return `copied-code#${new URL(authUrl).searchParams.get("state")}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(new URL(authUrl).searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(selectPrompts).toEqual([
			{
				type: "select",
				message: "Select Anthropic login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "copy_code", label: "Copy code login (headless)" },
				],
			},
		]);
	});

	it("cancels when Anthropic login method selection is cancelled", async () => {
		await expect(
			anthropicOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("omits scope from refresh token requests", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			expect(body).not.toHaveProperty("scope");
			return jsonResponse({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.refresh(
			{
				type: "oauth",
				access: "old-access-token",
				refresh: "refresh-token",
				expires: 0,
			},
			neverAbortedSignal,
		);

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("anthropicOAuth.login resolves through the manual_code prompt and aborts it after settling", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = typeof input === "string" ? input : String(input);
			if (url.includes("/oauth/token")) {
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const events: AuthEvent[] = [];
		const prompts: AuthPrompt[] = [];
		let manualSignal: AbortSignal | undefined;

		const credential = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => events.push(event),
			prompt: async (prompt) => {
				prompts.push(prompt);
				if (prompt.type === "select") return "browser";
				if (prompt.type === "manual_code") {
					manualSignal = prompt.signal;
					return "the-code";
				}
				throw new Error(`Unexpected prompt: ${prompt.type}`);
			},
		});

		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("access");
		expect(events.some((e) => e.type === "auth_url")).toBe(true);
		expect(prompts.some((p) => p.type === "manual_code")).toBe(true);
		// the prompt's signal is aborted once login settles, so UIs can dismiss it
		expect(manualSignal?.aborted).toBe(true);
	});

	it("forces the account picker in both login flows", { concurrent: false }, async () => {
		// Without prompt=login the consent screen completes silently from an existing
		// claude.ai session and signs into whichever account is active in that browser.
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
			),
		);

		for (const method of ["browser", "copy_code"]) {
			await anthropicOAuth.login({
				signal: neverAbortedSignal,
				notify: (event) => {
					if (event.type === "auth_url") urls.push(event.url);
				},
				prompt: async (prompt) => {
					if (prompt.type === "select") return method;
					if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
					const params = new URL(urls[urls.length - 1]).searchParams;
					return `${params.get("redirect_uri")}?code=manual-code&state=${params.get("state")}`;
				},
			});
		}

		expect(urls).toHaveLength(2);
		for (const url of urls) {
			expect(new URL(url).searchParams.get("prompt")).toBe("login");
		}
	});

	it("round-trips a state of its own instead of the PKCE verifier", async () => {
		let authUrl = "";
		let exchangedState: string | undefined;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			exchangedState = getJsonBody(init).state;
			return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "browser";
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				const params = new URL(authUrl).searchParams;
				return `${params.get("redirect_uri")}?code=manual-code&state=${params.get("state")}`;
			},
		});

		const params = new URL(authUrl).searchParams;
		const state = params.get("state");
		const challenge = params.get("code_challenge");
		expect(state).toMatch(/^[0-9a-f]{64}$/);
		// The verifier never travels in the URL; only its S256 challenge does.
		expect(state).not.toBe(challenge);
		expect(exchangedState).toBe(state);
	});

	it("rejects a pasted redirect URL whose state does not match", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> => jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
			),
		);

		await expect(
			anthropicOAuth.login({
				signal: neverAbortedSignal,
				notify: () => {},
				prompt: async (prompt) => {
					if (prompt.type === "select") return "browser";
					if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
					return "http://localhost:53692/callback?code=manual-code&state=forged";
				},
			}),
		).rejects.toThrow("OAuth state mismatch");
	});

	it("completes login through the browser callback and shows the sign-in page", async () => {
		const login = await loginThroughBrowserCallback();

		expect(login.credential.access).toBe("access");
		expect(login.exchangedCode).toBe("browser-code");
		expect(login.exchangedRedirectUri).toBe(login.redirectUri);
		expect(login.pageStatus).toBe(200);
		expect(login.pageText).toContain("Signed in to Anthropic.");
		// Claude's consent screen renders this page inside a frame on claude.ai.
		expect(login.pageCsp).toContain("frame-ancestors https://claude.ai");
	});

	// Claude's consent screen renders the loopback page inside a frame on claude.ai, so every
	// response the server writes has to allow it, not only the success page.
	it("allows Claude's frame ancestor on the rejected-callback page", async () => {
		const callback = await startOAuthCallbackServer({
			providerName: "Anthropic",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			pageOrigin: "https://claude.ai",
			state: "expected-state",
			complete: async (code) => code,
		});
		try {
			const callbackUrl = `${callback.redirectUri}?code=late-code&state=expected-state`;
			const first = await nativeFetch(callbackUrl);
			await first.text();
			const response = await nativeFetch(callbackUrl);
			const body = await response.text();

			expect(first.status).toBe(200);
			expect(response.status).toBe(409);
			expect(response.headers.get("content-security-policy")).toContain("frame-ancestors https://claude.ai");
			expect(body).toContain("already been handled");
		} finally {
			callback.close();
		}
	});

	// #10571
	it("falls back to a free callback port when the preferred port cannot be bound", async () => {
		const blocker = createServer();
		await listen(blocker, 53692);
		try {
			const login = await loginThroughBrowserCallback();
			const redirectUri = new URL(login.redirectUri);

			expect(redirectUri.hostname).toBe("localhost");
			expect(redirectUri.pathname).toBe("/callback");
			expect(redirectUri.port).not.toBe("53692");
			expect(login.credential.access).toBe("access");
			expect(login.exchangedRedirectUri).toBe(login.redirectUri);
			expect(login.pageStatus).toBe(200);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});
});

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function loginThroughBrowserCallback() {
	let exchangedCode: string | undefined;
	let exchangedRedirectUri: string | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			if (getUrl(input) !== TOKEN_URL) return nativeFetch(input as string, init);
			const body = getJsonBody(init);
			exchangedCode = body.code;
			exchangedRedirectUri = body.redirect_uri;
			return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		}),
	);

	let redirectUri = "";
	let callbackPage: Promise<Response> | undefined;
	const credential = await anthropicOAuth.login({
		signal: neverAbortedSignal,
		notify: (event) => {
			if (event.type !== "auth_url") return;
			const params = new URL(event.url).searchParams;
			redirectUri = params.get("redirect_uri") ?? "";
			const callbackUrl = new URL(redirectUri);
			callbackUrl.hostname = "127.0.0.1";
			callbackUrl.search = new URLSearchParams({
				code: "browser-code",
				state: params.get("state") ?? "",
			}).toString();
			callbackPage = nativeFetch(callbackUrl);
		},
		prompt: (prompt) =>
			prompt.type === "select"
				? Promise.resolve("browser")
				: new Promise((_, reject) => {
						prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}),
	});
	const page = await callbackPage;
	return {
		credential,
		redirectUri,
		exchangedCode,
		exchangedRedirectUri,
		pageStatus: page?.status,
		pageText: await page?.text(),
		pageCsp: page?.headers.get("content-security-policy"),
	};
}
