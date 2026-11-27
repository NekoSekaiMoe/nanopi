# pi-git-tools

One read-only git tool without GitHub or `gh`: `git` with `action=status`,
`action=diff`, `action=log`, and `action=branch`. Every action is capped so a
noisy repository cannot spend the whole context.

`git` with `action=diff` and `abridge: true` delegates large patches to a
subagent running `meat`. Without `pi-subagent-mini` it returns the raw diff.
