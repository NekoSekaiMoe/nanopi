import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runWebuiMode } from "../src/modes/webui/webui-server.ts";

// Regression for #609: an account added from the webui was written with the
// listing protocol (`openai`) as its `api`, so creation and /models both looked
// fine while every turn failed with "No API provider registered for api:
// openai". The defect was in the account writer and the chat path is what shows
// it, so the test drives the real server and a stub OpenAI-compatible endpoint.

let runtime: AgentSessionRuntime | undefined;
let root = "";
let agentDir = "";
let cwd = "";
let base = "";
let token = "";
let stub: Server | undefined;
let stubBaseUrl = "";
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;

/** An OpenAI-compatible endpoint: a model listing and one streamed reply. */
async function startStub(): Promise<void> {
	stub = createServer((req, res) => {
		if (req.url?.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;
		res.write(chunk({ id: "1", choices: [{ delta: { role: "assistant", content: "pong" } }] }));
		res.write(
			chunk({
				id: "1",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			}),
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => stub?.listen(0, "127.0.0.1", resolve));
	const address = stub?.address();
	if (typeof address === "object" && address) stubBaseUrl = `http://127.0.0.1:${address.port}/v1`;
}

async function startWebui(): Promise<void> {
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });
	const created = await createAgentSessionFromServices({ services, sessionManager, thinkingLevel: "off" });
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

/** One /chat turn, read to its terminal event. */
async function turn(provider: string): Promise<string> {
	const response = await fetch(`${base}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ message: "hi", provider }),
	});
	if (response.status !== 200) throw new Error(`chat was refused with ${response.status}`);
	return response.text();
}

beforeEach(async () => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-provider-add-"));
	agentDir = join(root, "agent");
	cwd = join(root, "work");
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	// The catalog points at a stub; a network refresh would only add noise.
	process.env.NANOPI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "models.json"), `${JSON.stringify({ providers: {} }, null, "\t")}\n`, "utf8");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({}), "utf8");
	await startStub();
	await startWebui();
}, 60_000);

afterEach(() => {
	runtime = undefined;
	stub?.close();
	stub = undefined;
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

describe("webui provider account add", () => {
	it("writes an api the runtime can serve, so the account chats", async () => {
		const posted = await api("/provider-accounts", {
			method: "POST",
			body: JSON.stringify({
				provider: "openai-compatible",
				base_url: stubBaseUrl,
				api_key: "sk-test",
				models: [{ model: "stub-model" }],
			}),
		});
		expect(posted.status).toBe(200);

		const onDisk = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { api?: string }>;
		};
		expect(onDisk.providers["openai-compatible"]?.api).toBe("openai-completions");

		const listed = await api("/models");
		expect(listed.body.map((model: { provider: string }) => model.provider)).toContain(
			"openai-compatible/stub-model",
		);

		const stream = await turn("openai-compatible/stub-model");
		expect(stream).not.toContain("No API provider registered");
		expect(stream).toContain('"content":"pong"');
	}, 60_000);

	it("adds a second account of the same protocol under its own id", async () => {
		const body = {
			provider: "openai-compatible",
			base_url: stubBaseUrl,
			api_key: "sk-test",
			models: [{ model: "stub-model" }],
		};
		expect((await api("/provider-accounts", { method: "POST", body: JSON.stringify(body) })).status).toBe(200);
		// Without an id the second create collides with the first account.
		expect((await api("/provider-accounts", { method: "POST", body: JSON.stringify(body) })).status).toBe(409);
		const named = await api("/provider-accounts", { method: "POST", body: JSON.stringify({ ...body, id: "gw2" }) });
		expect(named.status).toBe(200);
		expect(await turn("gw2/stub-model")).toContain('"content":"pong"');
	}, 60_000);
});
