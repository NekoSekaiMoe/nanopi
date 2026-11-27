# Agent Note: Git and web research use one name each

Status: implemented

Ref: shinytale/nanopi#852

## Problem

Issue #852 started from the size of `Tools definition` in `/context`. The default build exposed four git tools (`git_status`, `git_diff`, `git_log`, `git_current_branch`), two web tools (`web_search`, `read_page`), and two DeepWiki tools (`deepwiki_wiki_structure`, `deepwiki_ask_question`). The user asked to merge the git tools, merge the web tools, and fold DeepWiki into websearch.

These names are not just labels in the tool list. Each one carries a repeated name, description, and outer schema on every request. More importantly, the model has to choose between names that describe the same capability at a different granularity.

## Decision

`pi-git-tools` now registers one `git` tool. `action` selects `status` (default), `diff`, `log`, or `branch`; `cwd` stays at the top level, and the fields used by only one branch (`max_lines`, `target`/`base`/`max_bytes`/`abridge`, `limit`) stay optional in the same object. `git` keeps every earlier output cap and the opt-in `abridge` path through `subagent` + `meat`.

`websearch` now registers one `web` tool. `action` selects `search` (default), `fetch`, `wiki_structure`, or `ask_repo`. Search and fetch keep the engine chain, failover, and key cooldown. DeepWiki's JSON-RPC client moves to `src/modules/websearch/src/deepwiki.ts`; the two former DeepWiki actions become `wiki_structure` and `ask_repo`, and `/deepwiki` prefills a `web` call instead of a removed tool name. `DEEPWIKI_MCP_URL` is unchanged.

The `pi-deepwiki` module is gone. Its component, bundle entry, flavors, vendored-path exclusions, and import in `src/modules/index.ts` are removed with it. DeepWiki now lives with the module that owns the rest of open-web research, so `--modules pi-deepwiki` is no longer a valid selector. `full` still carries DeepWiki through `module/websearch`; `base` and `minimal` still exclude both.

No aliases are kept. A session that remembered `git_diff` or `deepwiki_ask_question` sees only the current tool list.

## Alternatives considered

- **Keep the modules and tools, only trim descriptions.** Cheapest and zero behavior risk. Rejected: the earlier [LSP query merge](../feature/2026-10-27-lsp-query-merge.md) found that description trimming does not remove the model's choice between two names, which is the problem the user raised here.
- **Merge git and web into one `research` tool.** Fewer names still. Rejected: git is local, read-only, and bounded by `cwd` and patch bytes; web is open-world and bounded by engine failover. One schema would put unrelated failure modes in the same action router and make the default action ambiguous.
- **Keep `pi-deepwiki` as a module but set `defaultActive: false` on its tools.** This would remove the tools from the default list without moving code. Rejected: it leaves a third module and a separate build switch, and the user asked for DeepWiki to be part of websearch, not merely hidden.

## Consequences

- Active tool names for these capabilities drop from eight to two. The cost is two larger schemas: branch-only fields are no longer enforced by TypeBox per tool, so missing fields are checked in `execute` and reported as text. If action confusion shows up in tool errors or retries, split the action back into a named tool.
- `/deepwiki` still works as a prompt prefill. It no longer registers a command-owned model tool, because commands cannot start a turn directly.
- `git` with `action=diff` and `abridge: true` still depends on `pi-subagent-mini`; without it, the raw diff is returned.
- Tests now import DeepWiki's parser from `packages/coding-agent/src/modules/websearch/src/deepwiki.ts`. `packages/coding-agent/test/tool-merge.test.ts` covers the registered names, git dispatch, missing-field errors, and the DeepWiki JSON-RPC call shape.

## Verification

- `pnpm run check`
- `node ./test.mjs`
- `packages/coding-agent/test/tool-merge.test.ts` passes with five cases.
- `packages/coding-agent/test/builtin-modules-startup.test.ts` loads the built-in set without startup errors.

The earlier [pi-extensions port note](../feature/2026-11-26-pi-extensions-port.md) owns the original module split. Its tool-surface decisions are superseded by this note; its constraints about subagents, CLI aliases, and output compaction still stand.
