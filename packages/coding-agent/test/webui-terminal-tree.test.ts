import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { startTerminal } from "../src/modes/webui/webui-server.ts";

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tick = () => {
			if (predicate()) return resolve(true);
			if (Date.now() > deadline) return resolve(false);
			setTimeout(tick, 25);
		};
		tick();
	});
}

/** True when the pid exists and is still running (a zombie only counts as exited after reaping). */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// nanopi#376: cancel() only SIGKILLed `sh -c`, so the grandchildren survived.
//
// Scanning `ps` output for a marker in the command line is the obvious check and
// it is what fails on CI: shells differ (`/bin/sh` collapses the whole `-c`
// string into the exec'd process's argv, bash keeps a separate process), and
// `bash -c` may `exec` the last command, dropping the comment. Either way the
// scan can see nothing even though the tree is running. The command writes its
// own pids to a file instead, so the test observes the real process tree.
describe.skipIf(process.platform === "win32")("webui scratch terminal cancel", () => {
	test("cancel reaps the grandchild, not just the sh -c parent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-terminal-tree-"));
		const pidFile = join(dir, "pids");
		const session = startTerminal(process.cwd());
		const running = session.exec(`sleep 300 & echo "$! $$" > ${pidFile}; wait`);
		try {
			expect(await waitFor(() => readPidFile(pidFile).length === 2, 5000)).toBe(true);
			const [sleepPid, shellPid] = readPidFile(pidFile);
			expect(isAlive(sleepPid)).toBe(true);
			expect(isAlive(shellPid)).toBe(true);

			session.cancel();
			await running;

			expect(await waitFor(() => !isAlive(sleepPid) && !isAlive(shellPid), 5000)).toBe(true);
		} finally {
			session.cancel();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Pids written by the command, in file order; empty until the shell gets that far. */
function readPidFile(path: string): number[] {
	try {
		const text = readFileSync(path, "utf8");
		return text
			.split(/\s+/)
			.filter(Boolean)
			.map(Number)
			.filter((pid) => Number.isInteger(pid) && pid > 0);
	} catch {
		return [];
	}
}
