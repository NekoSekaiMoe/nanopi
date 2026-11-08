import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ChatActiveEntry, type UserInputRequestEvent, activeTurns, pendingUserInput } from "@/lib/api";

// Issue #609: `/chat/active` answers with the running turns plus, at most, one
// `user_input` entry for a question nobody is streaming. The daemon started
// listing it after a background `ask_user_question` had no reader; these are the
// two readers the tab needs, kept in one place so the shapes cannot drift apart.

const turn = { session_id: "s1", turn_id: "t1", started_at: 1 };
const request: UserInputRequestEvent = {
	type: "user_input_request",
	request_id: 7,
	header: "Job",
	question: "Did the run finish?",
	mode: "single",
	options: [{ label: "yes" }, { label: "no" }],
};

describe("chat active entries", () => {
	it("reports only the turns, so a question is not mistaken for one", () => {
		const entries: ChatActiveEntry[] = [turn, { user_input: request }, { ...turn, turn_id: "t2" }];
		expect(activeTurns(entries).map((entry) => entry.turn_id)).toEqual(["t1", "t2"]);
	});

	it("finds the open question, and nothing when the daemon lists none", () => {
		expect(pendingUserInput([turn, { user_input: request }])).toEqual(request);
		expect(pendingUserInput([turn])).toBeUndefined();
		expect(pendingUserInput([])).toBeUndefined();
	});

	it("is what the composer effect reads, so a reload mid-question still draws the card", () => {
		// The card is fed by `user_input_request` on the turn's own SSE, which a tab
		// that reloaded never saw. The background poll is the only other source.
		const source = readFileSync(join(import.meta.dirname, "..", "src", "lib", "use-chat.ts"), "utf8");
		expect(source).toContain("pendingUserInput(entries)");
		expect(source).toContain("setUserInput(");
	});
});
