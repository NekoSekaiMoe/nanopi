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

// Issue #293: the webui permission card never appeared. The gate paused every
// gated call on `explain()` before `check()` ran, and the pause reached it as
// "no answer" (the broker's prompter reports an unanswered prompt as
// `undefined`), which `explain()` read as a dismissal: the call failed with
// "the permission prompt for this bash call was dismissed" and the browser was
// never sent a `permission_request`. These cases drive the real server so the
// whole path (tool call -> broker -> SSE -> POST /chat/permission) is covered.

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
	// `main.ts` mounts the built-in modules; a test that skips it has no `extra`
	// module, which is exactly the wiring that owns the permission gate.
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
	answer: (decision: string, callId: string) => Promise<boolean>;
}

/**
 * Start a /chat turn and return as soon as it is streaming.
 *
 * The turn blocks on the permission prompt, so the response cannot be read to
 * the end before the prompt is answered: the SSE body is consumed in the
 * background and `done` settles when the stream closes.
 */
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
	return {
		events,
		done,
		answer: async (decision, callId) => {
			const result = await api("/chat/permission", {
				method: "POST",
				body: JSON.stringify({ decision, call_id: callId }),
			});
			return result.body?.success === true;
		},
	};
}

/** Wait for one SSE event of a type the server may emit a tick after the call. */
async function waitFor(turn: TurnEvents, type: string, ms = 10_000): Promise<any> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = turn.events.find((event) => event.type === type);
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`no ${type} event; saw ${turn.events.map((e) => e.type).join(",")}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

beforeEach(async () => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	previousOffline = process.env.NANOPI_OFFLINE;
	root = await mkdtemp(join(tmpdir(), "nanopi-webui-permission-"));
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
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	if (previousOffline === undefined) delete process.env.NANOPI_OFFLINE;
	else process.env.NANOPI_OFFLINE = previousOffline;
});

describe("webui permission card", () => {
	it("streams the prompt and runs the call once the card allows it", async () => {
		if (!faux) throw new Error("no faux provider");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo card", description: "print" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		const turn = await startTurn("run echo");
		const prompt = await waitFor(turn, "permission_request");
		expect(prompt.tool_name).toBe("bash");
		expect(prompt.call_id).toBeTruthy();
		expect(prompt.explainable).toBe(true);
		// The arguments are what the card prints, so they have to be the call's.
		expect(prompt.arguments).toMatchObject({ command: "echo card" });

		expect(await turn.answer("allow_once", prompt.call_id)).toBe(true);
		await turn.done;
		// Nothing was refused: the model got the tool result and answered.
		expect(turn.events.some((event) => event.type === "tool_result" && event.success === true)).toBe(true);
		expect(turn.events.at(-1)?.type).toBe("done");
	}, 40_000);

	it("keeps the card up across an explanation and runs the call after it", async () => {
		if (!faux) throw new Error("no faux provider");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo explain", description: "print" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("that echoes a string"),
			fauxAssistantMessage("done"),
		]);

		const turn = await startTurn("run echo");
		const prompt = await waitFor(turn, "permission_request");
		expect(await turn.answer("explain", prompt.call_id)).toBe(true);
		await waitFor(turn, "permission_explained");
		// The prompt was paused, not answered: the call has not run yet.
		expect(turn.events.some((event) => event.type === "tool_result")).toBe(false);

		expect(await turn.answer("allow_once", prompt.call_id)).toBe(true);
		await turn.done;
		expect(turn.events.some((event) => event.type === "tool_result" && event.success === true)).toBe(true);
	}, 40_000);

	it("refuses the call the card rejects", async () => {
		if (!faux) throw new Error("no faux provider");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo deny", description: "print" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("understood"),
		]);

		const turn = await startTurn("run echo");
		const prompt = await waitFor(turn, "permission_request");
		expect(await turn.answer("deny", prompt.call_id)).toBe(true);
		await turn.done;
		const result = turn.events.find((event) => event.type === "tool_result");
		expect(result?.success).toBe(false);
	}, 40_000);
});
