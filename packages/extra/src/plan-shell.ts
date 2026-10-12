/**
 * Shell command structure analysis for plan mode.
 *
 * Plan mode allows only `ls`, `find`, and `pwd` as a single simple command.
 * Anything compound is rejected by parsing, not by substring matching: the
 * tokenizer tracks quoting so operators inside quotes stay literal, while
 * command substitution (`$(`, backticks) is rejected even inside double quotes
 * because the shell executes it there too.
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

const PLAN_COMMANDS = new Set(["ls", "find", "pwd"]);

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
 * Plan-mode check: the command must be a single simple invocation of ls, find,
 * or pwd. find(1) writing predicates (-delete, -exec, ...) are rejected too.
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
			reason: `plan mode allows only the read tool and the ls, find, and pwd commands (got "${firstCommand}")`,
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
	return { allowed: true, firstCommand };
}
