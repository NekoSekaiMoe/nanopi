/**
 * Git Sync Extension
 *
 * Exposes /sync: fetch the current branch's upstream and fast-forward to it.
 * AGENTS.md requires that sync before every commit: a stale branch makes the
 * next pull rewind the branch and drop the commit that was just made.
 */

import { spawnSync } from "node:child_process";
import type { ModuleApi, SessionModule } from "@nanopi/pi-coding-agent";

function git(args: string[], cwd: string) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function lastLine(text: string): string {
	return text.split("\n").at(-1) ?? text;
}

const gitSyncModule: SessionModule = {
	name: "git-sync",
	factory: (nanopi: ModuleApi) => {
		nanopi.registerCommand("sync", {
			description: "Fetch and fast-forward the current branch before committing",
			handler: async (_args, ctx) => {
				const cwd = ctx.cwd;
				const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd);
				if (!upstream.ok) {
					ctx.ui.notify("No upstream for this branch; nothing to sync.", "info");
					return;
				}

				const remoteRef = upstream.stdout;
				const separator = remoteRef.indexOf("/");
				const remote = remoteRef.slice(0, separator);
				const branch = remoteRef.slice(separator + 1);

				const fetched = git(["fetch", "--quiet", remote, branch], cwd);
				if (!fetched.ok) {
					ctx.ui.notify(`git fetch ${remote} ${branch} failed: ${lastLine(fetched.stderr)}`, "error");
					return;
				}

				const counts = git(["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`], cwd);
				if (!counts.ok) {
					ctx.ui.notify(`Cannot compare with ${remoteRef}: ${lastLine(counts.stderr)}`, "error");
					return;
				}
				const [behind, ahead] = counts.stdout.split(/\s+/).map(Number);

				if (behind === 0) {
					ctx.ui.notify(`Already up to date with ${remoteRef}; ${ahead} local commit(s) to push.`, "info");
					return;
				}

				// A fast-forward is the only case where pulling cannot lose a commit.
				if (ahead > 0) {
					ctx.ui.notify(
						`${branch} diverged: ${behind} behind, ${ahead} ahead of ${remoteRef}. Rebase by hand; pulling would drop local commits.`,
						"error",
					);
					return;
				}

				const merged = git(["merge", "--ff-only", remoteRef], cwd);
				if (!merged.ok) {
					ctx.ui.notify(`Fast-forward failed: ${lastLine(merged.stderr)}`, "error");
					return;
				}

				ctx.ui.notify(`Fast-forwarded ${branch} to ${remoteRef} (${behind} commit(s)).`, "info");
			},
		});
	},
};

export default gitSyncModule;
