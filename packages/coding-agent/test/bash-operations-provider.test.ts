/**
 * The bash tool must route execution through the backend a module selected,
 * while keeping its own description, truncation, and result shape.
 * Regression test for the missing wiring described in the "sandbox as an
 * extra package" work: `createBashToolDefinition({ operations })` was exported
 * but unreachable from a module.
 */

import { describe, expect, it } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createBashToolDefinition, resolveShellOperations } from "../src/core/tools/bash.ts";

describe("bash operations providers", () => {
	it("falls back to the local shell when no backend is selected", () => {
		const local = createBashToolDefinition(process.cwd());
		const resolved = resolveShellOperations(undefined);
		expect(typeof resolved.exec).toBe("function");
		expect(local.name).toBe("bash");
	});

	it("use the selected provider instead of the local shell", async () => {
		const calls: string[] = [];
		const backend: BashOperations = {
			exec: async (command) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		let selected: string | undefined = "sandbox";
		const definition = createBashToolDefinition(process.cwd(), {
			operationsProviders: () => ({ sandbox: backend }),
			operationsProvider: () => selected,
		});

		const result = await definition.execute(
			"test-call",
			{ command: "echo hi" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(calls).toEqual(["echo hi"]);
		expect(result.structuredContent).toMatchObject({ exit_code: 0, executed_on: "sandbox" });

		selected = undefined;
		const local = await definition.execute(
			"test-call",
			{ command: "echo hi" },
			undefined,
			undefined,
			undefined as never,
		);
		// Not routed to the backend, so the real shell ran it and reported output.
		expect(calls).toEqual(["echo hi"]);
		expect(local.isError).toBeUndefined();
	});

	it("keeps the fixed operations override when a provider is not selected", () => {
		const fixed: BashOperations = { exec: async () => ({ exitCode: 0 }) };
		const resolved = resolveShellOperations({
			operations: fixed,
			operationsProviders: () => ({}),
			operationsProvider: () => "sandbox",
		});
		expect(resolved).toBe(fixed);
	});
});
