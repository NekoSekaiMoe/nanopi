import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modeEngine } from "@nanopi/pi-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runWebuiMode } from "../src/modes/webui/webui-server.ts";

// The webui's run mode is the process-wide extra engine, and the SPA switches it
// from the settings page. Two defects made that switch inert: `/chat` dropped the
// `approval_mode` field it was sent, and every new session replayed the
// configured default over the mode the user had just picked. Both lived in the
// endpoint wiring, so the tests drive the real server over HTTP.

let runtime: AgentSessionRuntime | undefined;
let root = "";
let agentDir = "";
let cwd = "";
let base = "";
let token = "";
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;

/** Fail a promise instead of hanging the whole test. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function writeAgentConfig(): Promise<void> {
	const models = {
		providers: {
			faux: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test",
				models: [
					{ id: "alpha", reasoning: false, input: ["text"] },
					{ id: "vision", reasoning: false, input: ["text", "image"] },
				],
			},
		},
	};
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "models.json"), `${JSON.stringify(models, null, "\t")}\n`, "utf8");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "test" } }), "utf8");
}

async function startWebui(): Promise<void> {
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const services = await createAgentSessionServices({ cwd, agentDir });
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

async function mode(): Promise<string> {
	const { status, body } = await api("/approval_mode");
	expect(status).toBe(200);
	return body.mode;
}

/** One /chat turn, read to its terminal event so the turn is released. */
async function turn(fields: Record<string, unknown>): Promise<void> {
	const request = await fetch(`${base}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ message: "hi", ...fields }),
	});
	if (request.status !== 200) throw new Error(`chat was refused with ${request.status}`);
	const text = await withTimeout(request.text(), 25_000, "the chat stream");
	if (!/data: \{"type":"(done|stopped|error)"/.test(text)) {
		throw new Error("the chat stream ended before a terminal event");
	}
}

beforeEach(async () => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-mode-"));
	agentDir = join(root, "agent");
	cwd = join(root, "work");
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	// The backend warms its catalog over the network on startup; stay offline.
	process.env.NANOPI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await writeAgentConfig();
	// The engine is a process singleton: start every test from standard, or a mode
	// left by the previous one looks like a session reset that never happened.
	modeEngine.setMode("standard");
	await startWebui();
}, 40_000);

afterEach(() => {
	runtime = undefined;
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

describe("webui run mode", () => {
	it("starts in standard and switches through /approval_mode", async () => {
		expect(await mode()).toBe("standard");
		const switched = await api("/approval_mode", { method: "POST", body: JSON.stringify({ mode: "plan" }) });
		expect(switched.body).toEqual({ ok: true, mode: "plan" });
		expect(await mode()).toBe("plan");
		const rejected = await api("/approval_mode", { method: "POST", body: JSON.stringify({ mode: "bogus" }) });
		expect(rejected.status).toBe(400);
		expect(await mode()).toBe("plan");
	});

	it("applies the mode a turn carries", async () => {
		// The settings page switches the engine directly, but a turn also carries
		// the mode, which `/chat` used to drop on the floor.
		await turn({ approval_mode: "minimal" });
		expect(await mode()).toBe("minimal");
		await turn({ approval_mode: "standard" });
		expect(await mode()).toBe("standard");
	});

	it("ignores an invalid mode on a turn instead of failing it", async () => {
		await api("/approval_mode", { method: "POST", body: JSON.stringify({ mode: "plan" }) });
		await turn({ approval_mode: "bogus" });
		expect(await mode()).toBe("plan");
	});

	it("keeps the picked mode when a new session is created", async () => {
		await api("/approval_mode", { method: "POST", body: JSON.stringify({ mode: "minimal" }) });
		const created = await api("/sessions", { method: "POST", body: "{}" });
		expect(created.status).toBe(200);
		// The SPA creates the session on the first send; replaying `defaultMode`
		// there wiped the mode the user had just picked.
		expect(await mode()).toBe("minimal");
	});

	it("streams the live mode and its changes", async () => {
		// The settings page highlight follows this stream, so a mode switched from
		// inside a turn (plan mode exiting) does not leave a stale button lit.
		const controller = new AbortController();
		const response = await fetch(`${base}/mode/stream`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("the mode stream has no body");
		const decoder = new TextDecoder();
		const events: { mode: string; reason?: string }[] = [];
		const read = async (): Promise<void> => {
			const { done, value } = await reader.read();
			if (done) return;
			for (const part of decoder.decode(value, { stream: true }).split("\n\n")) {
				const line = part.split("\n").find((entry) => entry.startsWith("data:"));
				if (line) events.push(JSON.parse(line.slice("data:".length).trim()));
			}
		};
		await withTimeout(read(), 5000, "the first mode event");
		expect(events[0]).toEqual({ mode: "standard" });

		await api("/approval_mode", { method: "POST", body: JSON.stringify({ mode: "plan" }) });
		await withTimeout(read(), 5000, "the mode change event");
		expect(events.at(-1)).toEqual({ mode: "plan", reason: "webui" });
		controller.abort();
	});

	it("reports which models take images", async () => {
		// The composer has to know before it shows the attach button: a turn with
		// an image on a text-only model would be answered around the image.
		const { status, body } = await api("/models");
		expect(status).toBe(200);
		const rows = body as { model: string; supports_image: boolean }[];
		expect(rows.find((row) => row.model === "alpha")?.supports_image).toBe(false);
		expect(rows.find((row) => row.model === "vision")?.supports_image).toBe(true);
	});

	it("refuses an image on a model that cannot read it", async () => {
		// The adapters drop the image and send a placeholder, so the turn would
		// silently answer a question about a picture it never saw.
		const request = await fetch(`${base}/chat`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({
				message: "what is this",
				images: [{ media_type: "image/png", data: "AAAA" }],
			}),
		});
		expect(request.status).toBe(400);
		expect(await request.json()).toMatchObject({ code: "model_without_image" });
	});

	it("persists the default mode for new sessions without touching the live one", async () => {
		await api("/extra/settings", { method: "PUT", body: JSON.stringify({ defaultMode: "plan" }) });
		expect(await mode()).toBe("standard");
		const stored = JSON.parse(await readFile(join(agentDir, "extra", "settings.json"), "utf8"));
		expect(stored.defaultMode).toBe("plan");
	});
});

describe("webui filesystem endpoints", () => {
	it("keeps /fs/list, /fs/read and /fs/write inside the workspace", async () => {
		// The endpoints resolved any path the browser sent and took the raw string
		// for /fs/list, so the pair was a read-anywhere / create-anywhere API.
		const outside = join(root, "outside");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret.txt"), "nope", "utf8");

		const list = await api(`/fs/list?path=${encodeURIComponent(outside)}`);
		expect(list.status).toBe(403);
		const read = await api(`/fs/read?path=${encodeURIComponent(join(outside, "secret.txt"))}`);
		expect(read.status).toBe(403);
		const write = await api("/fs/write", {
			method: "POST",
			body: JSON.stringify({ path: join(outside, "planted.txt"), content: "x" }),
		});
		expect(write.status).toBe(403);
		const mkdirResponse = await api("/fs/mkdir", {
			method: "POST",
			body: JSON.stringify({ path: join(outside, "planted") }),
		});
		expect(mkdirResponse.status).toBe(403);
	});

	it("still serves the workspace root and its files", async () => {
		await writeFile(join(cwd, "inside.txt"), "hello", "utf8");
		const list = await api(`/fs/list?path=${encodeURIComponent(cwd)}`);
		expect(list.status).toBe(200);
		expect(list.body.files).toContain("inside.txt");

		const read = await api(`/fs/read?path=${encodeURIComponent(join(cwd, "inside.txt"))}`);
		expect(read.status).toBe(200);
		expect(read.body.content).toBe("hello");

		const written = await api("/fs/write", {
			method: "POST",
			body: JSON.stringify({ path: join(cwd, "written.txt"), content: "ok" }),
		});
		expect(written.status).toBe(200);
		expect(await readFile(join(cwd, "written.txt"), "utf8")).toBe("ok");
	});

	it("answers /extra paths as API, not with the SPA shell", async () => {
		// The API prefix list did not include `extra`, so a GET under it fell
		// through to the SPA fallback and answered index.html: a JSON client got
		// HTML with 200 instead of the endpoint's own status.
		const state = await fetch(`${base}/extra/state`, { headers: { authorization: `Bearer ${token}` } });
		expect(state.headers.get("content-type")).toContain("application/json");

		const unknown = await fetch(`${base}/extra/nope`, { headers: { authorization: `Bearer ${token}` } });
		expect(unknown.headers.get("content-type")).not.toContain("text/html");
	});
});
