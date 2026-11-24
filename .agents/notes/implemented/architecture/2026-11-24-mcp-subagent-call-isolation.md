# Agent Note: MCP subagents run one tool under an MCP-only prompt

Status: implemented

## Problem

The `mcp` shell delegated a server call to a subagent, but the child still
looked like an ordinary coding agent: it received `mcp__<server>__<tool>,read`,
the default coding-assistant system prompt, and a brief that talked about not
touching the working tree. An MCP call is a single tool invocation; giving the
child file tools and file-related instructions widens both the tool surface and
the prompt it never needs.

The repository also carried Pi upstream codemode comments about
`structuredContent`, nested calls, and `ToolExposure`. Those described a script
orchestration layer this build does not have. They are misleading next to code
whose actual caller is a tool or a programmatic adapter.

## Decision

The `mcp` shell now spawns a child with exactly one active tool,
`mcp__<server>__<tool>`, and sets `mcpOnlyPrompt: true` on the subagent call.
That flag maps to `--mcp-only-prompt`, which replaces the child's system prompt
with a short MCP worker prompt. The child also gets `--no-context-files`, so
project context cannot reintroduce unrelated instructions. The brief states the
server, tool, arguments, and verbatim output requirement only; file and working
tree wording is gone.

Ordinary subagents are unchanged: they keep their inherited tool list and
coding-assistant prompt, and may still name `mcp__*` tools explicitly. The
narrow prompt is a spawn-level flag, not a property of MCP tools themselves.

Codename-based comments in `packages/ai/src` and `packages/coding-agent/src`
now describe the real callers instead: programmatic callers receive
`structuredContent`, another tool may issue nested calls, and
`ToolExposure` stays `direct | model-only | hidden`. Changelogs and test
fixture tool names keep the historical codemode text because they record past
releases or generic provider payloads.

## Alternatives considered

- **Filter prompt sections inside mcp-lite.** The shell has no access to the
  child's prompt-building path; it only hands arguments to `subagent`. Adding
  another payload channel there would duplicate what the `customPrompt` option
  already does in `main.ts`.
- **Add an MCP tool guideline in the extra module that suppresses other
  sections.** Guidelines are additive. They could ask the model to ignore the
  rest of the prompt but could not remove tool snippets, context files, or
  shell-related rules.
- **Drop the subagent hop and let `mcp` call the server directly.** Cheaper and
  simpler, but the external payload would land in the main transcript, which is
  the isolation this design exists to provide.

## Consequences

- An MCP child has one declared tool and a prompt about one MCP call. The
  parent still passes the brief in the user message, so the server name, raw
  tool name, and arguments stay visible to the child.
- Builds without `subagent` still execute the call in-process in the `mcp`
  shell. The narrow prompt does not apply there; the main agent's own prompt
  and tool set remain in force.
- `--mcp-only-prompt` is a CLI flag on a par with `--no-skills` and
  `--no-prompt-templates`. Any caller can use it, but only the MCP shell sets
  it today.
