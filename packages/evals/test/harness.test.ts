import { homedir } from "node:os";
import { getDocsPath, getExamplesPath, getReadmePath } from "@nanopi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import {
	applyIsolatedEnvironment,
	createNanoPiDocumentationEvalHarness,
	DOCUMENTATION_EVAL_TOOLS,
	excludeNanoPiDocumentation,
	resolveDocumentationVariant,
	resolveModelSelection,
	verifySystemPrompt,
} from "../src/harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ NANOPI_PROVIDER: "openai-codex", NANOPI_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults", () => {
		expect(
			resolveModelSelection(undefined, { NANOPI_PROVIDER: " openai-codex ", NANOPI_MODEL: " gpt-5.6-sol " }),
		).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([{}, { NANOPI_PROVIDER: "openai-codex" }, { NANOPI_MODEL: "gpt-5.6-sol" }])(
		"rejects incomplete model selection",
		(environment) => {
			expect(() => resolveModelSelection(undefined, environment)).toThrow("Select a harness model explicitly");
		},
	);
});

describe("isolateProcessEnvironment", () => {
	it("removes runner metadata and restores the process environment", () => {
		vi.stubEnv("NANOPI_EVAL_VARIANT", "with_docs");
		vi.stubEnv("NANOPI_EVAL_ARTIFACT_DIR", "/tmp/artifacts");
		const oldHome = process.env.HOME;
		try {
			const restore = applyIsolatedEnvironment("/tmp/eval-home", "/tmp/eval-agent");
			try {
				expect(homedir()).toBe("/tmp/eval-home");
				expect(process.env.NANOPI_CODING_AGENT_DIR).toBe("/tmp/eval-agent");
				expect(process.env.NANOPI_EVAL_VARIANT).toBeUndefined();
				expect(process.env.NANOPI_EVAL_ARTIFACT_DIR).toBeUndefined();
			} finally {
				restore();
			}
			expect(process.env.HOME).toBe(oldHome);
			expect(process.env.NANOPI_EVAL_VARIANT).toBe("with_docs");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("documentation variant", () => {
	it.each(["without_docs", "with_docs"] as const)("accepts %s", (variant) => {
		expect(resolveDocumentationVariant(variant)).toBe(variant);
	});

	it.each([undefined, "", "other"])("rejects invalid variant %s", (variant) => {
		expect(() => resolveDocumentationVariant(variant)).toThrow("NANOPI_EVAL_VARIANT");
	});

	it("strips only the documentation routing section from the default nanopi prompt", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		expect(prompt).toContain("\n<docs>\nnanopi documentation (read only");
		expect(prompt).toContain("\n<rules>\n");
		expect(prompt).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(prompt).toContain("docs/models.md");

		const stripped = excludeNanoPiDocumentation(prompt);
		expect(stripped).toContain("\n<rules>\n");
		expect(stripped).toContain("\n<cwd>\n/workspace\n</cwd>");
		expect(stripped).not.toContain("<docs>");
		expect(stripped).not.toContain("nanopi documentation");
		expect(stripped).not.toContain("docs/models.md");
		expect(stripped).not.toContain(getReadmePath());
		expect(stripped).not.toContain(getDocsPath());
		expect(stripped).not.toContain(getExamplesPath());
	});

	it("verifies the prompt that was sent", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		const stripped = excludeNanoPiDocumentation(prompt);

		expect(verifySystemPrompt(stripped, { name: "without_docs", expectedNanoPiDocumentation: false })).toBe(stripped);
		expect(() => verifySystemPrompt(prompt, { name: "without_docs", expectedNanoPiDocumentation: false })).toThrow(
			"does not match",
		);
	});

	it("fails closed when prompt markers are missing", () => {
		expect(() => excludeNanoPiDocumentation("Instructions")).toThrow("no nanopi documentation section");
		expect(() => excludeNanoPiDocumentation("\n<docs>\nnanopi documentation\n</docs>")).toThrow(
			"no working-directory section",
		);
	});

	it("rejects documentation harnesses outside the container sandbox", () => {
		expect(() => createNanoPiDocumentationEvalHarness()).toThrow("isolated container sandbox");
	});
});
