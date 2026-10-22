import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { readSessionMessages, runWebuiMode } from "../src/modes/webui/webui-server.ts";

// Regression for the webui model sheet losing the thinking level it had just
// written: `/chat` switched models with `setModel`, which falls back to the
// global default (`off` when unset) for a model with no stored level, so a
// level picked in the sheet was replaced before the request was built and
// `/models` reported `off`/null for the model the user had configured.
//
// The defect lived in the endpoint wiring, not in a helper, so the tests drive
// the real backend over HTTP.

const THINKING_LEVEL_MAP = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" };

let runtime: AgentSessionRuntime | undefined;

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

let root = "";
let agentDir = "";
let cwd = "";
let base = "";
let token = "";
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;

async function writeAgentConfig(): Promise<void> {
	// Two reasoning models so a level can be picked for each independently. The
	// faux provider keeps the test offline; no request is ever sent.
	const models = {
		providers: {
			faux: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test",
				models: [
					{ id: "alpha", reasoning: true, thinkingLevelMap: THINKING_LEVEL_MAP },
					{ id: "beta", reasoning: true, thinkingLevelMap: THINKING_LEVEL_MAP },
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
	const created = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "medium" });
	runtime = await createAgentSessionRuntime(async () => ({ ...created, services, diagnostics: [] }), {
		cwd,
		agentDir,
		sessionManager,
	});

	// `runWebuiMode` prints its banner with one `console.log` and never settles.
	// vitest owns the stdout stream, so read the banner from the console call
	// instead: this also pins it to a single write, which is why it is emitted as
	// one line.
	const { port, token: printedToken } = await new Promise<{ port: number; token: string }>((resolve, reject) => {
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
			resolve({ port: Number(listening[1]), token: new URL(open[1] as string).searchParams.get("token") ?? "" });
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

/**
 * One /chat turn. The offline reply fails straight away; waiting for the stream
 * to end also waits for `/chat` to release the turn, which the next request
 * needs (a second concurrent turn is answered with 409).
 */
async function turn(provider: string): Promise<void> {
	const request = await fetch(`${base}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ message: "hi", provider }),
	});
	// Read the stream to its end: `/chat` closes it on the terminal event, which is
	// also when it releases the turn the next request needs (a second concurrent
	// turn is answered with 409). The bound only guards a hang.
	const text = await withTimeout(request.text(), 25_000, `the stream for ${provider}`);
	if (request.status !== 200) throw new Error(`chat was refused with ${request.status}`);
	if (!/data: \{"type":"(done|stopped|error)"/.test(text)) {
		throw new Error(`the chat stream for ${provider} ended before a terminal event`);
	}
}

async function reportedEfforts(): Promise<Record<string, string | null>> {
	const { body } = await api("/models");
	const efforts: Record<string, string | null> = {};
	for (const model of body as { provider_type: string; model: string; reasoning_effort: string | null }[]) {
		if (model.provider_type === "faux") efforts[model.model] = model.reasoning_effort;
	}
	return efforts;
}

async function pickLevel(model: string, level: string): Promise<void> {
	const { status } = await api("/models/reasoning-effort", {
		method: "POST",
		body: JSON.stringify({ provider: `faux/${model}`, reasoning_effort: level }),
	});
	expect(status).toBe(200);
}

beforeEach(async () => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-level-"));
	agentDir = join(root, "agent");
	cwd = join(root, "work");
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	// The backend warms its catalog over the network on startup; stay offline.
	process.env.NANOPI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await writeAgentConfig();
	await startWebui();
}, 30_000);

afterEach(() => {
	runtime = undefined;
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

describe("webui thinking level across a model switch", () => {
	it("keeps the level picked for a model when a turn switches to it", async () => {
		await pickLevel("beta", "high");
		await turn("faux/beta");
		expect(runtime?.session.thinkingLevel).toBe("high");
		expect(await reportedEfforts()).toEqual({ alpha: null, beta: "high" });
	});

	it("leaves a model with no stored level on the session default", async () => {
		// `alpha` runs at the session's medium and nothing is stored for `beta`,
		// so the switch keeps the session level rather than inventing one.
		await turn("faux/beta");
		expect(runtime?.session.thinkingLevel).toBe("medium");
		// `/models` reports `beta` as the active model without a pick of its own.
		expect(await reportedEfforts()).toEqual({ alpha: null, beta: "medium" });
	});

	// The offline provider answers each request on a timer before failing, so a
	// turn takes ~15 s; this test needs three of them.
	it("restores the level of the model it switches back to", { timeout: 120_000 }, async () => {
		await pickLevel("beta", "high");
		await turn("faux/beta");
		await turn("faux/alpha");
		await turn("faux/beta");
		expect(runtime?.session.thinkingLevel).toBe("high");
		expect(await reportedEfforts()).toEqual({ alpha: null, beta: "high" });
	});

	it("applies the level picked for the model already in the session", async () => {
		await pickLevel("alpha", "low");
		expect(runtime?.session.thinkingLevel).toBe("low");
		expect(await reportedEfforts()).toEqual({ alpha: "low", beta: null });
	});
});

describe("webui session detail", () => {
	it("reports the thinking level recorded in the transcript", async () => {
		await pickLevel("beta", "high");
		await turn("faux/beta");
		const file = runtime?.session.sessionFile;
		expect(file).toBeTruthy();
		const { thinking_level } = readSessionMessages(await readFile(file as string, "utf8"));
		expect(thinking_level).toBe("high");
	});

	it("names the model behind each assistant reply", async () => {
		await turn("faux/beta");
		const file = runtime?.session.sessionFile;
		const { messages } = readSessionMessages(await readFile(file as string, "utf8"));
		const replies = messages.filter((message) => message.role === "assistant");
		expect(replies.length).toBeGreaterThan(0);
		expect(replies.every((reply) => reply.provider === "faux/beta")).toBe(true);
	});

	it("derives the plan from the transcript", async () => {
		// The plan lands in the log as tool details, which the messages drop, so
		// the endpoint carries it as its own field; without it a reloaded session
		// shows no plan until the next todo call (issue #152).
		await turn("faux/beta");
		const manager = runtime?.session.sessionManager;
		manager?.appendMessage({
			role: "toolResult",
			toolCallId: "call-plan",
			toolName: "todo",
			content: [{ type: "text", text: "Added 2 todos" }],
			details: {
				action: "add",
				todos: [
					{ id: 1, text: "collect the log", status: "completed" },
					{ id: 2, text: "derive the plan", status: "in_progress" },
				],
			},
			isError: false,
			timestamp: Date.now(),
		});
		const file = runtime?.session.sessionFile as string;
		const { plan } = readSessionMessages(await readFile(file, "utf8"));
		expect(plan).toEqual([
			{ id: 1, text: "collect the log", status: "completed" },
			{ id: 2, text: "derive the plan", status: "in_progress" },
		]);
	});
});
