import type { KeyId } from "@nanopi/pi-tui";
import { describe, expect, test } from "vitest";
import { createModuleRuntime, ModuleRegistry } from "../src/core/modules/registry.ts";
import type { RegisteredModule } from "../src/core/modules/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function registryWithShortcut(shortcut: KeyId): ModuleRegistry {
	const registered: RegisteredModule = {
		name: "temp",
		sourceInfo: createSyntheticSourceInfo("temp", { source: "local" }),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map([[shortcut, { shortcut, moduleName: "temp", handler: () => {} }]]),
		handlers: new Map(),
		messageRenderers: new Map(),
	};
	return new ModuleRegistry([registered], createModuleRuntime(), process.cwd(), {} as never, {} as never);
}

/** #464: pi-ui claims ctrl+t for its own thinking rows. */
describe("module shortcut reservations", () => {
	test("a module may take app.thinking.toggle's key", () => {
		const registry = registryWithShortcut("ctrl+t");
		const shortcuts = registry.getShortcuts({ "app.thinking.toggle": "ctrl+t" });

		// The editor asks module shortcuts before app actions, so the module owns
		// the press; warning about it would tell the user nothing actionable.
		expect(shortcuts.get("ctrl+t" as KeyId)?.moduleName).toBe("temp");
		expect(registry.getShortcutDiagnostics()).toEqual([]);
	});

	test("every other editor action still keeps its key", () => {
		const registry = registryWithShortcut("ctrl+o");
		const shortcuts = registry.getShortcuts({ "app.tools.expand": "ctrl+o" });

		expect(shortcuts.size).toBe(0);
		expect(registry.getShortcutDiagnostics()[0]?.message).toContain("conflicts with built-in shortcut");
	});
});
