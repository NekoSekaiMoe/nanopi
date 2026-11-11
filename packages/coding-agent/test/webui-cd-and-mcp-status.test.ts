import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPackageDir } from "../src/config.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runWebuiMode } from "../src/modes/webui/webui-server.ts";

// Issue #595: the webui backend answered several endpoints with a fixed reply
// that was not true. `/cd` reported the launch directory after moving nowhere,
// `/mcp/status` reported an empty server list for every build, and `/live`,
// `/tunnel/status`, `/fs/search` and `/model-profiles` existed only as stubs.
// The endpoints are driven over HTTP because the defects were in the wiring,
// not in a helper.

let runtime: AgentSessionRuntime | undefined;
let root = "";
let agentDir = "";
let cwd = "";
let base = "";
let token = "";
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;
/** The SPA fallback needs built assets; without them an unmatched GET 404s as text. */
const distExists = existsSync(join(getPackageDir(), "..", "webui", "dist", "index.html"));

async function writeAgentConfig(): Promise<void> {
	const models = {
		providers: {
			faux: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test",
				models: [{ id: "alpha", reasoning: false, input: ["text"] }],
			},
		},
	};
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`, "utf8");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "test" } }), "utf8");
}

async function startWebui(): Promise<void> {
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });
	const model = services.modelRuntime.getModel("faux", "alpha");
	if (!model) throw new Error("faux/alpha is missing from the test catalog");
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

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-cd-"));
	agentDir = join(root, "agent");
	cwd = join(root, "workspace");
	await mkdir(cwd, { recursive: true });
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	// The catalog points at a closed port; a startup refresh would only add noise.
	process.env.NANOPI_OFFLINE = "1";
	await writeAgentConfig();
	await startWebui();
});

afterEach(() => {
	// The server outlives each test (it listens until the process exits), exactly
	// as in webui-run-mode.test.ts; the runtime is simply dropped.
	runtime = undefined;
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

describe("webui /cd", () => {
	it("answers with the directory it opened, not the launch directory", async () => {
		const target = join(cwd, "nested");
		await mkdir(target, { recursive: true });

		const moved = await api("/cd", { method: "POST", body: JSON.stringify({ path: target }) });
		expect(moved.status).toBe(200);
		expect(moved.body.success).toBe(true);
		expect(moved.body.current_dir).toBe(target);

		// The SPA keys its session list off /project, which has to agree.
		const project = await api("/project");
		expect(project.body.working_dir).toBe(target);
		expect(project.body.project_hash).toBe(moved.body.project_hash);
	});

	it("refuses a directory outside the workspace without moving", async () => {
		const refused = await api("/cd", { method: "POST", body: JSON.stringify({ path: root }) });
		expect(refused.status).toBe(400);
		expect(refused.body.success).toBe(false);
		expect(refused.body.current_dir).toBe(cwd);
	});
});

describe("webui /mcp/status", () => {
	it("lists the servers mcp-lite would load instead of an empty list", async () => {
		// Discovery is off so the files this machine has for other clients (Cursor,
		// Claude, Codex) do not decide what the assertion sees.
		await writeFile(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				discovery: { mode: "off" },
				mcpServers: { docs: { transport: "http", url: "http://127.0.0.1:1/mcp" } },
			}),
			"utf8",
		);

		const status = await api("/mcp/status");
		expect(status.status).toBe(200);
		expect(status.body.available).toBe(true);
		expect(status.body.servers).toEqual([
			expect.objectContaining({ name: "docs", status: "configured", transport: "http" }),
		]);
	});
});

describe("webui stubbed AtomCode endpoints", () => {
	it("answers POST-only endpoints that nothing calls and no longer exist with 404", async () => {
		// A GET on /live is a static-asset request for a path with no file, which
		// is what the SPA fallback serves; only the stubbed verbs are evidence.
		const { status, body } = await api("/live/mcp/trust", { method: "POST" });
		expect(status).toBe(404);
		expect(body).toEqual({ error: "no such endpoint: POST /live/mcp/trust" });
	});

	it("no longer answers the read-only endpoints nothing calls", async () => {
		for (const path of ["/tunnel/status", "/fs/search", "/model-profiles"]) {
			const { status, body } = await api(path);
			// `/fs/search` retains the `/fs` prefix, so it reaches the API router and
			// 404s as JSON. The other two never matched an API route, so a GET falls
			// through to the SPA shell when the assets are built and 404s as plain
			// text when they are not; the stub is gone either way, and only a verb
			// the router rejects can prove it.
			if (typeof body === "string" && !distExists) {
				expect(status, path).toBe(404);
				expect(body, path).toContain("webui assets are not built");
				continue;
			}
			if (body.error === undefined) {
				expect(status, path).toBe(200);
				expect(body.toLowerCase(), path).toContain("<!doctype html");
				continue;
			}
			expect(status, path).toBe(404);
			expect(body, path).toEqual({ error: `no such endpoint: GET ${path}` });
		}
	});
});
