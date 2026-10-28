/**
 * File-inspection commands run through the shell instead of the tools that do it better.
 *
 * The dedicated tools exist (`read`, `grep`, `ls`, `find`) and the system prompt
 * asks for them (issue #344), but a preference in prose loses to a model's habit
 * as soon as the prompt gets trimmed, and slash commands keep no system prompt at
 * all. `cat -n`, `sed -n '1,80p'` and `grep -rn` also lose what the tools give
 * back: gitignore handling, truncation notices that say where to continue, stable
 * line numbers, and no shell quoting to get wrong.
 *
 * So the refusal is what carries the rule, the way the git guard does it: the
 * call does not run, and the reason names the tool call that replaces it.
 *
 * Narrow on purpose. Only a command whose *sole* purpose is reading files is
 * refused: a pipeline, a redirection, `sed -i`, `grep -q` in a condition, or
 * anything the analyzer does not model is let through.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** `cat` options that are an argument of the tool, not file-operations. */
const CAT_ARGUMENT_FLAGS = new Set(["-n", "-b", "-s", "-v", "-e", "-t", "-A", "-E", "-T", "-u"]);
/** `head`/`tail` options that take a value: `-n 20` and `-n20` are both common. */
const COUNT_VALUE_FLAGS = new Set(["-n", "-c"]);
/** `sed -n` scripts that only print a range (`1,80p`, `10p`, `/start/,/end/p`). */
const SED_PRINT_SCRIPT = /^(?:\d+|\$)?(?:,(?:\d+|\$)?)?p$|^\/.*\/?,\/.*\/?p$/;

/** One command line's verdict: what it runs, and whether those are tool-replaceable reads. */
export type ShellGuardVerdict =
	| { checked: false }
	| {
			checked: true;
			/** Set when every command in the line reads files through the shell. */
			hit?: ShellGuardReason;
	  };

/** Which command was caught, and the tool call that does the same job. */
export interface ShellGuardReason {
	/** The command as written, one simple command (`cat -n src/a.ts`). */
	command: string;
	/** The shell words, unquoted, for a precise replacement hint. */
	words: string[];
	/** The sentence naming the tool call that does this job, without a leading capital choice. */
	hint: string;
}

/** Words that precede the command in a simple command (`FOO=1 sudo cat f`). */
const WRAPPERS = new Set(["command", "exec", "nohup", "sudo", "time", "builtin", "env"]);

/**
 * Shells whose `-c 'script'` is a wrapper, not the command: the script is the
 * real command line and gets analyzed on its own.
 *
 * `bash -c 'cat f'` is the documented way around the guard, and a shell tool
 * invites it. Only the `-c` form counts; `bash script.sh` runs a file this
 * analyzer has not read.
 */
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const SHELL_CONTROL_WORDS = new Set(["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "until", "!"]);

class Unsupported extends Error {}

/**
 * The verdict for a whole command line. `checked: false` means the analyzer saw a
 * shape it does not model (multi-line, `$()` in the command position, a shell
 * script file): no verdict, so the caller allows the call.
 */
export function analyzeFileInspection(command: string, cwd: string): ShellGuardVerdict {
	try {
		const segments = splitSegments(command);
		if (segments.length === 0) return { checked: false };
		let hit: ShellGuardReason | undefined;
		for (const segment of segments) {
			const words = unwrapShellScript(skipWrappers(segment.words));
			if (words.length === 0) continue;
			const verdict = classify(words, segment.piped, cwd);
			if (verdict === "passthrough") return { checked: true };
			hit = verdict;
		}
		return hit ? { checked: true, hit } : { checked: true };
	} catch (error) {
		if (error instanceof Unsupported) return { checked: false };
		throw error;
	}
}

/** Weigh one simple command; `passthrough` covers both "not a read" and "keeps its other uses". */
function classify(words: readonly string[], piped: boolean, cwd: string): ShellGuardReason | "passthrough" {
	const program = words[0] ?? "";
	const args = words.slice(1);
	switch (program) {
		case "cat":
			return catReason(args, piped, cwd);
		case "head":
		case "tail":
			return sliceReason(program, args, piped, cwd);
		case "sed":
			return sedReason(args, piped, cwd);
		case "grep":
		case "rg":
			return grepReason(program, args, piped);
		default:
			// `cd`, `git`, `pnpm`…: nothing to say about a command that is not a file read.
			return "passthrough";
	}
}

function catReason(args: readonly string[], piped: boolean, cwd: string): ShellGuardReason | "passthrough" {
	const files: string[] = [];
	for (const arg of args) {
		// `cat -` reads stdin.
		if (arg === "-") return "passthrough";
		if (arg.startsWith("--")) return "passthrough";
		if (arg.startsWith("-")) {
			for (const flag of arg.slice(1)) {
				if (!CAT_ARGUMENT_FLAGS.has(`-${flag}`)) return "passthrough";
			}
			continue;
		}
		files.push(arg);
	}
	if (files.length === 0) return "passthrough";
	const first = files[0] ?? "";
	return filesReason("cat", files, piped, cwd, `Use the read ${first} tool instead`);
}

function sliceReason(
	program: "head" | "tail",
	args: readonly string[],
	piped: boolean,
	cwd: string,
): ShellGuardReason | "passthrough" {
	const files: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "-") return "passthrough";
		if (arg.startsWith("--")) return "passthrough";
		if (arg.startsWith("-")) {
			// `-n20`/`-c512` carry their value inline; `-n 20` puts it in the next word;
			// `-20` is the oldest spelling of `-n 20`. -q/-v only change what is shown.
			if (/^-[nc]./.test(arg) || /^-\d+$/.test(arg) || /^-[qv]+$/.test(arg)) continue;
			if (COUNT_VALUE_FLAGS.has(arg)) {
				index += 1;
				continue;
			}
			return "passthrough";
		}
		files.push(arg);
	}
	if (files.length === 0) return "passthrough";
	const first = files[0] ?? "";
	return filesReason(program, files, piped, cwd, `Use the read ${first} tool instead`);
}

function sedReason(args: readonly string[], piped: boolean, cwd: string): ShellGuardReason | "passthrough" {
	let quiet = false;
	let script: string | undefined;
	const files: string[] = [];
	for (const arg of args) {
		if (arg === "-") return "passthrough";
		if (arg.startsWith("--")) return "passthrough";
		if (arg.startsWith("-")) {
			// Only "quiet" belongs to this shape: -e/-f add scripts, -i edits in
			// place, -s treats files as one stream. Everything else passes through.
			if (!/^-[rnEsu]+$/.test(arg) || !arg.includes("n")) return "passthrough";
			quiet = true;
			continue;
		}
		if (script === undefined) script = arg;
		else files.push(arg);
	}
	// A quiet sed only prints what its script says, so a print range is the one
	// form that replaces `read`; substitutions and the rest stay out.
	if (!quiet || script === undefined || files.length === 0) return "passthrough";
	if (!SED_PRINT_SCRIPT.test(script)) return "passthrough";
	const line = /\d+/.exec(script)?.[0];
	const first = files[0] ?? "";
	const hint =
		line === undefined
			? `Use the read ${first} tool instead`
			: `Use the read ${first} tool with offset=${line} instead`;
	return filesReason("sed", files, piped, cwd, hint);
}

function grepReason(program: string, args: readonly string[], piped: boolean): ShellGuardReason | "passthrough" {
	// `… | grep foo` filters what another program printed; that is not a file search.
	if (piped) return "passthrough";
	// rg searches recursively by default; grep only when told to.
	let recursive = program === "rg";
	let pattern: string | undefined;
	for (const arg of args) {
		if (arg === "-") return "passthrough";
		// Long options either take a value this analyzer does not parse (-e, -f) or
		// filter by file name (--include, --exclude-dir): both leave the modeled shape.
		if (arg.startsWith("--")) return "passthrough";
		if (arg.startsWith("-")) {
			const flags = arg.slice(1);
			// -q is a condition, -l lists paths, -c counts, -o drops the line text,
			// -e/-f move the pattern: none of them is "show me the matching lines".
			if (/[qlcoef]/.test(flags)) return "passthrough";
			// -s/-S/--no-ignore change what rg skips; the grep tool makes that choice.
			if (program === "rg" && /[sS]/.test(flags)) return "passthrough";
			recursive = recursive || flags.includes("r") || flags.includes("R");
			continue;
		}
		if (pattern === undefined) pattern = arg;
	}
	// Non-recursive grep is a filter over the files named on the command line.
	if (!recursive || pattern === undefined) return "passthrough";
	return {
		command: `${program} ${pattern}`,
		words: [program, pattern],
		hint: `Use the grep pattern="${pattern}" tool instead`,
	};
}

/** A file read of `files`: tool-replaceable when they are real files and stdout is the model's. */
function filesReason(
	program: string,
	files: readonly string[],
	piped: boolean,
	cwd: string,
	hint: string,
): ShellGuardReason | "passthrough" {
	// Piping a file into another program feeds that program; it is not an inspection.
	if (piped) return "passthrough";
	if (!files.every((file) => isRegularFile(file, cwd))) return "passthrough";
	return { command: `${program} ${files.join(" ")}`, words: [program, ...files], hint };
}

/** Whether `file` exists and is a regular file; a glob or a device is not the read tool's business. */
function isRegularFile(file: string, cwd: string): boolean {
	if (file.includes("*") || file.includes("?") || file.includes("$") || file.includes("`")) return false;
	try {
		return statSync(resolve(cwd, file.startsWith("~/") ? `${homedir()}/${file.slice(2)}` : file)).isFile();
	} catch {
		return false;
	}
}

/**
 * `bash -c 'cat f'` → the script as its own words. Anything else (no `-c`, no
 * script after it, an unknown long flag) is left alone: the words still name
 * the shell, `classify` passes it through, and the line runs.
 */
function unwrapShellScript(words: readonly string[]): readonly string[] {
	if (!SHELLS.has(words[0] ?? "")) return words;
	let index = 1;
	for (; index < words.length; index++) {
		const arg = words[index] ?? "";
		if (arg === "-c") break;
		// `-x`/`-e`/`-l` change how the script runs; `--norc` style flags are
		// unknown shapes, and `-` alone reads stdin.
		if (arg.startsWith("--") || !/^-[a-zA-Z]+$/.test(arg)) return words;
	}
	if (index >= words.length - 1) return words;
	// The script is a command line of its own: split it the same way, so
	// `bash -c 'cat f'` is weighed as `cat f`. A script the splitter cannot
	// state (or one holding several commands, which may pipe or redirect)
	// keeps the shell as its program and passes through.
	try {
		const segments = splitSegments(words.slice(index + 1).join(" "));
		return segments.length === 1 ? (segments[0]?.words ?? words) : words;
	} catch {
		return words;
	}
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

/** One simple command: its words, and whether another command follows it in a pipeline. */
interface Segment {
	words: string[];
	piped: boolean;
}

/**
 * Split a line into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines.
 *
 * Anything this splitter cannot state as a plain list of words throws
 * `Unsupported`: multi-line input, `$()` and backticks, unterminated quotes, a
 * heredoc. `(`, `)`, `<`, `>` also pass the call to the model unchanged, because
 * a subshell or a redirection means the output is not simply going to the model.
 */
function splitSegments(command: string): Segment[] {
	const segments: Segment[] = [];
	let word = "";
	let words: string[] = [];
	let piped = false;
	let heredoc: string | undefined;
	const endWord = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	const endSegment = (pipeline: boolean) => {
		endWord();
		if (words.length > 0) segments.push({ words, piped: pipeline || piped });
		words = [];
		piped = pipeline;
	};
	for (let index = 0; index < command.length; index++) {
		const ch = command[index] ?? "";
		if (ch === "\n") {
			if (heredoc !== undefined) {
				heredoc = undefined;
				endSegment(false);
				continue;
			}
			throw new Unsupported("multi-line command");
		}
		if (heredoc !== undefined) continue;
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
			const body = command.slice(index + 1, end);
			if (body.includes("$(") || body.includes("`")) throw new Unsupported("command substitution");
			word += body;
			index = end;
			continue;
		}
		if (ch === "$" || ch === "`") throw new Unsupported("command substitution");
		if (ch === "<") {
			// `<<` / `<<-` are heredocs: the body is data, not commands.
			const marker = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(command.slice(index));
			if (marker) {
				heredoc = marker[1];
				index += marker[0].length - 1;
				endSegment(false);
				continue;
			}
			throw new Unsupported("redirection");
		}
		if (ch === ">" || ch === "(" || ch === ")") throw new Unsupported("redirection or subshell");
		if (ch === "#" && word === "") {
			const end = command.indexOf("\n", index);
			index = end === -1 ? command.length : end - 1;
			continue;
		}
		if (ch === "|") {
			// `|&` is a pipeline too; `||` is a list.
			if (command[index + 1] === "|") {
				index += 1;
				endSegment(false);
				continue;
			}
			if (command[index + 1] === "&") index += 1;
			endSegment(true);
			continue;
		}
		if (ch === ";" || ch === "&") {
			if (ch === "&" && command[index + 1] === "&") index += 1;
			endSegment(false);
			continue;
		}
		if (ch === " " || ch === "\t") {
			endWord();
			continue;
		}
		word += ch;
	}
	if (heredoc !== undefined) throw new Unsupported("unterminated heredoc");
	endSegment(false);
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

/** The one line a blocked call sees, so the next attempt goes through the tool. */
export function shellGuardNotice(hit: ShellGuardReason): string {
	return `Blocked by the shell guard: \`${hit.command}\` inspects files through the shell. ${hit.hint}; it also handles gitignore, truncation, and stable line numbers. Shell commands are for running programs.`;
}
