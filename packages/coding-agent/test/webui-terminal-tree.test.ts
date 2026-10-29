import { execFileSync } from "node:child_process";
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

/** Pids still running a command line containing `marker`, whatever their parent is. */
function survivorsOf(marker: string): number[] {
	const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
	return out
		.split("\n")
		.filter((line) => line.includes(marker) && !line.includes("ps -eo"))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
}

// nanopi#376: cancel() only SIGKILLed `sh -c`, so the grandchildren survived.
describe.skipIf(process.platform === "win32")("webui scratch terminal cancel", () => {
	test("cancel reaps the grandchild, not just the sh -c parent", async () => {
		// The marker is unique per run so a parallel test's process is not counted.
		const marker = `nanopi-terminal-${process.pid}-${Date.now()}`;
		const session = startTerminal(process.cwd());
		const running = session.exec(`sleep 300 # ${marker}`);
		expect(await waitFor(() => survivorsOf(marker).length > 0, 2000)).toBe(true);
		session.cancel();
		await running;
		expect(await waitFor(() => survivorsOf(marker).length === 0, 2000)).toBe(true);
	});
});
