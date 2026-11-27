# pi-git-tools

Read-only git tools that do not depend on GitHub or `gh`: `git_status`, `git_diff`, `git_log`, `git_current_branch`. All are capped so a noisy repository cannot spend the whole context.

`git_diff({ abridge: true })` delegates large patches to a subagent running `meat`. Without `pi-subagent-mini` it returns the raw diff.
