import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createProvider,
	fauxProvider,
	InMemoryModelsStore,
	type OAuthCredential,
	type ProviderStreams,
} from "@nanopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runWebuiMode } from "../src/modes/webui/webui-server.ts";
import { enabledModules } from "../src/modules/index.ts";

// Issue #609: the webui had no OAuth login. The endpoints existed but the page
// never called them, and `prompt()` threw "run `nanopi /login` in the CLI
// instead", so the flows that ask a question (OpenAI and Anthropic ask which
// login method, then for a pasted code) could not finish in the browser at all.
// These cases drive the real server against a provider that behaves like those
// flows: notify a url, ask a select, then ask for a manual code, and only then
// store a credential.

const PROVIDER = "faux-oauth";

let runtime: AgentSessionRuntime | undefined;
let modelRuntime: ModelRuntime | undefined;
let root = "";
let agentDir = "";
let cwd = "";
let base = "";
let token = "";
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;

/** What the last /extra/oauth/login started, so a case can assert on it. */
const seen: { signal: AbortSignal | undefined; logins: number } = { signal: undefined, logins: 0 };

function credential(): OAuthCredential {
	return { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 3_600_000 };
}

/**
 * A provider shaped like the real subscription flows: two questions, one url,
 * and a credential only after both answers arrive.
 */
function oauthProvider() {
	const faux = fauxProvider({ provider: PROVIDER, models: [{ id: "alpha", reasoning: false }] });
	// `createProvider` requires an implementation; nothing here streams.
	const api: ProviderStreams = {
		stream: () => {
			throw new Error("the faux oauth provider is not expected to stream");
		},
		streamSimple: () => {
			throw new Error("the faux oauth provider is not expected to stream");
		},
	};
	const provider = createProvider({
		id: PROVIDER,
		name: "Faux Subscription",
		models: faux.models,
		// The stream is never used: these cases only log in and list models.
		api,
		auth: {
			oauth: {
				name: "Faux Subscription",
				loginLabel: "Sign in with Faux",
				async login(interaction) {
					seen.logins++;
					seen.signal = interaction.signal;
					interaction.notify({
						type: "auth_url",
						url: "https://example.invalid/authorize",
						instructions: "pick one",
					});
					const method = await interaction.prompt({
						type: "select",
						message: "How do you want to sign in?",
						options: [
							{ id: "browser", label: "Browser" },
							{ id: "code", label: "Paste a code" },
						],
					});
					if (method === "code") {
						await interaction.prompt({ type: "manual_code", message: "Paste the code", placeholder: "abc-123" });
					}
					interaction.notify({ type: "progress", message: "storing the token" });
					return credential();
				},
				async refresh(current) {
					return current;
				},
				async toAuth() {
					return { apiKey: "oauth-token" };
				},
			},
			apiKey: { name: "Faux key", resolve: async () => ({ auth: {} }) },
		},
	});
	return provider;
}

async function startWebui(): Promise<void> {
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
	modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(oauthProvider());
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		modelRuntime,
		resourceLoaderOptions: {
			modules: enabledModules(),
			noSkills: true,
			noPromptTemplates: true,
		},
	});
	const model = services.modelRuntime.getModel(PROVIDER, "alpha");
	if (!model) throw new Error(`${PROVIDER}/alpha is missing from the provider catalog`);
	const created = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "off" });
	runtime = await createAgentSessionRuntime(async () => ({ ...created, services, diagnostics: [] }), {
		cwd,
		agentDir,
		sessionManager,
	});
	const { port, printedToken } = await new Promise<{ port: number; printedToken: string }>((resolve, reject) => {
		const original = console.log;
		const timer = setTimeout(() => {
			console.log = original;
			reject(new Error("the webui server never reported its url"));
		}, 20_000);
		console.log = (...args: unknown[]) => {
			const text = args.map(String).join(" ");
			if (!text.startsWith("nanopi webui listening on ")) {
				original(...args);
				return;
			}
			clearTimeout(timer);
			console.log = original;
			const listening = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
			const open = /Open: (http:\/\/[^\s]+)/.exec(text);
			if (!listening || !open) {
				reject(new Error(`unexpected webui banner: ${text}`));
				return;
			}
			resolve({
				port: Number(listening[1]),
				printedToken: new URL(open[1] as string).searchParams.get("token") ?? "",
			});
		};
		void runWebuiMode(runtime as AgentSessionRuntime, { port: 0, host: "127.0.0.1" }).catch(() => {});
	});
	token = printedToken;
	base = `http://127.0.0.1:${port}`;
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			...(init?.headers ?? {}),
		},
	});
	const text = await response.text();
	try {
		return { status: response.status, body: JSON.parse(text) };
	} catch {
		return { status: response.status, body: text };
	}
}

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
	return api(path, { method: "POST", body: JSON.stringify(body) });
}

/** Poll the flow until it reports the state the case expects. */
async function waitForStatus(flowId: string, want: (status: any) => boolean, ms = 10_000): Promise<any> {
	const deadline = Date.now() + ms;
	for (;;) {
		const { status, body } = await api(`/extra/oauth/status?flow=${flowId}`);
		if (status === 200 && want(body)) return body;
		if (Date.now() > deadline)
			throw new Error(`flow ${flowId} never reached the expected state: ${JSON.stringify(body)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

beforeEach(async () => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-oauth-"));
	agentDir = join(root, "agent");
	cwd = join(root, "work");
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	process.env.NANOPI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	seen.signal = undefined;
	seen.logins = 0;
	await startWebui();
}, 40_000);

afterEach(() => {
	runtime = undefined;
	modelRuntime = undefined;
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

describe("webui oauth login", () => {
	it("lists the provider in /config so the page has something to render", async () => {
		const { status, body } = await api("/config");
		expect(status).toBe(200);
		const listed = body.oauth_providers.find((entry: any) => entry.id === PROVIDER);
		expect(listed).toMatchObject({ name: "Faux Subscription", login_label: "Sign in with Faux", logged_in: false });
	}, 20_000);

	it("answers a select and a manual code, then reports the provider as signed in", async () => {
		const started = await post("/extra/oauth/login", { provider: PROVIDER });
		expect(started.status).toBe(200);
		const flowId = started.body.flow_id as string;
		expect(flowId).toBeTruthy();

		// The url and the first question reach the page.
		const asking = await waitForStatus(flowId, (status) => status.prompt?.type === "select");
		expect(asking.url).toBe("https://example.invalid/authorize");
		expect(asking.info).toBe("pick one");
		expect(asking.prompt.options.map((option: any) => option.id)).toEqual(["browser", "code"]);

		// Selecting the pasted-code method is what makes the flow ask for the code:
		// that second question is the one the CLI-only prompt used to swallow.
		expect((await post("/extra/oauth/prompt", { flow: flowId, value: "code" })).status).toBe(200);
		const coding = await waitForStatus(flowId, (status) => status.prompt?.type === "manual_code");
		expect(coding.prompt).toMatchObject({ message: "Paste the code", placeholder: "abc-123" });

		expect((await post("/extra/oauth/prompt", { flow: flowId, value: "abc-123" })).status).toBe(200);
		const done = await waitForStatus(flowId, (status) => status.status !== "pending");
		expect(done).toMatchObject({ status: "done", provider: PROVIDER });

		// A stored credential is what makes the provider usable, and the page reads
		// both the config and the model list back after a login.
		const config = await api("/config");
		expect(config.body.oauth_providers.find((entry: any) => entry.id === PROVIDER).logged_in).toBe(true);
		const models = await api("/models");
		expect(models.body.some((model: any) => model.provider_type === PROVIDER)).toBe(true);
	}, 40_000);

	it("reuses the pending flow instead of starting a second login", async () => {
		const first = await post("/extra/oauth/login", { provider: PROVIDER });
		await waitForStatus(first.body.flow_id, (status) => status.prompt?.type === "select");
		const again = await post("/extra/oauth/login", { provider: PROVIDER });
		expect(again.body).toMatchObject({ flow_id: first.body.flow_id, reused: true });
		expect(seen.logins).toBe(1);
		await post("/extra/oauth/cancel", { flow: first.body.flow_id });
	}, 40_000);

	it("stops the flow on cancel, and logout drops the credential", async () => {
		const started = await post("/extra/oauth/login", { provider: PROVIDER });
		const flowId = started.body.flow_id as string;
		await waitForStatus(flowId, (status) => status.prompt?.type === "select");

		expect((await post("/extra/oauth/cancel", { flow: flowId })).status).toBe(200);
		const cancelled = await waitForStatus(flowId, (status) => status.status !== "pending");
		expect(cancelled.status).toBe("error");
		expect(seen.signal?.aborted).toBe(true);

		// Finish a login so there is a credential to remove.
		const second = await post("/extra/oauth/login", { provider: PROVIDER });
		const liveId = second.body.flow_id as string;
		await waitForStatus(liveId, (status) => status.prompt?.type === "select");
		await post("/extra/oauth/prompt", { flow: liveId, value: "browser" });
		await waitForStatus(liveId, (status) => status.status === "done");
		expect((await api("/config")).body.oauth_providers.find((e: any) => e.id === PROVIDER).logged_in).toBe(true);

		expect((await post("/extra/oauth/logout", { provider: PROVIDER })).status).toBe(200);
		expect((await api("/config")).body.oauth_providers.find((e: any) => e.id === PROVIDER).logged_in).toBe(false);
	}, 40_000);

	it("refuses a provider without an oauth flow and an unknown flow id", async () => {
		expect((await post("/extra/oauth/login", { provider: "nope" })).status).toBe(400);
		expect((await post("/extra/oauth/prompt", { flow: "missing", value: "x" })).status).toBe(404);
		expect((await api("/extra/oauth/status?flow=missing")).status).toBe(404);
	}, 20_000);
});
