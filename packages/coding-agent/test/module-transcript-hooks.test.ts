import { tmpdir } from "node:os";
import { Text } from "@nanopi/pi-tui";
import { describe, expect, it } from "vitest";
import { loadModules } from "../src/core/modules/registry.ts";
import type { SessionModule, ToolRowRenderContext } from "../src/core/modules/types.ts";

/**
 * The transcript hooks exist so a module can restyle rows it does not own.
 * pi-ui was the first consumer: it patched component prototypes for five rows
 * because no contract covered them. These tests hold the contracts themselves:
 * a resolver can replace a row without touching the tool, hide it, and the
 * settings list can retire a core row.
 */

async function load(module: SessionModule) {
	const result = await loadModules([module], tmpdir());
	const registry = result.runtime;
	void registry;
	return result;
}

describe("tool row renderers", () => {
	it("wraps the tool's own row and lets a resolver hide it", async () => {
		const seen: string[] = [];
		const module: SessionModule = {
			name: "row-test",
			factory: (nanopi) => {
				nanopi.registerToolRowRenderer((toolName, next) => {
					seen.push(toolName);
					const base = next();
					return {
						renderShell: "self",
						renderCall: (_args, _theme, context) => {
							context.hide();
							return new Text(`${toolName}-row`, 0, 0);
						},
						renderResult: base?.renderResult,
					};
				});
			},
		};
		const result = await load(module);
		const registered = result.modules[0]!;
		expect(registered.toolRowRenderers).toHaveLength(1);

		const baseResult = () => new Text("base-result", 0, 0);
		const baseRow = { renderCall: () => new Text("base", 0, 0), renderResult: baseResult };
		const resolved = registered.toolRowRenderers![0]!("bash", () => baseRow);
		expect(seen).toEqual(["bash"]);
		expect(resolved?.renderShell).toBe("self");
		// The result renderer is delegated, not replaced: the tool keeps its own row body.
		expect(resolved?.renderResult).toBe(baseResult);
	});

	it("passes the row identity and a hide handle to the renderer", async () => {
		let hidden = false;
		let toolName: string | undefined;
		const module: SessionModule = {
			name: "hide-test",
			factory: (nanopi) => {
				nanopi.registerToolRowRenderer(() => ({
					renderCall: (_args, _theme, context: ToolRowRenderContext) => {
						toolName = context.toolName;
						context.hide();
						hidden = true;
						return new Text("row", 0, 0);
					},
				}));
			},
		};
		const result = await load(module);
		const row = result.modules[0]!.toolRowRenderers![0]!("grep", () => undefined);
		// Hiding happens while the row renders, so the call must not throw before it.
		expect(hidden).toBe(false);
		row?.renderCall?.(
			{},
			{} as never,
			{
				toolName: "grep",
				hide: () => {
					hidden = true;
				},
			} as never,
		);
		expect(toolName).toBe("grep");
		expect(hidden).toBe(true);
	});
});

describe("shell rows", () => {
	it("layers resolvers so the last one owns the row", async () => {
		const module: SessionModule = {
			name: "shell-test",
			factory: (nanopi) => {
				nanopi.registerShellRenderer((_state, next) => next());
			},
		};
		const result = await load(module);
		const registered = result.modules[0]!;
		expect(registered.shellRenderers).toHaveLength(1);
		const fallback = new Text("default", 0, 0);
		const row = registered.shellRenderers![0]!(
			{ command: "ls", output: "", exitCode: undefined, status: "running", expanded: false },
			() => fallback,
			{} as never,
		);
		// Delegating returns the default row untouched.
		expect(row).toBe(fallback);
	});
});

describe("assistant message renderers", () => {
	it("keeps registration order and reports only what it claims", async () => {
		let calls = 0;
		const module: SessionModule = {
			name: "assistant-test",
			factory: (nanopi) => {
				nanopi.registerAssistantMessageRenderer(() => {
					calls++;
					return false;
				});
				nanopi.registerAssistantMessageRenderer(() => {
					calls++;
					return true;
				});
			},
		};
		const result = await load(module);
		const renderers = result.modules[0]!.assistantMessageRenderers!;
		expect(renderers).toHaveLength(2);
		const context = { isStreaming: false } as never;
		expect(renderers[0]!({} as never, context)).toBe(false);
		expect(renderers[1]!({} as never, context)).toBe(true);
		expect(calls).toBe(2);
	});
});

describe("settings rows", () => {
	it("lets a module contribute a row and retire a core one", async () => {
		let applied: string | undefined;
		const module: SessionModule = {
			name: "settings-test",
			factory: (nanopi) => {
				nanopi.registerSettingsItem({
					id: "pi-ui-row",
					label: "Pi UI row",
					currentValue: "on",
					values: ["on", "off"],
					onChange: (value) => {
						applied = value;
					},
				});
				nanopi.unregisterSettingsItem("hide-thinking");
			},
		};
		const result = await load(module);
		const registered = result.modules[0]!;
		expect([...registered.settingsItems!.keys()]).toEqual(["pi-ui-row"]);
		expect([...(registered.removedSettingsItems ?? [])]).toEqual(["hide-thinking"]);
		registered.settingsItems!.get("pi-ui-row")!.onChange("off");
		expect(applied).toBe("off");
	});
});

describe("working indicator", () => {
	it("replaces the row renderer instead of accumulating them", async () => {
		const module: SessionModule = {
			name: "working-test",
			factory: (nanopi) => {
				nanopi.registerWorkingIndicator(() => undefined);
				nanopi.registerWorkingIndicator((state) => ({ text: state.message }));
			},
		};
		const result = await load(module);
		const renderer = result.modules[0]!.workingIndicatorRenderer!;
		// The second registration replaced the first; the first one is not called.
		expect(renderer({ message: "Working", placement: "statusRow" } as never, {} as never)).toEqual({
			text: "Working",
		});
	});
});
