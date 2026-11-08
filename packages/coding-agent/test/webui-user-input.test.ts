import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@nanopi/pi-ai/compat";
import { extraBridge, modeEngine } from "@nanopi/pi-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runWebuiMode } from "../src/modes/webui/webui-server.ts";
import { enabledModules } from "../src/modules/index.ts";

// Issue #609: a webui turn that calls ask_user_question never reached the
// browser. The composer card is fed by `user_input_request`, which the server
// only emitted from inside a running turn, so a question raised outside one (a
// background turn, a job reporting in) had no reader and hung; the turn's own
// subscription also dropped the request when the turn settled first. The route
// is now one path for both: the broker answers through the process queue, the
// server announces the open request on `/chat/active`, and whoever asks last
// takes the next queued question.

let runtime: AgentSessionRuntime | undefined;
let root = "";
let agentDir = "";
let cwd = "";
let base = "";
let token = "";
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;
let faux: ReturnType<typeof registerFauxProvider> | undefined;

async function startWebui(): Promise<void> {
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		resourceLoaderOptions: {
			modules: enabledModules(),
			noSkills: true,
			noPromptTemplates: true,
		},
	});
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

interface TurnEvents {
	events: any[];
	done: Promise<void>;
}

async function startTurn(message: string): Promise<TurnEvents> {
	const response = await fetch(`${base}/chat`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ message }),
	});
	if (response.status !== 200) throw new Error(`chat was refused with ${response.status}`);
	const events: any[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	const done = (async () => {
		const reader = response.body?.getReader();
		if (!reader) return;
		for (;;) {
			const { done: finished, value } = await reader.read();
			if (finished) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				const line = part.split("\n").find((entry) => entry.startsWith("data:"));
				if (line) events.push(JSON.parse(line.slice("data:".length).trim()));
			}
		}
	})();
	return { events, done };
}

/** Wait for an ask to surface on whichever channel the server uses. */
async function waitForAsk(turn: TurnEvents | undefined, ms = 10_000): Promise<any> {
	const deadline = Date.now() + ms;
	for (;;) {
		const fromTurn = turn?.events.find((event) => event.type === "user_input_request");
		if (fromTurn) return fromTurn;
		const active = await api("/chat/active");
		const pending = (active.body as any[]).find((entry) => entry.user_input !== undefined);
		if (pending) return { type: "user_input_request", ...pending.user_input };
		if (Date.now() > deadline) {
			throw new Error(`no user_input_request; turn saw ${turn?.events.map((e) => e.type).join(",") ?? "nothing"}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

beforeEach(async () => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-user-input-"));
	agentDir = join(root, "agent");
	cwd = join(root, "work");
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	process.env.NANOPI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	faux = registerFauxProvider();
	await writeFile(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					faux: {
						api: faux.api,
						baseUrl: faux.getModel().baseUrl,
						apiKey: "test",
						models: [{ id: "alpha", reasoning: false }],
					},
				},
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "test" } }), "utf8");
	modeEngine.setMode("standard");
	await startWebui();
}, 40_000);

afterEach(() => {
	runtime = undefined;
	faux?.unregister();
	faux = undefined;
	extraBridge.permissions.cancelAll();
	extraBridge.asks.cancelAll();
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

const QUESTION_ARGS = {
	questions: [
		{
			header: "Pick one",
			question: "Which target should I build?",
			options: [
				{ label: "web", description: "the browser bundle" },
				{ label: "node", description: "the server bundle" },
			],
		},
	],
};

describe("webui ask card", () => {
	it("shows the question and hands the answer back to the tool", async () => {
		if (!faux) throw new Error("no faux provider");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user_question", QUESTION_ARGS)], { stopReason: "toolUse" }),
			fauxAssistantMessage("building web"),
		]);

		const turn = await startTurn("build something");
		const request = await waitForAsk(turn);
		expect(request.question).toBe("Which target should I build?");
		expect(request.mode).toBe("single");
		expect(request.options.map((option: any) => option.label)).toEqual(["web", "node"]);

		const answered = await api("/chat/user-input", {
			method: "POST",
			body: JSON.stringify({ request_id: request.request_id, declined: false, selected: ["web"], text: null }),
		});
		expect(answered.body?.accepted).toBe(true);

		await turn.done;
		const output = JSON.stringify(turn.events.filter((event) => event.type === "tool_result"));
		expect(output).toContain("Which target should I build?");
		expect(output).toContain("web");
		expect(output).not.toContain("UI not available");
	}, 40_000);

	it("keeps a question raised with no turn streaming reachable", async () => {
		// A background producer asks with nothing attached to a turn: the request
		// still has to be visible to a tab that reloaded, or it is a silent hang.
		const pending = extraBridge.asks.ask([
			{
				header: "Job",
				question: "Did the run finish?",
				mode: "single",
				options: [{ label: "yes" }, { label: "no" }],
			},
		]);
		const request = await waitForAsk(undefined);
		expect(request.question).toBe("Did the run finish?");

		const answered = await api("/chat/user-input", {
			method: "POST",
			body: JSON.stringify({ request_id: request.request_id, declined: false, selected: ["yes"], text: null }),
		});
		expect(answered.body?.accepted).toBe(true);
		const resolution = await pending;
		expect(resolution).toMatchObject({ type: "single", answer: { selected: ["yes"] } });

		const after = await api("/chat/active");
		expect((after.body as any[]).some((entry) => entry.user_input !== undefined)).toBe(false);
	}, 40_000);
});
