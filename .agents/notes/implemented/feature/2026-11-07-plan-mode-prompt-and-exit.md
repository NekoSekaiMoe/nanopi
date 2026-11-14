# Agent Note: Plan mode as a prompt section plus a plan-shaped exit

Status: implemented

## Problem

Issue #622 asked for the plan-mode prompt to be rewritten. Reading the code
first turned up three defects that a prompt rewrite alone would not fix.

**The prompt said things the code did not do.** `PLAN_GUIDELINE` was a bullet in
the `<rules>` list, so every rule in plan mode was one bullet among the shared
ones, and leaving plan mode looked like the whole rules section changing. It
also pointed at tools that do not exist, and at a shell allowlist
(`ls`/`find`/`pwd`) too narrow to ground a plan: an agent could list a
directory but not read a file, so it planned on names it never opened.

**The block message named the wrong tool set.** `planModeVerdict` refused a
write with `plan mode allows only ls, find, and pwd through the shell`, which
was stale in the same way and told the model nothing about where the work was
supposed to go.

**Every run ended at the same prompt.** `agent_settled` asked
`Plan ready. Execute it, or keep refining?` regardless of what the turn did. A
turn that ended in `ask_user_question` — phase 2 of the guideline, the
question the plan exists to ask — was asked to approve a plan the user had not
answered yet. The only way out was to decline `Stay in plan mode` and retype
the answer, and the second option was a dead end with no stated next step.

## Decision

**The plan rules are a prompt section, not a bullet.** `BuildSystemPromptOptions`
gains `guidelineSections?: string[]`, rendered as its own `<guidelines>` section
(`appendGuidelineSections` in `system-prompt.ts`, trimmed and deduped the same
way `buildRules` dedupes). `extension.ts` pushes `PLAN_GUIDELINE` there and
keeps `read`/`write` guidance in `promptGuidelines`. Entering plan mode adds a
section; leaving it removes that section. It never rewrites the shared rules.

**The read-only allowlist now matches what planning needs.** `plan-shell.ts`
allows `ls, find, pwd, cat, head, tail, wc, grep, rg, tree, file, stat, du,
diff, echo, git, gh`. `git` and `gh` are verbs, not names: `git log` and
`git diff` read, `git branch new-name` and `git checkout` write.
`PLAN_GIT_SUBCOMMANDS` lists only reading subcommands, excludes `git branch`
(it creates without `-l`/`--list`), and `GIT_OPTIONS_WITH_VALUE` keeps
`git -C dir` from being read as a subcommand. `ghIsReadOnly` requires a reading
verb (`view`, `list`, `diff`, `status`, `checks`, `download`, `log`) for
`pr`/`issue`/`run`/`repo`/`release`, and `READ_HTTP_METHODS` rejects
`gh api -X POST`. Flags that write (`-m`, `-b`, `--force`) are refused even on a
reading verb.

**Three phases, stated as phases.** `PLAN_GUIDELINE` names them: ground in the
environment (read before asking), settle intent (goal, success criteria, scope,
constraints), design the implementation (files, interfaces, edge cases,
verification, assumptions). The plan is prose with a fixed section shape in the
reply, not a file: `## <title>`, `## Changes`, `## Interfaces`, `## Tests`,
`## Assumptions`. Execution is the user's decision, so the guideline ends with
"do not ask whether to proceed".

**The exit prompt reads the turn.** `agent_settled` carries the transcript
(`messages?: readonly AgentMessage[]` added to `AgentSettledEvent`), and
`lastTurnAskedUser` checks whether the last assistant message holds a
`toolCall` named `ask_user_question`. If it does, the run continues in the same
mode with no prompt — the user still has a question in front of them, and the
answer is what revises the plan. `MAX_QUESTION_TURNS = 3` bounds this, so a
question-shaped loop cannot hold the exit prompt forever; the counter resets on
`session_start` and on a new `/plan`.

When the run does end in a plan, the options are
`Exit plan mode and execute` and `Keep planning (type what to change)`. The
second one notifies `Type what to change and the next turn revises the plan.`
instead of returning silently, and its message is the revision.

**`enter_plan_mode` makes the phase reachable from the model side.** Without
it, `write a plan for X` in a standard session had no non-mutating answer. The
tool flips the mode and returns; it does not arm the exit prompt, because the
user's request is already the plan-mode turn.

## Alternatives considered

- **Keep the guideline as one more bullet and prefix each line with
  `[PLAN MODE]`.** Bullets are deduped and joined into `<rules>`, so leaving
  the mode silently changed a dozen lines of the shared section. A section
  that appears and disappears is cheaper to read on both ends of the change.
- **Widen the allowlist by adding every reading tool.** `grep`, `find`, and
  `ls` exist as dedicated tools, and allowing them would have covered a
  fraction of what `cat`/`rg`/`git diff` does; the shell analyzer already
  refuses writes, so routing reads through the shell keeps one policy to
  maintain instead of two.
- **Allow `compile` so the plan can prove the build.** Rejected: `pnpm run
  check` writes as much as it reads, and a plan claiming "the tests pass" is a
  claim the planning phase cannot make. The guideline states what will verify
  the change; the execution turn proves it.
- **Keep `exit_plan_mode` in the allowlist.** No such tool is registered, so
  the allowlist named something the model could not call. The exit is a user
  prompt, not a tool call.
- **Always prompt on `agent_settled`, whatever the turn did.** That was
  defect three: it asks the user to approve a plan they were just asked to
  answer a question about, and the transcript already says which case it is.

## Consequences

- Entering plan mode gains a `<guidelines>` section and leaving it drops one;
  the prompt-budget pins (`sku-prompt-budget.test.ts`) do not move, because
  neither SKU enters plan mode.
- Plan-mode turns can now read the repository, so a plan that names a file
  names a file that exists. The analyzer is the boundary: an unmodeled verb is
  refused, which is the same failure shape as before but with far fewer of
  them.
- The exit prompt is only as good as the detection: a turn that ends with a
  question phrased in prose rather than `ask_user_question` still gets the
  approval prompt. That is the intended tradeoff — the tool is the case the
  guideline asks for.
- Testing: `packages/extra/test/plan-shell.test.ts` covers the widened allowlist and the
  `git`/`gh` write verbs, `packages/extra/test/plan-mode-policy.test.ts` covers the tool
  policy and the block message, and `packages/coding-agent/test/system-prompt.test.ts` covers
  `<guidelines>` rendering and its empty case.
