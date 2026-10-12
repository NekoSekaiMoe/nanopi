/**
 * Inert stub for @nanopi/pi-extra, used by the bundle and single-file build
 * scripts when the buildconfig.json component "modes" is disabled. The stub
 * keeps every import site working while registering no flags, commands,
 * hooks, or bridge endpoints: the CLI shows no --yolo, /plan, or badges, and
 * the webui bridge reports unavailable so its selector stays hidden.
 *
 * Keep the export set in sync with packages/extra/src/index.ts value exports
 * consumed by the coding-agent (extraInlineExtension, extraBridge).
 */

const inertEngine = {
	get mode() {
		return "standard";
	},
	get yolo() {
		return false;
	},
	setMode() {},
	setYolo() {},
	subscribe() {
		return () => {};
	},
	snapshot() {
		return { mode: "standard", yolo: false, reason: undefined };
	},
};

export const extraInlineExtension = {
	name: "extra",
	hidden: true,
	factory: () => {},
};

export const extraBridge = {
	available: false,
	engine: inertEngine,
	permissions: {
		subscribe() {
			return () => {};
		},
		answer() {
			return false;
		},
		cancelAll() {},
		prompter: async () => undefined,
	},
	pairing: {
		generate() {
			throw new Error("pairing is not included in this build");
		},
		verify() {
			throw new Error("pairing is not included in this build");
		},
		status() {
			return { active: false };
		},
	},
	bindSession() {},
	bindCore() {},
	state() {
		return { available: false, mode: "standard", yolo: false };
	},
	setMode() {
		return { ok: false, error: "run modes are not included in this build" };
	},
	setDefaultMode() {
		return { ok: false, error: "run modes are not included in this build" };
	},
	answerPermission() {
		return false;
	},
	settings() {
		return { settings: { defaultMode: "standard", subsystems: {} }, sources: [] };
	},
	updateSettings() {
		return { defaultMode: "standard", subsystems: {} };
	},
	subsystemStatus() {
		return [];
	},
	setSubsystem() {
		return [];
	},
	judge() {
		return Promise.resolve({ action: "deny", reason: "not included in this build" });
	},
};
