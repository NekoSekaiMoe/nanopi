import { describe, expect, it } from "vitest";
import { type BashOperations, createLocalBashOperations, ShellTimeoutError } from "../src/core/tools/bash.ts";
import { executeFailureText } from "./helpers/timeout-text.ts";

/**
 * A shell that exits 3 at once and leaves a disowned background loop behind. The loop survives the
 * deadline's group kill and keeps writing to the output pipe the shell inherited.
 *
 * The deadline therefore fires while `waitForChildProcess` is still reading: `exit` already arrived
 * with code 3, but `close` never does, so it only releases on its 100 ms idle grace. That is the
 * path a plain `sleep 30` never reaches, because there the deadline kills a live shell.
 *
 * Both waits sit far from the intervals they could race with: the deadline (200 ms) versus the
 * pipeline teardown, and the loop's interval (10 ms) versus the grace (100 ms), which keeps the
 * grace timer re-armed.
 */
const EXITED_SHELL = "( while :; do printf x; sleep 0.01; done ) & disown; exit 3";

/** The error a local-backend command fails with, without going through the tool's formatting. */
async function localFailure(command: string, timeout: number): Promise<unknown> {
	try {
		await createLocalBashOperations().exec(command, process.cwd(), { onData: () => {}, timeout });
	} catch (error) {
		return error;
	}
	throw new Error("expected the command to time out");
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
		expect(await executeFailureText("anything", 1, operations)).toContain(
			"Command timed out after 1 seconds and exited with code 3",
		);
	});

	it("keeps the plain wording for a backend that reports no exit code", async () => {
		const operations: BashOperations = {
			exec: async () => {
				throw new ShellTimeoutError(2, null);
			},
		};
		const text = await executeFailureText("anything", 2, operations);
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
		const text = await executeFailureText("anything", 5, operations);
		expect(text).toContain("Command timed out after 5 seconds");
		expect(text).not.toContain("exited with code");
	});

	it.skipIf(process.platform === "win32")("reports the exit code of a shell that had already exited", async () => {
		const captured = await localFailure(EXITED_SHELL, 0.2);
		expect(captured).toBeInstanceOf(ShellTimeoutError);
		expect((captured as ShellTimeoutError).exitCode).toBe(3);
		expect((captured as ShellTimeoutError).message).toBe("timeout:0.2");
	});

	it.skipIf(process.platform === "win32")("tells the model the command failed and also timed out", async () => {
		const text = await executeFailureText(EXITED_SHELL, 0.2);
		expect(text).toContain("Command timed out after 0.2 seconds and exited with code 3");
	});

	it.skipIf(process.platform === "win32")(
		"reports the signal convention for a shell the deadline killed",
		async () => {
			const captured = await localFailure("sleep 30", 1);
			expect(captured).toBeInstanceOf(ShellTimeoutError);
			// SIGKILL, i.e. 128 + 9: the tree kill does not give the shell a chance to handle SIGTERM.
			expect((captured as ShellTimeoutError).exitCode).toBe(137);
			expect((captured as ShellTimeoutError).message).toBe("timeout:1");
		},
	);
});
