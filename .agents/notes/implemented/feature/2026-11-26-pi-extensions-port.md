# Agent Note: pi-extensions selective port

Status: implemented

## Problem

Issue #824 asked which packages in EstebanForge/pi-extensions are worth picking and then confirmed a port with modifications: take deepwiki and hostname directly; merge git-me's local git commands with show-me-the-meat's diff abridging; move the ask-* delegation into subagents-mini as a preferred-CLI setting; take only rtk's output compactor; take only token-cost-ledger's display layer. The rest stays out.

The port has to fit nanopi's programmatic module system: there is no extension directory or `--extension` flag. Each pick becomes a built-in module under `packages/coding-agent/src/modules/`, registered in `src/modules/index.ts` and declared as a `module/<name>` buildconfig component so flavors can exclude it.

## Decision

> The tool surface and module split below were later superseded by [Git and web research use one name each](../simplification/2026-11-27-git-and-web-tool-merge.md) (issue #852). The constraints and non-tool decisions still hold.

Each pick is a separate module rather than one combined extension, so a flavor or a `--modules` run can take a subset:

- `pi-deepwiki` speaks the hosted DeepWiki MCP JSON-RPC endpoint inline. No MCP adapter. Tool awareness goes into `before_agent_start`; `/deepwiki` only prefills the editor because a command cannot start a turn by itself.
- `pi-hostname` writes one footer status under key `0-hostname`, reduced to the first DNS label. The emoji from upstream is dropped per repository style.
- `pi-git-tools` keeps the pure `git` half of git-me (status, diff, log, current-branch) and drops every `gh`/GitHub call. `git_diff` has an opt-in `abridge` flag that delegates to a subagent.
- `pi-meat` keeps the compiler and chunker from show-me-the-meat. The model submits remove/fold/replace line coordinates; the compiler renders every untouched line verbatim, so a compiled diff is always a projection of the original. The select step runs in a nanopi subagent instead of `createAgentSession`, which is not in this repository's API.
- `pi-output-compact` is only the output-compaction half of rtk, with no `rtk` binary and no command rewriting. It is off unless `<agentDir>/output-compaction.json` sets `outputCompaction.enabled: true`, because every technique is lossy. It returns `structuredContent: undefined` when replacing content, since the old value no longer matches.
- `pi-token-usage` exposes `/token-usage` over nanopi's own `UsageLedgerIndex` and `getUsageCostBreakdown`. There is no second JSONL format and no prices.json: historical cost stays the price recorded on each response.
- subagents-mini gains `subagents.preferredCli` in `extra/settings.json` (project override under `.nanopi/extra/settings.json`). `spawn` accepts a one-off `cli` override. For claude/codex/agy the brief goes to stdin (claude) or a trailing positional after `--` (codex/agy); the current session model id is passed where the CLI accepts `--model`, so there is no second model map. The external CLI's session token is kept on the job for `continue`.

## Constraints

- A preferred-CLI child settles through the same `finish()` path as a nanopi child: retries, kill, timeout, dependencies, and archive stay unchanged. A CLI report is never published when its process was killed by a signal.
- A CLI id is validated against a fixed set plus two aliases; an unknown value is ignored rather than breaking every spawn.
- The compiler uses a cache keyed by compiler revision and chunk content. Changing compiler or rubric logic requires bumping `COMPILER_REV`.
- base and minimal flavors exclude every new module. The full flavor carries them.

## Alternatives considered

- Install the upstream packages as extensions. Rejected: nanopi has no extension loader; the upstream API (`ExtensionAPI`, `createAgentSession`) is not the module API here.
- Port rtk as a whole, including `rtk rewrite`. Rejected: command rewriting needs the `rtk` binary, a config modal, and a TUI layer. Only output compaction saves context, and it is lossy, so it is opt-in.
- Port token-cost-ledger's own JSONL and prices.json. Rejected: nanopi already has a cross-session usage ledger with price snapshots. A second ledger would disagree with `/status`.
- Keep git-me's GitHub tools behind `gh`. Rejected: this project uses the `cnb` API; a `gh`-backed write path would push to the wrong forge.
- Use `createAgentSession` for the meat subagent. Rejected: not part of this repository's published API; `ctx.executeTool("subagent", ...)` is the supported path.

## Consequences

- The full build grows by six modules; the base and minimal builds are unchanged.
- `pi-meat` and `git_diff`'s abridging depend on `pi-subagent-mini`. In a build without subagents, `git_diff` returns the raw diff and `meat` reports the missing dependency instead of failing silently.
- Tool output compaction changes what the model sees. It is disabled by default and must be enabled explicitly for a session that values context over verbatim output.
- Verified by `packages/coding-agent/test/pi-extensions-port.test.ts` (SSE parsing, git log record boundaries, diff chunking, CLI argv and alias resolution, hostname formatting, period boundaries) and `pnpm run check`.

Ref #824
