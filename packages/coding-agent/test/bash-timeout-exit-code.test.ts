import { describe, expect, it } from "vitest";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	ShellTimeoutError,
} from "../src/core/tools/bash.ts";

/**
 * The reported text of a timed-out command. A timeout is a failure, so the tool throws the
 * formatted text; the exit-code assertions read the message it carries.
 */
async function timeoutText(command: string, timeout: number, operations?: BashOperations): Promise<string> {
	const definition = createBashToolDefinition(process.cwd(), operations ? { operations } : undefined);
	try {
		await definition.execute("call", { command, timeout }, undefined, undefined, {
			cwd: process.cwd(),
			model: undefined,
			sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		} as never);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the call to time out");
}

describe("bash timeout reporting", () => {
	// Upstream #6820: a command that failed and then outlived the deadline was reported only as
	// slow, so the model retried with a larger timeout instead of looking at the failure.
	it("reports the exit code of a shell that exited before the deadline fired", async () => {
		const operations: BashOperations = {
			exec: async () => {
				throw new ShellTimeoutError(1, 3);
			},
		};
		expect(await timeoutText("anything", 1, operations)).toContain(
			"Command timed out after 1 seconds and exited with code 3",
		);
	});

	it("keeps the plain wording for a backend that reports no exit code", async () => {
		const operations: BashOperations = {
			exec: async () => {
				throw new ShellTimeoutError(2, null);
			},
		};
		const text = await timeoutText("anything", 2, operations);
		expect(text).toContain("Command timed out after 2 seconds");
		expect(text).not.toContain("exited with code");
	});

	it("still accepts a backend that throws the bare timeout message", async () => {
		// Extensions implement `exec` themselves; `timeout:N` is the contract they already meet.
		const operations: BashOperations = {
			exec: async () => {
				throw new Error("timeout:5");
			},
		};
		const text = await timeoutText("anything", 5, operations);
		expect(text).toContain("Command timed out after 5 seconds");
		expect(text).not.toContain("exited with code");
	});

	it("reports the signal convention for a shell the deadline killed", async () => {
		const operations = createLocalBashOperations();
		let captured: unknown;
		try {
			await operations.exec("sleep 30", process.cwd(), { onData: () => {}, timeout: 1 });
		} catch (error) {
			captured = error;
		}
		expect(captured).toBeInstanceOf(ShellTimeoutError);
		// SIGKILL, i.e. 128 + 9: the tree kill does not give the shell a chance to handle SIGTERM.
		expect((captured as ShellTimeoutError).exitCode).toBe(137);
		expect((captured as ShellTimeoutError).message).toBe("timeout:1");
	});
});
