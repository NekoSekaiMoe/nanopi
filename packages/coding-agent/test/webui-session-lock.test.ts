import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { CURRENT_SESSION_VERSION } from "../src/core/session-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runWebuiMode } from "../src/modes/webui/webui-server.ts";

// Issue #601: the webui lock was a process-wide boolean, so a turn in one tab
// refused another tab's turn in a *different* session, `/chat/stop` ignored its
// body and aborted whatever was running, and `/chat/active` could only say
// "something is running". The lock is now per session, and these tests drive the
// endpoints over HTTP because the defects lived in the wiring.

let runtime: AgentSessionRuntime | undefined;
let root = "";
let agentDir = "";
let cwd = "";
let base = "";
let token = "";
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;

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

/** Open a `/chat` stream and stop reading at the SSE head, so the turn keeps running. */
async function openTurn(body: Record<string, unknown>): Promise<{ status: number; abort: () => void }> {
	const controller = new AbortController();
	const response = await fetch(`${base}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
		signal: controller.signal,
	});
	const status = response.status;
	// Do not drain the body: the turn settles on the server, not on the client.
	controller.abort();
	return { status, abort: () => controller.abort() };
}

/** Poll `/chat/active` until it satisfies `done`, or fail after a few seconds. */
async function untilActive(done: (turns: any[]) => boolean, timeoutMs = 5000): Promise<any[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { body } = await api("/chat/active");
		const turns = Array.isArray(body) ? body : [];
		if (done(turns)) return turns;
		if (Date.now() > deadline) throw new Error(`/chat/active never settled: ${JSON.stringify(body)}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * Create a second session with one message already written, and return its id.
 *
 * `/chat` resolves a session id through `SessionManager.listAll()`, which reads
 * session files; a manager that never wrote one (nothing to flush yet) is not on
 * that list, so the file has to exist before the endpoint can be asked about it.
 */
async function createSession(): Promise<string> {
	const id = randomUUID();
	const sessionDir = join(agentDir, "sessions", "project");
	await mkdir(sessionDir, { recursive: true });
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: new Date().toISOString(), cwd };
	const message = {
		type: "message",
		id: randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: "seed" }] },
	};
	const info = {
		type: "session_info",
		id: randomUUID(),
		parentId: message.id,
		timestamp: new Date().toISOString(),
		name: `session ${id.slice(0, 8)}`,
	};
	await writeFile(
		join(sessionDir, `${id}.jsonl`),
		`${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(info)}\n`,
		"utf8",
	);
	return id;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-lock-"));
	agentDir = join(root, "agent");
	cwd = join(root, "workspace");
	await mkdir(cwd, { recursive: true });
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	process.env.NANOPI_OFFLINE = "1";
	await writeAgentConfig();
	await startWebui();
});

afterEach(() => {
	runtime = undefined;
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

describe("webui per-session turn lock (#601)", () => {
	it("reports an idle daemon with an empty turn list", async () => {
		const { status, body } = await api("/chat/active");
		expect(status).toBe(200);
		expect(body).toEqual([]);
	});

	it("names the turn holding a session instead of failing the whole process", async () => {
		const session = await createSession();
		const started = await openTurn({ message: "hold this session", session_id: session, request_id: "turn-a" });
		expect(started.status).toBe(200);

		// The lock is per session: the busy one names its holder...
		const busy = await openTurn({ message: "second turn", session_id: session, request_id: "turn-b" });
		expect(busy.status).toBe(409);
		const active = await untilActive((turns) => turns.length > 0);
		expect(active[0]).toMatchObject({ session_id: session, turn_id: "turn-a" });
		expect(typeof active[0].started_at).toBe("number");

		// ...and a turn on a session that is not running is not refused by it.
		const other = await createSession();
		const parallel = await openTurn({ message: "another session", session_id: other, request_id: "turn-c" });
		expect(parallel.status).toBe(200);
		await untilActive((turns) => turns.some((turn) => turn.turn_id === "turn-c"));

		await api("/chat/stop-all", { method: "POST" });
		await untilActive((turns) => turns.length === 0);
	});

	it("stops only the turn it is asked to stop", async () => {
		const first = await createSession();
		const second = await createSession();
		expect((await openTurn({ message: "one", session_id: first, request_id: "turn-a" })).status).toBe(200);
		expect((await openTurn({ message: "two", session_id: second, request_id: "turn-b" })).status).toBe(200);
		await untilActive((turns) => turns.length === 2);

		const stopped = await api("/chat/stop", {
			method: "POST",
			body: JSON.stringify({ session_id: first, request_id: "turn-a" }),
		});
		expect(stopped.status).toBe(200);
		expect(stopped.body).toEqual({ stopped: true, turns: ["turn-a"] });

		// The untouched session keeps running: this is the defect the issue names.
		const remaining = await untilActive((turns) => turns.length === 1);
		expect(remaining[0]).toMatchObject({ session_id: second, turn_id: "turn-b" });

		await api("/chat/stop-all", { method: "POST" });
		await untilActive((turns) => turns.length === 0);
	});

	it("does not stop a turn when the request id belongs to another tab", async () => {
		const session = await createSession();
		expect((await openTurn({ message: "hold", session_id: session, request_id: "turn-a" })).status).toBe(200);
		await untilActive((turns) => turns.length === 1);

		const missed = await api("/chat/stop", {
			method: "POST",
			body: JSON.stringify({ session_id: session, request_id: "turn-b" }),
		});
		expect(missed.status).toBe(200);
		expect(missed.body).toEqual({ stopped: false, turns: [] });
		expect((await api("/chat/active")).body).toHaveLength(1);

		await api("/chat/stop-all", { method: "POST" });
		await untilActive((turns) => turns.length === 0);
	});

	it("stops every running turn through /chat/stop-all", async () => {
		const first = await createSession();
		const second = await createSession();
		expect((await openTurn({ message: "one", session_id: first, request_id: "turn-a" })).status).toBe(200);
		expect((await openTurn({ message: "two", session_id: second, request_id: "turn-b" })).status).toBe(200);
		await untilActive((turns) => turns.length === 2);

		const stopped = await api("/chat/stop-all", { method: "POST" });
		expect(stopped.status).toBe(200);
		expect(stopped.body.stopped).toBe(true);
		expect([...stopped.body.turns].sort()).toEqual(["turn-a", "turn-b"]);
		await untilActive((turns) => turns.length === 0);
	});
});
