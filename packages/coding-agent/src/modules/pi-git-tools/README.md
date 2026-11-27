# pi-git-tools

One read-only git tool without GitHub or `gh`: `git` with `action=status`,
`action=diff`, `action=log`, and `action=branch`. Every action is capped so a
noisy repository cannot spend the whole context.

`git action=diff` returns a raw patch by default. With `mode=reading` it returns
a faithful reading diff: a subagent submits remove/fold/replace line coordinates
and the compiler in `src/vendor/` emits every untouched line verbatim, so the
result cannot invent content. Large diffs are chunked at file and hunk
boundaries and cached by content hash. `mode=reading` requires
`pi-subagent-mini`.
