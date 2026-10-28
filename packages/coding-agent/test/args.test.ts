import { describe, expect, test } from "vitest";
import { normalizeSessionName, parseArgs } from "../src/cli/args.ts";

describe("parseArgs", () => {
	describe("--version flag", () => {
		test("parses --version flag", () => {
			const result = parseArgs(["--version"]);
			expect(result.version).toBe(true);
		});

		test("parses -v shorthand", () => {
			const result = parseArgs(["-v"]);
			expect(result.version).toBe(true);
		});

		test("--version takes precedence over other args", () => {
			const result = parseArgs(["--version", "--help", "some message"]);
			expect(result.version).toBe(true);
			expect(result.help).toBe(true);
			expect(result.messages).toContain("some message");
		});
	});

	describe("--help flag", () => {
		test("parses --help flag", () => {
			const result = parseArgs(["--help"]);
			expect(result.help).toBe(true);
		});

		test("parses -h shorthand", () => {
			const result = parseArgs(["-h"]);
			expect(result.help).toBe(true);
		});
	});

	describe("--print flag", () => {
		test("parses --print flag", () => {
			const result = parseArgs(["--print"]);
			expect(result.print).toBe(true);
		});

		test("parses -p shorthand", () => {
			const result = parseArgs(["-p"]);
			expect(result.print).toBe(true);
		});

		test("parses prompt after -p even when it starts with YAML frontmatter", () => {
			const prompt = "---\ntitle: hello\n---\nSay hi.";
			const result = parseArgs(["-p", prompt]);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual([prompt]);
			expect(result.unknownFlags.size).toBe(0);
		});

		test("does not consume options after -p as prompts", () => {
			const result = parseArgs(["-p", "--provider", "openai", "Say hi."]);
			expect(result.print).toBe(true);
			expect(result.provider).toBe("openai");
			expect(result.messages).toEqual(["Say hi."]);
		});
	});

	describe("--continue flag", () => {
		test("parses --continue flag", () => {
			const result = parseArgs(["--continue"]);
			expect(result.continue).toBe(true);
		});

		test("parses -c shorthand", () => {
			const result = parseArgs(["-c"]);
			expect(result.continue).toBe(true);
		});
	});

	describe("--resume flag", () => {
		test("parses --resume flag", () => {
			const result = parseArgs(["--resume"]);
			expect(result.resume).toBe(true);
		});

		test("parses -r shorthand", () => {
			const result = parseArgs(["-r"]);
			expect(result.resume).toBe(true);
		});
	});

	describe("flags with values", () => {
		test("parses --provider", () => {
			const result = parseArgs(["--provider", "openai"]);
			expect(result.provider).toBe("openai");
		});

		test("parses --model", () => {
			const result = parseArgs(["--model", "gpt-4o"]);
			expect(result.model).toBe("gpt-4o");
		});

		test("parses --api-key", () => {
			const result = parseArgs(["--api-key", "sk-test-key"]);
			expect(result.apiKey).toBe("sk-test-key");
		});

		test("parses --system-prompt", () => {
			const result = parseArgs(["--system-prompt", "You are a helpful assistant"]);
			expect(result.systemPrompt).toBe("You are a helpful assistant");
		});

		test("parses --append-system-prompt", () => {
			const result = parseArgs(["--append-system-prompt", "Additional context"]);
			expect(result.appendSystemPrompt).toEqual(["Additional context"]);
		});

		test("parses multiple --append-system-prompt flags", () => {
			const result = parseArgs(["--append-system-prompt", "Context A", "--append-system-prompt", "Context B"]);
			expect(result.appendSystemPrompt).toEqual(["Context A", "Context B"]);
		});

		test("parses --preset", () => {
			const result = parseArgs(["--preset", "review"]);
			expect(result.preset).toBe("review");
		});

		test("keeps --preset and --append-system-prompt independent", () => {
			const result = parseArgs(["--preset", "review", "--append-system-prompt", "extra"]);
			expect(result.preset).toBe("review");
			expect(result.appendSystemPrompt).toEqual(["extra"]);
		});

		test("parses --session", () => {
			const result = parseArgs(["--session", "/path/to/session.jsonl"]);
			expect(result.session).toBe("/path/to/session.jsonl");
		});

		test("parses --session-id", () => {
			const result = parseArgs(["--session-id", "orchestrated-session"]);
			expect(result.sessionId).toBe("orchestrated-session");
		});

		test("parses --fork", () => {
			const result = parseArgs(["--fork", "1234abcd"]);
			expect(result.fork).toBe("1234abcd");
			expect(result.messages).toEqual([]);
		});

		test("parses --export", () => {
			const result = parseArgs(["--export", "session.jsonl"]);
			expect(result.export).toBe("session.jsonl");
		});

		test("parses --thinking", () => {
			const result = parseArgs(["--thinking", "high"]);
			expect(result.thinking).toBe("high");
		});

		test("parses --models as comma-separated list", () => {
			const result = parseArgs(["--models", "gpt-4o,claude-sonnet,gemini-pro"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet", "gemini-pro"]);
		});

		// Issue #10334
		test("ignores empty entries in --models", () => {
			const result = parseArgs(["--models", "gpt-4o, ,claude-sonnet,"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet"]);
		});
	});

	// Issue #9045
	describe("--output flag", () => {
		// `--mode` is gone: run modes are spelled `--plan` / `--minimal`, so the
		// output interface got a name of its own instead of a second meaning.
		test.each(["text", "json", "rpc"] as const)("parses --output %s", (output) => {
			const result = parseArgs(["--output", output]);
			expect(result.output).toBe(output);
			expect(result.diagnostics).toEqual([]);
		});

		test.each(["yaml", ""])("rejects invalid --output value %j", (output) => {
			const result = parseArgs(["--output", output, "--version"]);
			expect(result.output).toBeUndefined();
			expect(result.version).toBe(true);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: `Invalid output "${output}". Valid values: text, json, rpc` },
			]);
		});

		test("reports a missing --output value", () => {
			const result = parseArgs(["--output"]);
			expect(result.output).toBeUndefined();
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--output requires text, json, or rpc" }]);
		});

		test("does not consume another option as an --output value", () => {
			const result = parseArgs(["--output", "--version"]);
			expect(result.output).toBeUndefined();
			expect(result.version).toBe(true);
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--output requires text, json, or rpc" }]);
		});

		test("reports an invalid --output value after a valid one", () => {
			const result = parseArgs(["--output", "json", "--output", "yaml"]);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: 'Invalid output "yaml". Valid values: text, json, rpc' },
			]);
		});

		test("no longer accepts --mode", () => {
			const result = parseArgs(["--mode", "json"]);
			expect(result.output).toBeUndefined();
			expect(result.diagnostics).toEqual([]);
			expect(result.unknownFlags.get("mode")).toBe("json");
		});
	});

	describe("--name flag", () => {
		test("parses --name flag with value", () => {
			const result = parseArgs(["--name", "my-session"]);
			expect(result.name).toBe("my-session");
		});

		test("parses -n shorthand", () => {
			const result = parseArgs(["-n", "quick-session"]);
			expect(result.name).toBe("quick-session");
		});

		test("preserves empty values for main validation", () => {
			const result = parseArgs(["--name", ""]);
			expect(result.name).toBe("");
		});

		test("normalizes display names and rejects whitespace-only values", () => {
			expect(normalizeSessionName("  named session  ")).toBe("named session");
			expect(normalizeSessionName("   ")).toBeUndefined();
		});

		test("reports missing value", () => {
			const result = parseArgs(["--name"]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--name requires a value" }]);
		});

		test("works alongside other flags", () => {
			const result = parseArgs(["--name", "named-run", "--print", "--model", "gpt-4o", "hello"]);
			expect(result.name).toBe("named-run");
			expect(result.print).toBe(true);
			expect(result.model).toBe("gpt-4o");
			expect(result.messages).toEqual(["hello"]);
		});
	});

	describe("--no-session flag", () => {
		test("parses --no-session flag", () => {
			const result = parseArgs(["--no-session"]);
			expect(result.noSession).toBe(true);
		});

		test("preserves custom session IDs for non-persisting commands", () => {
			expect(parseArgs(["--session-id", "ephemeral-id", "--help"])).toMatchObject({
				sessionId: "ephemeral-id",
				help: true,
			});
			expect(parseArgs(["--session-id", "ephemeral-id", "--list-models"])).toMatchObject({
				sessionId: "ephemeral-id",
				listModels: true,
			});
			expect(parseArgs(["--session-id", "ephemeral-id", "--no-session"])).toMatchObject({
				sessionId: "ephemeral-id",
				noSession: true,
			});
		});
	});

	describe("--list-models --refresh flag", () => {
		test("parses --refresh alongside a search pattern", () => {
			const result = parseArgs(["--list-models", "sonnet", "--refresh"]);
			expect(result.listModels).toBe("sonnet");
			expect(result.listModelsRefresh).toBe(true);
			expect(result.diagnostics).toEqual([]);
		});

		test("rejects --refresh without --list-models", () => {
			const result = parseArgs(["--refresh"]);
			expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
				"--refresh only applies to --list-models",
			);
		});
	});

	describe("--skill flag", () => {
		test("parses single --skill", () => {
			const result = parseArgs(["--skill", "./skill-dir"]);
			expect(result.skills).toEqual(["./skill-dir"]);
		});

		test("parses multiple --skill flags", () => {
			const result = parseArgs(["--skill", "./skill-a", "--skill", "./skill-b"]);
			expect(result.skills).toEqual(["./skill-a", "./skill-b"]);
		});
	});

	describe("--prompt-template flag", () => {
		test("parses single --prompt-template", () => {
			const result = parseArgs(["--prompt-template", "./prompts"]);
			expect(result.promptTemplates).toEqual(["./prompts"]);
		});

		test("parses multiple --prompt-template flags", () => {
			const result = parseArgs(["--prompt-template", "./one", "--prompt-template", "./two"]);
			expect(result.promptTemplates).toEqual(["./one", "./two"]);
		});
	});

	describe("--no-skills flag", () => {
		test("parses --no-skills flag", () => {
			const result = parseArgs(["--no-skills"]);
			expect(result.noSkills).toBe(true);
		});
	});

	describe("--no-prompt-templates flag", () => {
		test("parses --no-prompt-templates flag", () => {
			const result = parseArgs(["--no-prompt-templates"]);
			expect(result.noPromptTemplates).toBe(true);
		});
	});

	describe("--no-context-files flag", () => {
		test("parses --no-context-files flag", () => {
			const result = parseArgs(["--no-context-files"]);
			expect(result.noContextFiles).toBe(true);
		});

		test("parses -nc shorthand", () => {
			const result = parseArgs(["-nc"]);
			expect(result.noContextFiles).toBe(true);
		});
	});

	describe("project approval flags", () => {
		test("parses --approve", () => {
			const result = parseArgs(["--approve"]);
			expect(result.projectTrustOverride).toBe(true);
		});

		test("parses -a shorthand", () => {
			const result = parseArgs(["-a"]);
			expect(result.projectTrustOverride).toBe(true);
		});

		test("parses --no-approve", () => {
			const result = parseArgs(["--no-approve"]);
			expect(result.projectTrustOverride).toBe(false);
		});

		test("parses -na shorthand", () => {
			const result = parseArgs(["-na"]);
			expect(result.projectTrustOverride).toBe(false);
		});
	});

	describe("--verbose flag", () => {
		test("parses --verbose flag", () => {
			const result = parseArgs(["--verbose"]);
			expect(result.verbose).toBe(true);
		});
	});

	describe("--offline flag", () => {
		test("parses --offline flag", () => {
			const result = parseArgs(["--offline"]);
			expect(result.offline).toBe(true);
		});
	});

	describe("tool flags", () => {
		test("parses --no-tools flag", () => {
			const result = parseArgs(["--no-tools"]);
			expect(result.noTools).toBe(true);
		});

		test("parses -nt shorthand", () => {
			const result = parseArgs(["-nt"]);
			expect(result.noTools).toBe(true);
		});

		test("parses --no-builtin-tools flag", () => {
			const result = parseArgs(["--no-builtin-tools"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses -nbt shorthand", () => {
			const result = parseArgs(["-nbt"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses --tools flag", () => {
			const result = parseArgs(["--tools", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses -t shorthand", () => {
			const result = parseArgs(["-t", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses +name and -name tool modifiers", () => {
			const result = parseArgs(["-t", "+llama,-write"]);
			expect(result.tools).toEqual(["+llama", "-write"]);
			expect(result.diagnostics).toEqual([]);
		});

		test("rejects tool names mixed with modifiers", () => {
			const result = parseArgs(["--tools", "read,+llama"]);
			expect(result.tools).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{ type: "error", message: "--tools: tool names cannot be mixed with +name or -name entries" },
			]);
		});

		test("rejects patterns in tool modifiers", () => {
			const result = parseArgs(["-t", "+llama*"]);
			expect(result.tools).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{
					type: "error",
					message: "-t: +name and -name entries take exact tool names, not patterns: +llama*",
				},
			]);
		});

		test("parses --exclude-tools flag", () => {
			const result = parseArgs(["--exclude-tools", "read,bash"]);
			expect(result.excludeTools).toEqual(["read", "bash"]);
		});

		test("parses -xt shorthand", () => {
			const result = parseArgs(["-xt", "read,bash"]);
			expect(result.excludeTools).toEqual(["read", "bash"]);
		});

		test("parses --no-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-tools", "--tools", "read,bash"]);
			expect(result.noTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses --no-builtin-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-builtin-tools", "--tools", "read,bash"]);
			expect(result.noBuiltinTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});
	});

	describe("messages and file args", () => {
		test("parses plain text messages", () => {
			const result = parseArgs(["hello", "world"]);
			expect(result.messages).toEqual(["hello", "world"]);
		});

		test("parses @file arguments", () => {
			const result = parseArgs(["@README.md", "@src/main.ts"]);
			expect(result.fileArgs).toEqual(["README.md", "src/main.ts"]);
		});

		test("parses mixed messages and file args", () => {
			const result = parseArgs(["@file.txt", "explain this", "@image.png"]);
			expect(result.fileArgs).toEqual(["file.txt", "image.png"]);
			expect(result.messages).toEqual(["explain this"]);
		});

		test("captures unknown long flags with string values", () => {
			const result = parseArgs(["--unknown-flag", "message"]);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("message");
		});

		test("captures unknown boolean long flags", () => {
			const result = parseArgs(["--unknown-flag"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe(true);
		});

		test("captures unknown long flags with equals syntax", () => {
			const result = parseArgs(["--unknown-flag=value"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("value");
		});
	});

	describe("complex combinations", () => {
		test("parses multiple flags together", () => {
			const result = parseArgs([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--print",
				"--thinking",
				"high",
				"@prompt.md",
				"Do the task",
			]);
			expect(result.provider).toBe("anthropic");
			expect(result.model).toBe("claude-sonnet");
			expect(result.print).toBe(true);
			expect(result.thinking).toBe("high");
			expect(result.fileArgs).toEqual(["prompt.md"]);
			expect(result.messages).toEqual(["Do the task"]);
		});
	});
});

describe("--modules", () => {
	test("splits the module list", () => {
		expect(parseArgs(["--modules", "extra,pi-fake-opencode,mcp-lite"]).modules).toEqual([
			"extra",
			"pi-fake-opencode",
			"mcp-lite",
		]);
	});

	test("is absent when not passed, so the build default applies", () => {
		expect(parseArgs([]).modules).toBeUndefined();
	});

	test("accepts an empty list rather than the build default", () => {
		// A child pinned to no modules at all must stay expressible.
		expect(parseArgs(["--modules", ""]).modules).toEqual([]);
	});

	describe("subagent child argv", () => {
		// Regression: the child was launched with `-ne` and `-e <path>`, neither of
		// which exists any more. The parse errors aborted the child, and the
		// orphaned `-e` value became `parsed.messages[0]` -- the child's prompt.
		const childArgs = [
			"--output",
			"json",
			"-p",
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-t",
			"read,bash",
			"--modules",
			"extra,pi-subagent-mini",
			"Task: summarize the repo",
		];

		test("parses without diagnostics", () => {
			expect(parseArgs(childArgs).diagnostics).toEqual([]);
		});

		test("keeps the task as the only message", () => {
			expect(parseArgs(childArgs).messages).toEqual(["Task: summarize the repo"]);
		});

		test("does not treat the tool list as a message", () => {
			expect(parseArgs(childArgs).messages).not.toContain("read,bash");
		});
	});
});
