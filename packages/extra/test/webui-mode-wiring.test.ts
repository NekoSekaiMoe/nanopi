import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ExtraBridge } from "../src/bridge.ts";
import { createExtraExtension } from "../src/extension.ts";
import type { ExtraExtensionAPI, ExtraExtensionContext } from "../src/extension-api.ts";
import { modeEngine } from "../src/mode-engine.ts";

// The webui switches the process-wide mode engine, so the session's tool set has
// to follow the engine for every frontend, and a session start must not reset a
// mode the user picked on the settings page. Both defects lived in the extension
// wiring, so the tests drive the real factory with a fake extension API.

const TOOLS = ["read", "write", "edit", "bash", "grep"];

let home = "";
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
	home = mkdtempSync(join(tmpdir(), "nanopi-extra-mode-"));
	process.env.NANOPI_CODING_AGENT_DIR = home;
	resetEngine();
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
	resetEngine();
});

/** The engine is a process singleton: leave no mode or minimal snapshot behind. */
function resetEngine(): void {
	modeEngine.setMode("standard");
	modeEngine.setPreMinimalTools(undefined);
}

function fakeApi(): {
	api: ExtraExtensionAPI;
	active: () => string[];
	start: (mode: string, reason?: "startup" | "new") => void;
} {
	let active = [...TOOLS];
	const handlers = new Map<string, (event: unknown, ctx: ExtraExtensionContext) => unknown>();
	const api = {
		registerFlag: () => undefined,
		registerCommand: () => undefined,
		on: (event: string, handler: (payload: unknown, ctx: ExtraExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		registerProvider: () => undefined,
		sendUserMessage: () => undefined,
		getAllTools: () => TOOLS.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getFlag: () => undefined,
	} as unknown as ExtraExtensionAPI;
	return {
		api,
		active: () => active,
		start: (mode, reason = "startup") => {
			const ctx = {
				mode,
				hasUI: false,
				cwd: home,
				model: undefined,
				modelRegistry: undefined,
				ui: { select: async () => undefined, notify: () => undefined, setStatus: () => undefined },
				getContextUsage: () => undefined,
			} as unknown as ExtraExtensionContext;
			void handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
		},
	};
}

describe("webui mode switching", () => {
	test("a mode switched from the webui narrows the active tools", () => {
		const fake = fakeApi();
		createExtraExtension(fake.api);
		fake.start("webui");
		expect(fake.active()).toEqual(TOOLS);

		// The engine notify is what carries the tool set to every frontend: before
		// the fix only the TUI badge listened, so the webui changed the mode while
		// the session kept every tool.
		modeEngine.setMode("minimal", "webui");
		expect(fake.active()).toEqual(["bash"]);

		// Leaving minimal restores the tool set captured on entry.
		modeEngine.setMode("standard", "webui");
		fake.api.setActiveTools(TOOLS);
	});

	test("the bridge switch applies the tool set and rejects unknown modes", () => {
		const fake = fakeApi();
		createExtraExtension(fake.api);
		fake.start("webui");
		let applied = 0;
		const bridge = new ExtraBridge();
		bridge.bindSession(
			{
				subsystemStatus: () => [],
				applySubsystem: () => undefined,
				applyModeToolSet: () => {
					applied++;
					// The extension's own listener is what really re-derives the tools.
					const active = fake.active();
					fake.api.setActiveTools(modeEngine.mode === "minimal" ? active.filter((n) => n === "bash") : TOOLS);
				},
			},
			home,
			{ model: undefined, registry: undefined, cwd: home },
		);

		expect(bridge.setMode("minimal")).toEqual({ ok: true, mode: "minimal" });
		expect(modeEngine.mode).toBe("minimal");
		expect(fake.active()).toEqual(["bash"]);
		// Once for the notify, once for the bridge's own explicit call.
		expect(applied).toBe(1);

		expect(bridge.setMode("bogus")).toMatchObject({ ok: false });
		expect(modeEngine.mode).toBe("minimal");
		expect(applied).toBe(1);
	});

	test("a webui session start keeps the mode the user picked", () => {
		const fake = fakeApi();
		createExtraExtension(fake.api);
		fake.start("webui");
		modeEngine.setMode("plan", "webui");
		// Creating a session used to replay `defaultMode` over the live choice,
		// which is what the SPA does on the first send of a tab.
		fake.start("webui", "new");
		expect(modeEngine.mode).toBe("plan");
	});

	test("a tui session start still applies the configured default mode", () => {
		const fake = fakeApi();
		createExtraExtension(fake.api);
		fake.start("webui");
		modeEngine.setMode("plan", "webui");
		fake.start("tui", "new");
		expect(modeEngine.mode).toBe("standard");
	});
});
