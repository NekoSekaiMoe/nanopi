import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
			expect(text).toContain("- Existing rule (kept ");
			expect(text).toContain("\n- Rebuild the webui before testing it (kept ");
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

describe("/forget and /remember --list", () => {
	test("--list prints every entry with its age", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			writeFileSync(join(harness.tempDir, "AGENTS.md"), "## Build\n\n- Existing rule (kept 2020-01-01)\n");
			const notes = captureNotifies(harness);
			await invoke(harness, "/remember --list");
			expect(notes.join("\n")).toContain("Build: Existing rule");
			expect(notes.join("\n")).toContain("1.");
		} finally {
			harness.cleanup();
		}
	});

	test("/forget deletes the numbered entry and leaves the rest", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			const file = join(harness.tempDir, "AGENTS.md");
			writeFileSync(file, "## Build\n\n- Keep this rule\n- Drop this rule\n");
			await invoke(harness, "/forget 2");
			const text = readFileSync(file, "utf-8");
			expect(text).toContain("- Keep this rule");
			expect(text).not.toContain("Drop this rule");
		} finally {
			harness.cleanup();
		}
	});

	test("/forget without a number says how to use it", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			const file = join(harness.tempDir, "AGENTS.md");
			writeFileSync(file, AGENTS);
			const notes = captureNotifies(harness);
			await invoke(harness, "/forget");
			expect(notes.join("\n")).toContain("Usage");
			expect(readFileSync(file, "utf-8")).toBe(AGENTS);
		} finally {
			harness.cleanup();
		}
	});
});

describe("/remember --prune", () => {
	test("offers the entry that names a path which no longer exists", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			const file = join(harness.tempDir, "AGENTS.md");
			writeFileSync(file, "## Build\n\n- The loader lives in `src/gone.ts`\n- Keep this rule\n");
			const asked: string[] = [];
			spyOnInput(harness, asked, "1");
			await invoke(harness, "/remember --prune");
			expect(asked.join("\n")).toContain("src/gone.ts");
			const text = readFileSync(file, "utf-8");
			expect(text).toContain("- Keep this rule");
			expect(text).not.toContain("src/gone.ts");
		} finally {
			harness.cleanup();
		}
	});

	test("keeps everything when the user confirms nothing", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			const file = join(harness.tempDir, "AGENTS.md");
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			writeFileSync(file, "## Build\n\n- The loader lives in `src/gone.ts`\n");
			spyOnInput(harness, [], "");
			await invoke(harness, "/remember --prune");
			expect(readFileSync(file, "utf-8")).toContain("src/gone.ts");
		} finally {
			harness.cleanup();
		}
	});

	test("says so when nothing looks out of date", async () => {
		const harness = await createHarness({ modules: [{ name: "pi-memory", factory: memory }] });
		try {
			writeFileSync(join(harness.tempDir, "AGENTS.md"), "## Build\n\n- A rule that still holds\n");
			const notes = captureNotifies(harness);
			await invoke(harness, "/remember --prune");
			expect(notes.join("\n")).toContain("Nothing looks out of date");
		} finally {
			harness.cleanup();
		}
	});
});

/** Dispatch a slash command the way the interactive loop does. */
async function invoke(harness: Harness, command: string): Promise<void> {
	await harness.session.prompt(command);
}

/** Everything the module notified the user, in order. */
function captureNotifies(harness: Harness): string[] {
	const notes: string[] = [];
	const registry = harness.session.moduleRegistry;
	registry.setUIContext({ ...registry.getUIContext(), notify: (message: string) => notes.push(message) });
	return notes;
}

/** Answer the next `ui.input` with `answer`, recording the question. */
function spyOnInput(harness: Harness, asked: string[], answer: string): void {
	const registry = harness.session.moduleRegistry;
	registry.setUIContext({
		...registry.getUIContext(),
		input: async (title: string) => {
			asked.push(title);
			return answer;
		},
	});
}
