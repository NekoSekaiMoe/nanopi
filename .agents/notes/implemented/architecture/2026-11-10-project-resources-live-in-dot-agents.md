# Agent Note: Project skills and prompts live in `.agents`

Status: implemented

## Problem

Two project directories held the same kind of file under two names. `.agents/`
held the notes and the vendored `write-notes-like-deepseek` skill; `.nanopi/`
held this repository's own skills, prompt templates, and modules. Skills and
prompts are authored text that any agent tool can read, so a checkout that used
another tool had to duplicate or symlink them, and a contributor had to learn
which directory owns which file before adding one.

`.nanopi/` is not interchangeable with `.agents/`: it is machine-local state,
the same directory that holds `settings.json`, sessions, and credentials. Moving
files into it because they are "project configuration" invites the opposite move
later — a tool writing state into the directory a project commits.

## Decision

The project scope of skills and prompt templates is `.agents/skills/` and
`.agents/prompts/`. Both are searched in `cwd` and every ancestor, so a nested
checkout (`repo/packages/app`) finds the resources at the repository root.

`.nanopi/skills/` and `.nanopi/prompts/` are still read, after `.agents/`. The
legacy directory stays for two reasons: an existing checkout keeps working with
no migration step, and `.nanopi/` remains where project *state* lives, so a
project that wants a committed prompt next to its settings is not broken.

`.nanopi/extensions/` and the new `.agents/extensions/` are the one project
resource with no `.agents`-first rule to inherit: modules are code only nanopi
loads, so `.agents/extensions/` exists for symmetry with the files beside it,
not because another tool reads modules. Both load when the project is trusted,
`.agents/` first.

Project trust covers both locations. `hasTrustRequiringProjectResources()` asks
`hasProjectResourceDirs()`, which is the same function `resolveLocalResources()`
uses to find them, so "requires trust" and "is loaded" cannot drift. The user's
own `~/.agents/skills` and `~/.agents/prompts` are filtered out of the project
list — they are always trusted user resources, including when `cwd` is `$HOME`.

Precedence is `.agents/` before `.nanopi/`, and within each directory the
existing rule applies: a skill or template found first wins, a later path with
the same name is a collision diagnostic rather than an override.

## Consequences

`resource-discovery.ts`, `skills.ts`, `prompt-templates.ts`, and
`resource-loader.ts` all take their project directories from
`projectResourceDirs()` in `core/agents-dirs.ts`, so a new reader cannot invent
a third search order. The loaders keep their old quirks deliberately:
`.nanopi/skills` still accepts flat `.md` files at its root, while an
`.agents/skills` directory only counts nested `SKILL.md`, because that
directory may hold other agents' files.

`loadSkills()` reads the project directories only when `cwd` is also one of the
skill paths it was given. The session passes both; a caller that hands in a bare
target directory (the SDK examples, tests) gets that directory alone, so pointing
nanopi at another project does not silently attach the directories above it.

The walk is ancestors of `cwd`, not of the git root. That matches how `AGENTS.md`
and the existing `.agents/skills` search already behaved; a checkout inside
`$HOME` therefore also picks up `~/.agents/skills` as a project directory unless
it is filtered, which is why the filter is by path rather than by "root reached".

Upstream notes that still name `.nanopi/skills` or `.nanopi/prompts` as the
project location describe the old layout; this note supersedes those paths.

## Alternatives considered

**Read only `.agents/` and drop `.nanopi/`.** This is the clean end state, but it
breaks every existing project at once: skills and prompts silently stop loading,
and the only signal is a `/status` list that is now shorter. A two-directory read
costs a few lines in one function and can be removed in a release that announces
the break.

**Symlink `.nanopi/skills` to `../.agents/skills` in this repository.** A symlink
fixes this checkout and nothing else, and it hides the question the loaders have
to answer anyway: what happens to other projects on the new release.

**Keep everything in `.nanopi/` and make `.agents/` a link.** This reverses the
direction of the move and inside-out someone else's convention: `.agents/` is
the name other agent tools already read, and nanopi cannot rename a directory it
does not own.

## Testing

`packages/coding-agent/test/resource-discovery.test.ts` builds a repository with both directories and
asserts the nested checkout sees the `.agents` skill, that a `cwd`-level load
reads `.nanopi` as well, and that `.agents/prompts` wins the ordering.
`packages/coding-agent/test/trust-manager.test.ts` covers `.agents/prompts` requiring trust on its own.
