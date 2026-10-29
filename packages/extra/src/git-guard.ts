/**
 * Destructive git commands: what they hit, and how to report them.
 *
 * `AGENTS.md` forbids `git reset --hard`, `git stash`, `git add -A` and friends,
 * but the rule has no enforcement layer, so a model that forgets it destroys the
 * uncommitted work of every other session sharing the checkout. The permission
 * gate is where that rule becomes executable (see
 * .agents/notes/implemented/architecture/2026-10-26-destructive-git-guard.md).
 *
 * The analysis is about the *index and working tree of one checkout*: every
 * mode/option field an agent sets is per-worktree, so only the checkout the
 * command reaches matters, not which branch it is on. `git worktree add` (what a
 * subagent's `isolated: true` uses) is therefore a real answer, and
 * `git -C <other worktree> …` is recognized as running elsewhere.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Why a command needs a permission prompt before it runs in this checkout. */
export interface DestructiveGitHit {
	/** The subcommand as written (`stash`, `reset`). */
	subcommand: string;
	/** One line naming the hazard, shown in the prompt and in the tool result. */
	reason: string;
}

/**
 * What a command does to checkouts. `checked` is false when the analyzer could
 * not decide (unparsable shell, a shell this analyzer does not model), which the
 * caller treats as "no verdict", never as a denial.
 */
export type GitGuardVerdict =
	| { checked: false }
	| {
			checked: true;
			/** Nothing destructive reaches this checkout. */
			hit?: undefined;
			/** Set when the command keeps its work outside this checkout. */
			isolated?: { path: string };
	  }
	| { checked: true; hit: DestructiveGitHit; isolated?: undefined };

/** Options every git subcommand accepts, before the subcommand word. */
const GLOBAL_OPTIONS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--git-dir": true,
	"--work-tree": true,
	"--namespace": true,
	"--config-env": true,
	"--super-prefix": true,
};

/** Short flags that ARE an argument (`git add -A`, `git clean -fdx`), not options. */
const SUBCOMMAND_ARGUMENT_FLAGS: Record<string, readonly string[]> = {
	add: ["-A", "-u", "-p", "-i", "-N"],
	clean: ["-f", "-d", "-x", "-X", "-n", "-q"],
};

/** Flags that take a value inside one subcommand, so its value is not read as a pathspec. */
const SUBCOMMAND_VALUE_FLAGS: Record<string, readonly string[]> = {
	add: ["--chmod", "--pathspec-from-file"],
	clean: ["-e", "--exclude"],
	commit: ["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "-t", "--template"],
	push: ["-o", "--push-option", "--repo"],
	reset: ["--pathspec-from-file"],
	restore: ["-s", "--source", "--pathspec-from-file"],
	worktree: ["-b", "-B", "--reason"],
};

/**
 * Option value for a global flag: `--work-tree=path` or the next word. Short
 * flags take the value in the next word (`git -C dir …`), never inline, because
 * `-Cpath` and `-cname=value` are far rarer than a flag followed by its value.
 */
function optionValue(word: string, rest: readonly string[]): { value?: string; consumed: number } {
	const inline = /^--[^=]+=(.*)$/.exec(word)?.[1];
	if (inline !== undefined) return { value: inline, consumed: 0 };
	const next = rest[0];
	return next === undefined ? { consumed: 0 } : { value: next, consumed: 1 };
}

/**
 * Verdict for one git invocation (the words of a single command, `git` first).
 * `cwd` is where the shell runs it, so a relative `-C`/`--work-tree` resolves there.
 */
export function analyzeGitInvocation(words: readonly string[], cwd: string): GitGuardVerdict {
	if (words[0] !== "git") return { checked: false };
	const args = words.slice(1);

	let checkoutDir = cwd;
	/** `-C`/`--work-tree` moved the command, so whatever it hits is not this checkout. */
	let movedCheckout = false;
	let index = 0;
	while (index < args.length) {
		const word = args[index] ?? "";
		if (!word.startsWith("-")) break;
		index += 1;
		const flag = word.split("=")[0] ?? word;
		if (!GLOBAL_OPTIONS[flag]) continue;
		const { value, consumed } = optionValue(word, args.slice(index));
		index += consumed;
		if (value === undefined || (flag !== "-C" && flag !== "--work-tree")) continue;
		checkoutDir = resolve(cwd, value);
		movedCheckout = true;
	}

	const subcommand = args[index];
	if (subcommand === undefined) return { checked: false };
	const rest = args.slice(index + 1);

	if (subcommand === "worktree") {
		// The subcommands an agent uses here are exactly the isolation ones: `add -b
		// <branch> <dir> [<commit-ish>]` (subagent `isolated: true`) and `remove <dir>`.
		// The tree is the first positional after any commit-ish-less `add`, and both
		// forms put it after the branch name, so the first existing path wins.
		const positional = positionalArgs(rest, [], SUBCOMMAND_VALUE_FLAGS.worktree ?? []).filter(
			(word) => word !== "add" && word !== "remove",
		);
		const dir = positional.map((word) => resolve(cwd, word)).find((word) => !word.endsWith("/HEAD"));
		// Everything after `worktree add` happens in a tree the caller now owns.
		return dir === undefined ? { checked: true } : { checked: true, isolated: { path: dir } };
	}

	// A `-C` that points back at this same checkout (`git -C . stash`) is not isolation;
	// pointing anywhere else, existing or not, means the command is not ours to judge.
	const elsewhere = movedCheckout && !sameCheckout(checkoutDir, cwd);
	const hit = DESTRUCTIVE_SUBCOMMANDS[subcommand]?.(rest, { elsewhere });
	if (hit) return { checked: true, hit };
	if (elsewhere) return { checked: true, isolated: { path: checkoutDir } };
	return { checked: true };
}

/**
 * Arguments a subcommand acts on: positionals plus the argument-carrying short
 * flags (`git add -A`, `git clean -fdx`), with value-taking options and their
 * values dropped so a `-m "fix ."` message is not read as a pathspec.
 */
function positionalArgs(
	args: readonly string[],
	argumentFlags: readonly string[],
	valueFlags: readonly string[],
): string[] {
	const positional: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const word = args[index] ?? "";
		if (word === "--") {
			positional.push(...args.slice(index + 1));
			break;
		}
		if (!word.startsWith("-") || word === "-") positional.push(word);
		else if (argumentFlags.includes(word)) positional.push(word);
		else if (
			!word.startsWith("--") &&
			argumentFlags.some((flag) => /^-[a-z]$/.test(flag) && word.includes(flag[1] ?? ""))
		) {
			positional.push(word);
		}
		const valueFlag = valueFlags.find((candidate) => word === candidate);
		if (valueFlag) index += 1;
	}
	return positional;
}

/** Flags of a subcommand (short-flag bundles such as `-fdx` kept whole). */
function flagArgs(args: readonly string[]): string[] {
	return args.filter((word) => word.startsWith("-") && word !== "-" && word !== "--");
}

/** Pathspec test for "every file": `.`, `*`, `-A`/`--all`, or a wildcard in the pathspec. */
function matchesEveryPath(positional: readonly string[]): boolean {
	return positional.some((entry) => entry === "." || entry === "-A" || entry === "--all" || entry.includes("*"));
}

interface HitContext {
	/** The command runs with `-C`/`--work-tree` in a different checkout. */
	elsewhere: boolean;
}

/**
 * Per-subcommand hazard. A subcommand missing from this table cannot touch the
 * index or the working tree, so a `git -C` in it still counts as isolation.
 */
const DESTRUCTIVE_SUBCOMMANDS: Record<
	string,
	(args: readonly string[], ctx: HitContext) => DestructiveGitHit | undefined
> = {
	reset(args, ctx) {
		if (ctx.elsewhere) return undefined;
		if (flagArgs(args).some((flag) => flag === "--hard" || flag === "--merge" || flag === "--keep")) {
			return { subcommand: "reset", reason: "`git reset --hard` discards uncommitted changes in the working tree" };
		}
		// A pathspec reset only reloads those files from HEAD: still per-checkout.
		const positional = positionalArgs(args, [], SUBCOMMAND_VALUE_FLAGS.reset ?? []);
		if (positional.length > 0) return undefined;
		return {
			subcommand: "reset",
			reason: "`git reset` moves HEAD and the index, unhooking another session's commits",
		};
	},
	stash(args, ctx) {
		const action = positionalArgs(args, [], []).find((word) => word !== "stash");
		if (action === "list" || action === "show" || action === "branch") return undefined;
		// Another checkout's stash stack is not the one this session shares.
		if (ctx.elsewhere) return undefined;
		if (action === "drop" || action === "clear") {
			return {
				subcommand: "stash",
				reason: `\`git stash ${action}\` deletes stash entries nobody else can recover`,
			};
		}
		return {
			subcommand: "stash",
			reason: "`git stash` empties the working tree, including changes another session may be writing",
		};
	},
	clean(args, ctx) {
		if (ctx.elsewhere) return undefined;
		// Without -f, clean refuses to delete anything, so only the forcing form matters.
		const flags = [...flagArgs(args), ...positionalArgs(args, SUBCOMMAND_ARGUMENT_FLAGS.clean ?? [], [])];
		if (!flags.some((flag) => /^-[a-zA-Z]*f/.test(flag) || flag.startsWith("--force"))) return undefined;
		return { subcommand: "clean", reason: "`git clean -f` deletes untracked files, which git cannot restore" };
	},
	add(args, ctx) {
		const arguments_ = positionalArgs(args, SUBCOMMAND_ARGUMENT_FLAGS.add ?? [], SUBCOMMAND_VALUE_FLAGS.add ?? []);
		// `git add -u` stages tracked changes only; it cannot pick up another session's new files.
		if (arguments_.some((arg) => arg === "-u" || arg === "--update")) return undefined;
		if (!matchesEveryPath(arguments_)) return undefined;
		const scope = ctx.elsewhere ? "the index of that checkout" : "the index";
		return {
			subcommand: "add",
			reason: `\`git add -A\`/\`git add .\` stages every file in ${scope}, including scratch files another session left untracked`,
		};
	},
	commit(args) {
		if (!flagArgs(args).some((flag) => flag.startsWith("--no-verify"))) return undefined;
		return {
			subcommand: "commit",
			reason: "`git commit --no-verify` skips the hooks that add the trailers CI needs",
		};
	},
	checkout(args) {
		const flags = flagArgs(args);
		// -b/-B/--orphan create a branch: the positional is a name, not a pathspec.
		if (flags.some((flag) => flag === "-b" || flag === "-B" || flag === "--orphan")) return undefined;
		const positional = positionalArgs(args, [], []);
		// `git checkout <branch>` switches; only an explicit `.`/pathspec overwrites files.
		if (positional.length === 1 && positional[0] !== ".") return undefined;
		if (positional.length === 0) return undefined;
		return { subcommand: "checkout", reason: "`git checkout .` overwrites uncommitted working-tree changes" };
	},
	restore(args) {
		const flags = flagArgs(args);
		// `git restore --staged` only touches the index, which is recoverable.
		if (flags.includes("--staged") && !flags.includes("--worktree")) return undefined;
		const positional = positionalArgs(args, [], SUBCOMMAND_VALUE_FLAGS.restore ?? []);
		if (positional.length > 0 && !matchesEveryPath(positional)) return undefined;
		return { subcommand: "restore", reason: "`git restore` discards uncommitted working-tree changes" };
	},
	push(args) {
		if (!flagArgs(args).some((flag) => flag === "-f" || flag.startsWith("--force"))) return undefined;
		return {
			subcommand: "push",
			reason: "`git push --force` rewrites a branch everyone else may have based work on",
		};
	},
};

/** Whether two paths land in the same checkout (same worktree root, same common git dir). */
function sameCheckout(a: string, b: string): boolean {
	const left = checkoutOf(a);
	const right = checkoutOf(b);
	if (!left || !right) return false;
	// One repository, same checkout directory. Two worktrees share `commonGitDir`
	// but differ in `repoDir`, which is exactly the "elsewhere" this guard wants.
	return left.repoDir === right.repoDir && left.commonGitDir === right.commonGitDir;
}

interface CheckoutPaths {
	repoDir: string;
	commonGitDir: string;
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Walk up from `dir` to the `.git` marker and read its layout: a directory for an
 * ordinary checkout, a `gitdir:` file for a linked worktree (what `git worktree
 * add` writes; the same shape the footer reads).
 */
function checkoutOf(dir: string): CheckoutPaths | undefined {
	let current = canonical(dir);
	while (true) {
		const marker = join(current, ".git");
		if (existsSync(marker)) {
			try {
				if (statSync(marker).isFile()) {
					const content = readFileSync(marker, "utf8").trim();
					if (!content.startsWith("gitdir: ")) return undefined;
					const gitDir = canonical(resolve(current, content.slice(8).trim()));
					return { repoDir: current, commonGitDir: readCommonDir(gitDir) };
				}
				return { repoDir: current, commonGitDir: canonical(marker) };
			} catch {
				return undefined;
			}
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readCommonDir(gitDir: string): string {
	const commondir = join(gitDir, "commondir");
	try {
		if (!existsSync(commondir)) return gitDir;
		return canonical(resolve(gitDir, readFileSync(commondir, "utf8").trim()));
	} catch {
		return gitDir;
	}
}

/**
 * Every checkout of the repository that contains `cwd`, main one first; empty
 * outside a repository. `dirname(commonGitDir)` is the main checkout: the common
 * dir is `<main>/.git` in a normal layout and `<bare>/` in a bare one, where that
 * directory tracks nothing and simply does not exist as a working tree.
 */
export function listWorktrees(cwd: string): string[] {
	const paths = checkoutOf(cwd);
	if (!paths) return [];
	const main = dirname(paths.commonGitDir);
	const linked: string[] = [];
	try {
		for (const entry of readdirSync(join(paths.commonGitDir, "worktrees"))) {
			try {
				const gitDir = readFileSync(join(paths.commonGitDir, "worktrees", entry, "gitdir"), "utf8").trim();
				linked.push(dirname(canonical(gitDir)));
			} catch {
				// A half-created worktree has no gitdir yet; it is not a checkout to warn about.
			}
		}
	} catch {
		return [paths.repoDir];
	}
	const all = [main, ...linked];
	return [...new Set(all.filter((entry) => existsSync(entry) || entry === paths.repoDir))];
}

/** The checkout a command runs in, or undefined outside a repository. */
export function checkoutRoot(cwd: string): string | undefined {
	return checkoutOf(cwd)?.repoDir;
}

/** One line appended to a blocked command's output, so the next call sees the rule. */
export function gitGuardNotice(hit: DestructiveGitHit, worktrees: readonly string[]): string {
	const hint =
		worktrees.length > 1
			? `This repository has ${worktrees.length} checkouts; run destructive commands in a worktree you own (git worktree add -b <branch> <dir>).`
			: "Give the work its own checkout when other sessions share this one (git worktree add -b <branch> <dir>).";
	return `Blocked by the git guard: ${hit.reason}. ${hint} Ask the user when the command is really intended.`;
}

// ============================================================================
// Shell layer: which git invocations does this command line actually run?
// ============================================================================

/** Shells whose `-c` string this analyzer can descend into, `bash -c 'git reset --hard'`. */
const KNOWN_SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Words that precede the command in a simple command (`FOO=1 sudo git …`). */
const WRAPPERS = new Set(["command", "exec", "nohup", "sudo", "time", "builtin", "env"]);
const SHELL_CONTROL_WORDS = new Set(["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "until", "!"]);

/** One invocation this analyzer is willing to judge, in source order. */
interface ShellInvocation {
	words: string[];
	/** Directory the command runs in (`cd`, or the enclosing shell's cwd). */
	cwd: string;
}

/** How deep a substitution or `bash -c` may nest before the analyzer gives up (returns "not checked"). */
const MAX_SHELL_DEPTH = 8;

class Unsupported extends Error {}

/**
 * Every git invocation a command line runs, with the directory each runs in.
 * Throws `Unsupported` for shell shapes this analyzer does not model: the caller
 * then has no verdict, which is a missed prompt, never a wrong block.
 */
export function collectGitInvocations(command: string, cwd: string): ShellInvocation[] {
	return scanCommand(command, cwd, 0);
}

function scanCommand(command: string, cwd: string, depth: number): ShellInvocation[] {
	if (depth > MAX_SHELL_DEPTH) throw new Unsupported("nesting");
	const found: ShellInvocation[] = [];
	let currentDir = cwd;
	for (const segment of splitCommandLists(command)) {
		const words = segment.words;
		if (words.length === 0) continue;
		found.push(...scanSubstitutions(segment.raw, currentDir, depth));
		const head = skipWrappers(words);
		if (head.length === 0) continue;
		const program = head[0] ?? "";
		if (program === "cd" || program === "pushd") {
			const target = head[1] ?? "~";
			// A computed directory makes every later `git` in the line unknowable.
			if (target.includes("$") || target.includes("`")) throw new Unsupported("dynamic cd");
			currentDir = target === "~" ? homedir() : resolve(currentDir, target);
			continue;
		}
		if (program === "git") {
			found.push({ words: head, cwd: currentDir });
			continue;
		}
		if (KNOWN_SHELLS.has(program)) {
			const script = shellScriptArgument(head);
			if (script === undefined) throw new Unsupported("shell without -c");
			found.push(...scanCommand(script, currentDir, depth + 1));
		}
	}
	return found;
}

/** `bash -c '…'` (and `-lc`, `-ec`) give the analyzer the string the shell will run. */
function shellScriptArgument(words: readonly string[]): string | undefined {
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "-c") return words[index + 1];
		if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) {
			// Bundled flags: `-lc '…'` puts the script in the next word, `-c'…'` inline.
			const rest = word.slice(word.indexOf("c") + 1);
			return rest.length > 0 ? rest : words[index + 1];
		}
	}
	return undefined;
}

/** Drop leading `FOO=bar` assignments and wrapper commands (`sudo`, `env`, `command`). */
function skipWrappers(words: readonly string[]): string[] {
	let index = 0;
	while (index < words.length) {
		const word = words[index] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word) || SHELL_CONTROL_WORDS.has(word)) {
			index += 1;
			continue;
		}
		break;
	}
	return words.slice(index);
}

/** `$(…)` and backticks run their bodies; their git invocations count too. */
function scanSubstitutions(raw: string, cwd: string, depth: number): ShellInvocation[] {
	const found: ShellInvocation[] = [];
	let index = 0;
	while (index < raw.length) {
		const ch = raw[index];
		if (ch === "'") {
			index = raw.indexOf("'", index + 1);
			if (index === -1) throw new Unsupported("unterminated quote");
			index += 1;
			continue;
		}
		if (ch === "\\") {
			index += 2;
			continue;
		}
		if (ch === "$" && raw[index + 1] === "(") {
			const end = matchingParen(raw, index + 1);
			found.push(...scanCommand(raw.slice(index + 2, end), cwd, depth + 1));
			index = end + 1;
			continue;
		}
		if (ch === "`") {
			const end = raw.indexOf("`", index + 1);
			if (end === -1) throw new Unsupported("unterminated backtick");
			found.push(...scanCommand(raw.slice(index + 1, end), cwd, depth + 1));
			index = end + 1;
			continue;
		}
		index += 1;
	}
	return found;
}

function matchingParen(raw: string, openIndex: number): number {
	let depth = 0;
	for (let index = openIndex; index < raw.length; index++) {
		const ch = raw[index];
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	throw new Unsupported("unterminated substitution");
}

const LIST_SEPARATOR = /^(?:&&|\|\||\||&|;|\n)/;

/** One simple command: its raw source (for substitutions) and its unquoted words. */
interface Segment {
	raw: string;
	words: string[];
}

/**
 * Split a command line into simple commands at `;`, `&&`, `||`, `|`, `&`, newlines
 * and subshell boundaries. Quoting is tracked so quoted `;` stays literal, and
 * redirections are dropped from the words they would otherwise pollute.
 */
function splitCommandLists(command: string): Segment[] {
	const segments: Segment[] = [];
	let word = "";
	let words: string[] = [];
	const endWord = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	const endSegment = (source: string) => {
		endWord();
		if (words.length > 0) segments.push({ raw: source, words });
		words = [];
	};
	let segmentStart = 0;
	for (let index = 0; index < command.length; index++) {
		const ch = command[index] ?? "";
		if (ch === "\\") {
			word += command[index + 1] ?? "";
			index += 1;
			continue;
		}
		if (ch === "'") {
			const end = command.indexOf("'", index + 1);
			if (end === -1) throw new Unsupported("unterminated quote");
			word += command.slice(index + 1, end);
			index = end;
			continue;
		}
		if (ch === '"') {
			const end = findClosingDoubleQuote(command, index);
			word += command.slice(index + 1, end);
			index = end;
			continue;
		}
		// A comment runs to end of line; inside a word `#` is just a character.
		if (ch === "#" && word === "") {
			const end = command.indexOf("\n", index);
			index = end === -1 ? command.length : end - 1;
			continue;
		}
		// Subshell boundaries: `(cd x && git stash)` ends the segment it opens.
		// Operators are matched whole so `||` and `|&` cannot leave a stray `|`
		// behind to be read as an argument of the command before it.
		const separator = LIST_SEPARATOR.exec(command.slice(index));
		if (ch === "(" || ch === ")" || separator) {
			endSegment(command.slice(segmentStart, index));
			index += (separator?.[0].length ?? 1) - 1;
			segmentStart = index + 1;
			continue;
		}
		if (ch === " " || ch === "\t") {
			endWord();
			continue;
		}
		// A redirection target is a file, not an argument of the command.
		if (ch === "<" || ch === ">") {
			endWord();
			while (index + 1 < command.length && !/[ \t;|&\n]/.test(command[index + 1] ?? "")) index += 1;
			continue;
		}
		word += ch;
	}
	endSegment(command.slice(segmentStart));
	return segments;
}

function findClosingDoubleQuote(command: string, openIndex: number): number {
	for (let index = openIndex + 1; index < command.length; index++) {
		const ch = command[index];
		if (ch === "\\") {
			index += 1;
			continue;
		}
		if (ch === '"') return index;
	}
	throw new Unsupported("unterminated quote");
}

/**
 * The verdict for a whole command line, relative to the checkout it runs in.
 * A destructive command anywhere in the line wins; otherwise an invocation that
 * runs in another checkout is reported as isolation.
 */
export function analyzeShellCommand(command: string, cwd: string): GitGuardVerdict {
	let invocations: ShellInvocation[];
	try {
		invocations = collectGitInvocations(command, cwd);
	} catch (error) {
		if (error instanceof Unsupported) return { checked: false };
		throw error;
	}
	let isolated: { path: string } | undefined;
	for (const invocation of invocations) {
		const verdict = analyzeGitInvocation(invocation.words, invocation.cwd);
		if (verdict.checked && verdict.hit) return { checked: true, hit: verdict.hit };
		if (verdict.checked && verdict.isolated) isolated = verdict.isolated;
	}
	return isolated ? { checked: true, isolated } : { checked: true };
}
