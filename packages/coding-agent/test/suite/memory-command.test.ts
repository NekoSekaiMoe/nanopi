import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@nanopi/pi-ai";
import { describe, expect, test } from "vitest";
import memory from "../../src/extras/pi-memory/src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const AGENTS = "# Repo\n\nIntro.\n\n## Build\n\n- Existing rule\n";

/**
 * `/remember` end to end. The tool-free path is what makes this testable: the
 * command reads the session, writes only what the confirmation kept, and never
 * touches a line it does not own.
 */
describe("/remember", () => {
	test("an explicit entry lands in the section the model named", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			writeFileSync(join(harness.tempDir, "AGENTS.md"), AGENTS);
			await invoke(harness, "/remember Rebuild the webui before testing it");
			const text = readFileSync(join(harness.tempDir, "AGENTS.md"), "utf-8");
			expect(text).toContain("- Existing rule\n- Rebuild the webui before testing it\n");
			expect(text.startsWith("# Repo\n\nIntro.\n\n## Build\n")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("an entry that the file already states is refused", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			const file = join(harness.tempDir, "AGENTS.md");
			writeFileSync(file, AGENTS);
			await invoke(harness, "/remember existing rule");
			expect(readFileSync(file, "utf-8")).toBe(AGENTS);
		} finally {
			harness.cleanup();
		}
	});

	test("a narrative entry is refused instead of written", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			const file = join(harness.tempDir, "AGENTS.md");
			writeFileSync(file, AGENTS);
			await invoke(harness, "/remember The user asked me to fix the retry logic");
			expect(readFileSync(file, "utf-8")).toBe(AGENTS);
		} finally {
			harness.cleanup();
		}
	});

	test("extraction finds nothing in a one-turn session", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			harness.setResponses([fauxAssistantMessage("answer")]);
			await harness.session.prompt("a single question");
			// A short session has no provider call to make, so the next canned
			// response must still be queued after /remember.
			harness.appendResponses([fauxAssistantMessage("unused")]);
			await invoke(harness, "/remember");
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});
});

/** Dispatch a slash command the way the interactive loop does. */
async function invoke(harness: Harness, command: string): Promise<void> {
	await harness.session.prompt(command);
}
