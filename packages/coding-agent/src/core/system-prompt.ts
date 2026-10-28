/**
 * System prompt construction and project context loading
 */

import { getSystemMessageText } from "@nanopi/pi-ai";
import { isBashOnlyBuild, isBuildComponentEnabled } from "../build-components.ts";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write]. */
	selectedTools?: string[];
	/**
	 * Selected tools whose declarations requests leave out (`prepareLoadout` hidden declarations).
	 * They are reachable only through another tool, so the tool list and rules leave them out too.
	 */
	hiddenTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections?: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
export type SystemPromptSections = Record<string, string>;

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
		hiddenTools: [...(input.hiddenTools ?? [])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const hasShell = selectedTools.includes("bash") || selectedTools.includes("powershell");
	const hasRead = selectedTools.includes("read");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");

	if (hasShell && !hasRead && !hasGrep && !hasFind && !hasLs) {
		if (selectedTools.includes("bash") && selectedTools.includes("powershell")) {
			addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (selectedTools.includes("powershell")) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	} else if (hasRead || hasGrep || hasFind || hasLs) {
		// The dedicated tools exist, so name them: without this the model keeps
		// reaching for the shell command it knows best (`cat -n`, `sed -n`, `grep -r`)
		// and loses gitignore handling, truncation notices, and stable line numbers.
		const preferred: string[] = [];
		if (hasRead) preferred.push("read for file contents");
		if (hasGrep) preferred.push("grep for searching file contents");
		if (hasFind) preferred.push("find for locating files by name");
		if (hasLs) preferred.push("ls for listing directories");
		// `rg`, `fd`, `cat`, `sed`, and `grep` keep their non-read uses (package
		// scripts, pipes, process output), so this is a preference, not a ban.
		if (preferred.length > 0) {
			addRule(
				`Prefer ${preferred.join(", ")} over shell equivalents (cat, head, tail, sed -n, grep, rg, find, fd); the shell runs programs, not file inspection`,
			);
		}
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule("Be concise; show file paths clearly");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		hiddenTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		contextFiles,
		skills,
	} = options;

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const declaredTools = selectedTools.filter((name) => !hiddenTools.includes(name));
	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else if (isBashOnlyBuild()) {
		// A shell-only build declares one tool per platform, and the declaration
		// already carries the description and schema. Listing it again, restating
		// the truncation behavior, and pointing at docs and examples the build does
		// not ship would cost more prompt than the tool itself.
		promptSections.preamble =
			"You are an expert coding assistant operating inside nanopi, a coding agent harness. You work through the shell tool.";
		promptSections.rules = buildRules(declaredTools, toolGuidelines, promptGuidelines);
		// The sections filled below (addendum, project context, skills, cwd, custom
		// sections) apply to both preambles, so the shell-only branch only differs in
		// what it leaves out: the tool list and the docs section.
	} else {
		promptSections.preamble = "You are an expert coding assistant operating inside nanopi, a coding agent harness.";
		const visibleTools = declaredTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nMore tools may be registered by the project.`;
		promptSections.rules = buildRules(declaredTools, toolGuidelines, promptGuidelines);
		// A flavor that drops the docs and examples trees has no files to point
		// at, so the section would be dead weight in every prompt.
		if (isBuildComponentEnabled("docs")) {
			promptSections.docs = `nanopi docs, only when the user asks about nanopi itself, its SDK, extensions, skills, or TUI:
- Index: ${getDocsPath()}/index.md; overview: ${getReadmePath()}; examples: ${getExamplesPath()}
- Resolve docs/... and examples/... against those directories, not the cwd; follow .md cross-references and read referenced files completely before implementing`;
		}
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	// A hidden reader is still reachable through another tool, so skills stay but the hint names no tool.
	const readers = ["read", "bash"] as const;
	const skillFileReadTool =
		readers.find((tool) => declaredTools.includes(tool)) ??
		(readers.some((tool) => selectedTools.includes(tool)) ? "indirect" : undefined);
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.cwd = cwd.replace(/\\/g, "/");
	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
	}

	return tagSections(promptSections);
}

function tagSections(promptSections: Record<string, string>): SystemPromptSections {
	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
