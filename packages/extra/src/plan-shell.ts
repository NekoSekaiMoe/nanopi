/**
 * Shell command structure analysis for plan mode.
 *
 * Plan mode may run the read-only commands in `PLAN_COMMANDS`, and `git` in the
 * forms that only print (`PLAN_GIT_SUBCOMMANDS`). Anything compound is rejected
 * by parsing, not by substring matching: the tokenizer tracks quoting so
 * operators inside quotes stay literal, while command substitution (`$( `,
 * backticks) is rejected even inside double quotes because the shell executes it
 * there too.
 *
 * The list is the read half of `PLAN_ALLOWED_SHELL` in `extension.ts`, which
 * also offers `compile` separately: a build is the one allowed command that
 * writes files, so it is a named tool call the model makes on purpose rather
 * than something it can reach with a plausible-looking shell line.
 */

export interface PlanCommandAnalysis {
	allowed: boolean;
	reason?: string;
	/** First word of the command (the program name), when the input is a single simple command. */
	firstCommand?: string;
}

type Token = { kind: "word"; text: string } | { kind: "operator"; text: string };

/** Characters that end a word and are shell operators when unquoted. */
const OPERATOR_STARTS = new Set([";", "&", "|", "(", ")", "<", ">"]);

const PLAN_COMMANDS = new Set([
	"ls",
	"find",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"rg",
	"tree",
	"file",
	"stat",
	"du",
	"diff",
	"echo",
	"git",
	"gh",
]);

/**
 * `git` subcommands that print instead of writing: the worktree stays as it was.
 *
 * `git branch` is absent on purpose — without `-l`/`--list` it creates the
 * branch named by its argument, and one allowlist entry that sometimes writes
 * is worse than losing a listing command the model can spell as `git branch -a`
 * only by accident.
 */
const PLAN_GIT_SUBCOMMANDS = new Set([
	"log",
	"show",
	"diff",
	"status",
	"blame",
	"describe",
	"shortlog",
	"grep",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"rev-list",
	"cat-file",
	"name-rev",
	"merge-base",
	"count-objects",
	"for-each-ref",
]);

/** Global `git` options that consume the word after them, so the subcommand is two words later. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** `gh` subcommands that only read this repository's issues, PRs, and runs. */
const PLAN_GH_COMMANDS = new Set(["pr", "issue", "run", "repo", "release", "search", "api"]);

/**
 * Verbs of the `gh` subcommands above that read.
 *
 * The flag check alone was not enough: `gh pr create` carries no write flag, so
 * a group name plus flags let every write through (`create`, `comment`, `merge`,
 * `close`). The verb is the thing that decides, so it is checked by name and a
 * subcommand with no verb here (`gh repo clone`, which writes a directory) is
 * refused.
 */
const PLAN_GH_READ_VERBS = new Set(["view", "list", "ls", "status", "diff", "checks", "download", "log"]);

/** `gh` groups whose reading verb carries its own name (`gh run view`, `gh api`). */
const PLAN_GH_GROUPS_WITH_VERB = new Set(["pr", "issue", "run", "repo", "release"]);

/**
 * `gh` flags that turn a read into a write. `gh api` is a read only with a GET
 * method, and several subcommands accept `--method`, so the check is on the flag
 * rather than on the subcommand.
 */
const GH_WRITE_FLAGS = new Set([
	"-X",
	"--method",
	"-f",
	"-F",
	"--field",
	"--raw-field",
	"--input",
	"--web",
	"--edit",
	"--delete",
	"--add",
	"--remove",
	"--set",
	"-R",
]);

/** HTTP verbs `gh api` may use; anything but GET writes. */
const READ_HTTP_METHODS = new Set(["GET", "get"]);

/** find(1) predicates that write or execute; plan mode is read-only. */
const FIND_WRITE_PREDICATES = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

class Scanner {
	private index = 0;
	private readonly input: string;

	constructor(input: string) {
		this.input = input;
	}

	private peek(offset = 0): string | undefined {
		return this.input[this.index + offset];
	}

	private advance(): string {
		return this.input[this.index++];
	}

	private atEnd(): boolean {
		return this.index >= this.input.length;
	}

	/** Scan one token; throws ParseError on unterminated quotes or rejected constructs. */
	next(): Token | undefined {
		this.skipWhitespace();
		if (this.atEnd()) return undefined;
		const ch = this.peek();
		if (ch === undefined) return undefined;
		if (ch === "#") {
			// Comment: unquoted # at word start runs to end of line.
			while (!this.atEnd() && this.peek() !== "\n") this.advance();
			return this.next();
		}
		if (OPERATOR_STARTS.has(ch)) {
			const op = this.scanOperator();
			return { kind: "operator", text: op };
		}
		return { kind: "word", text: this.scanWord() };
	}

	private skipWhitespace(): void {
		while (!this.atEnd()) {
			const ch = this.peek();
			if (ch === " " || ch === "\t" || ch === "\r") {
				this.advance();
				continue;
			}
			if (ch === "\n") {
				throw new ParseError("multi-line commands are not allowed in plan mode");
			}
			break;
		}
	}

	private scanOperator(): string {
		const start = this.index;
		const first = this.advance();
		if (first === "(" || first === ")") return first;
		// && || ;; << >> <& >&
		const second = this.peek();
		if ((first === "&" || first === "|" || first === ";" || first === "<" || first === ">") && second === first) {
			this.advance();
		} else if ((first === "<" || first === ">") && (second === "&" || second === ">" || second === "<")) {
			this.advance();
			const third = this.peek();
			if (second !== "&" && (third === ">" || third === "<")) this.advance();
		} else if (first === ">" && second === "|") {
			this.advance();
		}
		return this.input.slice(start, this.index);
	}

	private scanWord(): string {
		let text = "";
		while (!this.atEnd()) {
			const ch = this.peek();
			if (ch === undefined) break;
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "#") break;
			if (OPERATOR_STARTS.has(ch)) break;
			if (ch === "'") {
				this.advance();
				while (true) {
					if (this.atEnd()) throw new ParseError("unterminated single quote");
					const c = this.advance();
					if (c === "'") break;
					text += c;
				}
				continue;
			}
			if (ch === '"') {
				this.advance();
				while (true) {
					if (this.atEnd()) throw new ParseError("unterminated double quote");
					const c = this.advance();
					if (c === '"') break;
					if (c === "\\") {
						if (this.atEnd()) throw new ParseError("unterminated escape in double quotes");
						text += this.advance();
						continue;
					}
					if (c === "$" && this.peek() === "(") {
						throw new ParseError("command substitution ($(...)) is not allowed in plan mode");
					}
					if (c === "`") {
						throw new ParseError("command substitution (backticks) is not allowed in plan mode");
					}
					text += c;
				}
				continue;
			}
			if (ch === "\\") {
				this.advance();
				if (this.atEnd()) throw new ParseError("trailing backslash");
				text += this.advance();
				continue;
			}
			if (ch === "$") {
				this.advance();
				if (this.peek() === "(") {
					throw new ParseError("command substitution ($(...)) is not allowed in plan mode");
				}
				if (this.peek() === "{") {
					// ${...} parameter expansion: safe, copy verbatim.
					text += ch;
					text += this.advance();
					let depth = 1;
					while (depth > 0 && !this.atEnd()) {
						const c = this.advance();
						if (c === "}") depth--;
						text += c;
					}
					if (depth > 0) throw new ParseError("unterminated parameter expansion");
					continue;
				}
				text += ch;
				continue;
			}
			if (ch === "`") {
				throw new ParseError("command substitution (backticks) is not allowed in plan mode");
			}
			text += this.advance();
		}
		if (text === "") throw new ParseError("empty shell token");
		return text;
	}
}

/**
 * Whether a `gh` call only reads: a known subcommand, no write flag, and a GET
 * method when `--method`/`-X` does appear (the flag itself is not a write then).
 */
function ghIsReadOnly(words: string[]): { ok: boolean; reason?: string } {
	const sub = words[1];
	if (sub === undefined) {
		return {
			ok: false,
			reason: "plan mode allows gh only with a subcommand (pr view, issue view, run view, search, api GET)",
		};
	}
	if (!PLAN_GH_COMMANDS.has(sub)) {
		return { ok: false, reason: `plan mode allows only the reading gh subcommands; got "gh ${sub}"` };
	}
	if (PLAN_GH_GROUPS_WITH_VERB.has(sub)) {
		const verb = words[2];
		if (verb === undefined || !PLAN_GH_READ_VERBS.has(verb)) {
			return {
				ok: false,
				reason: `plan mode is read-only; "gh ${sub} ${verb ?? ""}" is not a reading verb (view, list, diff, status, checks, download)`,
			};
		}
	} else if (sub === "search") {
		// `gh search` needs a target too, and every target reads.
		if (words[2] === undefined) {
			return { ok: false, reason: "plan mode allows gh search only with a target (code, repos, issues, prs)" };
		}
	}
	for (let index = 2; index < words.length; index++) {
		const word = words[index];
		const equals = word.indexOf("=");
		const flag = equals > 0 ? word.slice(0, equals) : word;
		if (!GH_WRITE_FLAGS.has(flag)) continue;
		if (flag === "-X" || flag === "--method") {
			const value = equals > 0 ? word.slice(equals + 1) : words[index + 1];
			if (value === undefined || !READ_HTTP_METHODS.has(value)) {
				return {
					ok: false,
					reason: `plan mode is read-only; gh ${flag} ${value ?? ""} sends a request that can write`,
				};
			}
			continue;
		}
		return { ok: false, reason: `plan mode is read-only; gh ${flag} writes` };
	}
	return { ok: true };
}

export class ParseError extends Error {}

function describeOperator(op: string): string {
	switch (true) {
		case op === "|":
			return "pipes";
		case op === ";" || op === ";;":
			return "command separators (;)";
		case op === "&&" || op === "||":
			return `command lists (${op})`;
		case op === "&" || op === "&|":
			return "background execution (&)";
		case op === "(" || op === ")":
			return "subshells";
		default:
			return `redirections (${op})`;
	}
}

/** Tokenize into words; returns undefined when the input is not one simple command. */
export function tokenizeSimpleCommand(input: string): { words: string[] } | { error: string } {
	const scanner = new Scanner(input);
	const words: string[] = [];
	while (true) {
		let token: Token | undefined;
		try {
			token = scanner.next();
		} catch (error) {
			if (error instanceof ParseError) return { error: error.message };
			throw error;
		}
		if (token === undefined) break;
		if (token.kind === "operator") {
			return { error: `plan mode forbids ${describeOperator(token.text)}` };
		}
		words.push(token.text);
	}
	return { words };
}

/** First word (program name) of a command, or undefined when the input is empty/unparsable. */
export function firstShellWord(input: string): string | undefined {
	const result = tokenizeSimpleCommand(input);
	return "words" in result ? result.words[0] : undefined;
}

/**
 * Position of `git`'s subcommand: global options that consume a value shift it
 * right, so `git -C lib log` is read as `git log`.
 */
function gitSubcommandIndex(words: string[]): number {
	let index = 1;
	while (index < words.length) {
		const word = words[index];
		if (!word.startsWith("-")) break;
		if (GIT_OPTIONS_WITH_VALUE.has(word)) index += 2;
		else index += 1;
	}
	return index;
}

/**
 * Plan-mode check: one simple invocation of a read-only command. `find`'s and
 * `git`'s writing forms are rejected, and `git`/`gh` are checked down to the
 * subcommand because the program name alone says nothing about what they do.
 */
export function analyzeCommandForPlan(input: string): PlanCommandAnalysis {
	const result = tokenizeSimpleCommand(input);
	if ("error" in result) {
		return { allowed: false, reason: result.error, firstCommand: undefined };
	}
	const words = result.words;
	if (words.length === 0) {
		return { allowed: false, reason: "empty command" };
	}
	const firstCommand = words[0];
	if (!PLAN_COMMANDS.has(firstCommand)) {
		return {
			allowed: false,
			firstCommand,
			reason: `plan mode allows only read-only commands (read, grep, find, ls, and the PLAN_ALLOWED_SHELL list); got "${firstCommand}"`,
		};
	}
	if (firstCommand === "find") {
		const predicate = words.find((word) => FIND_WRITE_PREDICATES.has(word));
		if (predicate !== undefined) {
			return {
				allowed: false,
				firstCommand,
				reason: `plan mode is read-only; find predicate ${predicate} writes or executes`,
			};
		}
	}
	if (firstCommand === "git") {
		const index = gitSubcommandIndex(words);
		const sub = words[index];
		if (sub === undefined || !PLAN_GIT_SUBCOMMANDS.has(sub)) {
			return {
				allowed: false,
				firstCommand,
				reason: `plan mode is read-only; "git ${sub ?? ""}" is not one of the reading subcommands (log, show, diff, status, blame, rev-parse, ...)`,
			};
		}
	}
	if (firstCommand === "gh") {
		const gh = ghIsReadOnly(words);
		if (!gh.ok) return { allowed: false, firstCommand, reason: gh.reason };
	}
	return { allowed: true, firstCommand };
}
