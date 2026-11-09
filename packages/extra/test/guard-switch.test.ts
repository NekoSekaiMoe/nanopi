import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createExtraExtension } from "../src/extension.ts";
import type { ExtraExtensionAPI, ExtraExtensionContext } from "../src/extension-api.ts";
import { modeEngine } from "../src/mode-engine.ts";
import {
	globalExtraSettingsPath,
	globalGuardValue,
	projectExtraSettingsPath,
	projectGuardValue,
} from "../src/settings-store.ts";

// Guard switches are read from two files and shown to the user in three places
// (bare command, session-start confirmation, the write itself). These drive the
// real extension factory so the three cannot drift apart.

const TOOLS = ["read", "write", "edit", "bash", "grep"];

let home = "";
let agentDir = "";
let projectDir = "";
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	home = mkdtempSync(join(tmpdir(), "nanopi-guard-switch-"));
	agentDir = join(home, "agent");
	projectDir = join(home, "project");
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	mkdirSync(projectDir, { recursive: true });
	modeEngine.setMode("standard");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	modeEngine.setMode("standard");
	rmSync(home, { recursive: true, force: true });
});

interface Harness {
	/** `args` is the whole slash-argument string, spaces included. */
	run: (name: string, args?: string) => Promise<string | undefined>;
	/** Session start with an answer to the confirmation dialog; `select` returns it. */
	start: (answers: Array<string | undefined>, reason?: "startup" | "reload") => Promise<void>;
	notes: string[];
	questions: string[];
	registered: string[];
}

function harness(options: { hasUI?: boolean } = {}): Harness {
	// Bound at creation: the module-level paths are reassigned per test, and a
	// closure that reads them later would point at the previous test's tree.
	const cwd = projectDir;
	const handlers = new Map<string, (payload: unknown, ctx: ExtraExtensionContext) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtraExtensionContext) => unknown>();
	const notes: string[] = [];
	const questions: string[] = [];
	const api = {
		registerFlag: () => undefined,
		registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtraExtensionContext) => unknown }) => {
			commands.set(name, opts.handler);
		},
		on: (event: string, handler: (payload: unknown, ctx: ExtraExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		registerProvider: () => undefined,
		sendUserMessage: () => undefined,
		getAllTools: () => TOOLS.map((name) => ({ name })),
		getActiveTools: () => [...TOOLS],
		setActiveTools: () => undefined,
		getFlag: () => undefined,
	} as unknown as ExtraExtensionAPI;
	createExtraExtension(api);

	const makeCtx = (answers: Array<string | undefined>) =>
		({
			mode: "tui",
			cwd,
			hasUI: options.hasUI ?? false,
			model: undefined,
			modelRegistry: undefined,
			getContextUsage: () => undefined,
			ui: {
				select: async (title: string) => {
					questions.push(title);
					return answers.shift();
				},
				notify: (message: string) => notes.push(message),
				setStatus: () => undefined,
				getEditorText: () => "",
				setTitle: () => undefined,
				theme: { fg: (_color: string, text: string) => text },
			},
		}) as unknown as ExtraExtensionContext;

	return {
		notes,
		questions,
		registered: [...commands.keys()],
		run: async (name, args = "") => {
			await commands.get(name)?.(args, makeCtx([]));
			return notes.at(-1);
		},
		start: async (answers, reason = "startup") => {
			// The confirmation is awaited inside the handler only until its first
			// await, so the answers array must be the one this call owns: two
			// session starts share nothing.
			const queued = [...answers];
			await handlers.get("session_start")?.({ type: "session_start", reason }, makeCtx(queued));
			// The confirmation loop runs off the session-start handler.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

function writeProject(settings: Record<string, unknown>): void {
	mkdirSync(join(projectDir, ".nanopi", "extra"), { recursive: true });
	writeFileSync(projectExtraSettingsPath(projectDir), JSON.stringify(settings));
}

describe("/gitguard and /shellguard", () => {
	test("a bare command reports the value and the file it came from", async () => {
		const h = harness();
		await h.run("gitguard", "off");
		expect(await h.run("gitguard")).toBe("Git guard: off (global)");
	});

	test("a bare command only reports: it never switches", async () => {
		const h = harness();
		await h.run("gitguard", "off");
		expect(await h.run("gitguard")).toBe("Git guard: off (global)");
		expect(globalGuardValue("gitGuard")).toBe(false);
	});

	test("the project scope writes the project file and reports it", async () => {
		const h = harness();
		expect(await h.run("gitguard", "off project")).toBe("Git guard: off (project)");
		expect(projectGuardValue(projectDir, "gitGuard")).toBe(false);
		// Nothing leaked into the global file: the key is absent, not `true`.
		expect(globalGuardValue("gitGuard")).toBeUndefined();
	});

	test("omitting the scope writes the layer already in effect", async () => {
		const h = harness();
		// Nothing saved yet: the default is what is in effect, and it lives in the
		// project layer for a directory that has one, so that is where an explicit
		// choice for it goes.
		await h.run("shellguard", "off global");
		expect(await h.run("shellguard", "on")).toBe("Shell guard: on (global)");
		expect(globalGuardValue("shellGuard")).toBe(true);
	});

	test("the session scope is memory only", async () => {
		const h = harness();
		await h.run("gitguard", "off session");
		expect(await h.run("gitguard")).toBe("Git guard: off (this session; saved value is on)");
		expect(readIfPresent(globalExtraSettingsPath())).toBeUndefined();
		expect(projectGuardValue(projectDir, "gitGuard")).toBeUndefined();
	});

	test("an unknown scope is refused without touching anything", async () => {
		const h = harness();
		expect(await h.run("gitguard", "off everywhere")).toContain("Usage: /gitguard [on|off] [global|project|session]");
		expect(globalGuardValue("gitGuard")).toBeUndefined();
	});
});

describe("a project file that turns the guard off", () => {
	test("asks before the session runs with it", async () => {
		const h = harness({ hasUI: true });
		writeProject({ gitGuard: false });
		await h.start(["Keep it off for this session"]);
		expect(h.questions.length).toBe(1);
		// The project file still says off; the session kept that answer, and the
		// number in the second half is the layer's own value, not the answer.
		expect(await h.run("gitguard")).toBe("Git guard: off (this session; saved value is off)");
	});

	test("repairing removes the key from the project file", async () => {
		const h = harness({ hasUI: true });
		writeProject({ gitGuard: false, defaultMode: "plan" });
		await h.start(["Use the global value and fix the project file"]);
		expect(projectGuardValue(projectDir, "gitGuard")).toBeUndefined();
		// Only that key: a repair is not an invitation to rewrite the file.
		expect(JSON.parse(readFileSync(projectExtraSettingsPath(projectDir), "utf8"))).toEqual({ defaultMode: "plan" });
		// Repaired by this session: the key is gone, and the answer is still the
		// session's until it ends.
		expect(await h.run("gitguard")).toBe("Git guard: on (this session; saved value is on)");
	});

	test("denying keeps the guard on and says the calls are blocked", async () => {
		const h = harness({ hasUI: true });
		writeProject({ shellGuard: false });
		await h.start(["Block shell and git calls until I change it"]);
		expect(h.notes.at(-1)).toContain("shell and git calls are blocked");
		expect(projectGuardValue(projectDir, "shellGuard")).toBe(false);
	});

	test("a session that cannot ask keeps the guard on and logs it", async () => {
		const h = harness();
		writeProject({ gitGuard: false });
		await h.start([]);
		expect(h.questions.length).toBe(0);
		expect(h.notes.at(-1)).toContain("No prompt to answer it, so it stays on.");
		// The project file is untouched: a headless run has no business rewriting it.
		expect(projectGuardValue(projectDir, "gitGuard")).toBe(false);
	});

	test("agreement does not ask, and neither does an explicit global off", async () => {
		const h = harness({ hasUI: true });
		writeProject({ gitGuard: true });
		await h.start([]);
		expect(h.questions).toEqual([]);

		writeProject({ shellGuard: false });
		await h.run("shellguard", "off global");
		await h.start([]);
		expect(h.questions).toEqual([]);
	});

	test("a reload does not ask again", async () => {
		const h = harness({ hasUI: true });
		writeProject({ gitGuard: false });
		await h.start(["Keep it off for this session"]);
		await h.start([], "reload");
		expect(h.questions.length).toBe(1);
		// The reload keeps the answer this session gave instead of re-reading the file.
		// The project file still says off; the session kept that answer, and the
		// number in the second half is the layer's own value, not the answer.
		expect(await h.run("gitguard")).toBe("Git guard: off (this session; saved value is off)");
	});
});

function readIfPresent(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
