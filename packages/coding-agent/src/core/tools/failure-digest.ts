/**
 * Failure digest: the few lines of a failing run worth reading, appended after it.
 *
 * A failing `pnpm test` or `tsc` prints hundreds of lines, and every framework has
 * its own idea of where the failure is: `FAIL src/a.test.ts > adds numbers`, flattened
 * vitest JSON, `error TS2322: Type ...` behind an ANSI prefix, `ninja`'s `FAILED: <output path>`.
 * The model already receives all of it; what it spends tokens on is finding the ten
 * lines that matter. So the digest does not restructure anything: it copies the
 * matching lines verbatim, in output order, and says how many lines it left out.
 *
 * Rules run only on a non-zero exit code, because the digest is where the failure is,
 * not the head of a passing log. They are heuristics over human output, matched on the
 * stripped text and reported from the original line, so ANSI escapes, box drawing, and
 * indentation stay exactly as the tool wrote them.
 */

import { stripAnsi } from "../../utils/ansi.ts";
import { truncateTail } from "./truncate.ts";

/**
 * One line of a failing run, kept because it names a failure. Declared as a type alias
 * because `structuredContent` takes JSON values, which need an index signature.
 */
export type FailureLine = {
	/** 1-based line number in the full output. */
	line: number;
	/** The line as the command wrote it, without a trailing `\r`. */
	text: string;
	/** Framework or compiler that produced the line, e.g. `vitest` or `tsc`. */
	source: string;
};

export interface FailureDigest {
	failures: FailureLine[];
	/** Total lines in the output the digest was built from. */
	totalLines: number;
	/** Matches the formatted digest did not fit, so a caller knows the list is not exhaustive. */
	omitted: number;
}

/** One regex over one line of output. */
interface DigestRule {
	/** Framework or compiler that produced the line; reported with the match. */
	source: string;
	pattern: RegExp;
	/**
	 * The scan context this rule belongs to. Once a group is open, only its rules claim lines, so a
	 * test framework keeps reporting its own failures instead of mixing in another tool's output.
	 */
	group?: "vitest" | "jest" | "pytest" | "go" | "cargo" | "ninja" | "configure" | "make" | "compiler" | "ctest";
	/** The line is the failure worth reading; later ones are noise. */
	breaks?: boolean;
	/** A summary or count, dropped whenever a stronger line in the same group matched. */
	weak?: boolean;
}

const RULES: readonly DigestRule[] = [
	// A passing case line names no failure; it only shows the scan the format in use.
	{ source: "isolation", pattern: /^\s*(?:✓|×|❯)\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\b/ },
	// Compilers first: their section is the one that keeps printing after the error line, and the
	// test frameworks below must not be mistaken for it (`FAIL x > y` has no colon).
	//
	// tsc in each of its shapes: `src/a.ts(1,5): error TS2322: ...`, the pretty
	// `src/a.ts:1:5 - error TS2322: ...` whose escapes are stripped before matching, and the
	// `--pretty false` form the plain rule below would otherwise claim
	{ source: "tsc", pattern: /(?:^|[\s:])(?:error|warning)\s+TS\d+:/, group: "compiler" },
	// any other `file:line[:col]: error:` (gcc, clang, go vet)
	{ source: "compiler", pattern: /^\S[^:]*(?::\d+){1,2}:\s+(?:fatal\s+)?(?:error|warning)\b/, group: "compiler" },
	// gcc/clang context for the line above
	{ source: "compiler", pattern: /^\s+(?:note|in function|in file included from):/, group: "compiler" },
	// vitest `FAIL src/a.test.ts > suite > case`; every per-test line repeats the file
	{ source: "vitest", pattern: /^\s*FAIL\s+\S.* > /, group: "vitest" },
	// vitest `❯ file.test.ts (2 tests | 1 failed)` and jest's `Test Suites: 1 failed`: a count that
	// names no case, kept only when nothing better follows
	{ source: "vitest", pattern: /\b\d+\s+tests?\s*\|\s*\d+\s+(?:failed|skipped)/, group: "vitest", weak: true },
	{ source: "jest", pattern: /^\s*Test Suites:\s+\d+\s+failed/, group: "jest", weak: true },
	// vitest `AssertionError: expected 3 to be 4`: the message the `FAIL` line points at, which
	// names no file. Only the assertion kind starts a line; a bare `Error:` would also swallow
	// `ERROR: ...` from other tools.
	{ source: "assertion", pattern: /^\s*AssertionError:\s/ },
	// jest `FAIL src/a.test.ts (12 tests | 1 failed)`, or a bare `FAIL src/a.test.ts`
	{ source: "jest", pattern: /^\s*FAIL\s+\S/, group: "jest" },
	// jest `● suite › case`, and `● Cannot log after tests are done`
	{ source: "jest", pattern: /^\s*●\s+\S/, group: "jest" },
	// TAP `not ok 3 - case` (node:test, prove, pytest-tap)
	{ source: "tap", pattern: /^\s*not ok\b/ },
	// pytest `FAILED tests/test_a.py::test_b - assert 1 == 2`
	{ source: "pytest", pattern: /^\s*FAILED\s+\S+/, group: "pytest" },
	// go test `--- FAIL: TestX (0.00s)`
	{ source: "go", pattern: /^\s*--- FAIL: /, group: "go" },
	// cargo `test foo::bar ... FAILED`
	{ source: "cargo", pattern: /^\s*test\s+\S+\s+\.\.\.\s+FAILED/, group: "cargo" },
	// meson `1/3 project:name FAIL 0.02s exit status 1`
	{ source: "meson", pattern: /^\s*\d+\/\d+\s+\S+\s+FAIL\b/ },
	// ctest `The following tests FAILED:` and then `  3 - name (Failed)`
	{ source: "ctest", pattern: /^\s*The following tests FAILED:/, group: "ctest" },
	{ source: "ctest", pattern: /^\s*\d+\s+-\s+\S.*\(Failed\)/, group: "ctest" },
	// ninja `FAILED: CMakeFiles/a.dir/src/a.cpp.o`; the output path maps back to the source file
	{ source: "ninja", pattern: /^\s*FAILED:\s+\S/, group: "ninja", breaks: true },
	// make `Makefile:12: recipe for target 'x' failed` and its `*** [x] Error 1` summary
	{
		source: "make",
		pattern: /^\s*[^:\s]+:\d+:\s+.*\bfailed\b|^\s*\*\*\*\s+\[.*\]\s+Error\s+\d+/,
		group: "make",
	},
	// autotools `configure: error: ...`; the `checking ... no` lines are matched as a run below
	{ source: "configure", pattern: /^\s*configure:\s+error:/, group: "configure", breaks: true },
];

const CONFIGURE_CHECKING = /^\s*checking\s+.*\.\.\.\s+(?:no|none required)\s*$/;

/** A run of `checking ... no` lines up to this length is the normal probing of a configure run. */
const MAX_CONFIGURE_PROBES = 3;

export interface FailureDigestOptions {
	/** Maximum characters per kept line before the middle is cut. Default: 240 */
	maxLineLength?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 240;
/** `1:2`, `1:2:3`, `path (line,col)`, and `- 3 - name` stay; the prose between them does not. */
const LOCATION = /(?::\d+){1,2}:|\(\d+,\d+\):/;

function shortenLine(text: string, maxLineLength: number): string {
	if (text.length <= maxLineLength) return text;
	const head = Math.floor(maxLineLength / 2);
	return `${text.slice(0, head)}…${text.slice(text.length - (maxLineLength - head))}`;
}

/**
 * Keep the location and both ends of a long line: a test that diffs two large objects
 * otherwise spends the whole budget on one line, and the interesting part is rarely the middle.
 */
function clipLine(text: string, maxLineLength: number): string {
	if (text.length <= maxLineLength) return text;
	const location = LOCATION.exec(text);
	if (!location) return shortenLine(text, maxLineLength);
	const headEnd = Math.min(text.length, location.index + location[0].length + Math.floor(maxLineLength / 3));
	const head = text.slice(0, headEnd);
	const tailLength = maxLineLength - head.length - 1;
	return tailLength <= 0 ? `${head}…` : `${head}…${text.slice(text.length - tailLength)}`;
}

/**
 * The first rule that claims one line: a rule naming the open group wins over a free-standing one,
 * so `FAIL x.test.ts > case` is never read as a plain compiler error.
 */
function claimLine(plain: string, group: DigestRule["group"]): DigestRule | undefined {
	let free: DigestRule | undefined;
	for (const rule of RULES) {
		if (group !== undefined && rule.group !== undefined && rule.group !== group) continue;
		if (!rule.pattern.test(plain)) continue;
		if (rule.group !== undefined) return rule;
		free ??= rule;
	}
	return free;
}

/**
 * Build a digest from the complete output of a failed command.
 *
 * `output` must be the full text, not a truncation of it: line numbers and the omitted
 * count are only meaningful against the whole run.
 */
export function digestFailures(output: string, options: FailureDigestOptions = {}): FailureDigest | undefined {
	const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
	const lines = output.split("\n");
	const matched: FailureLine[] = [];
	/**
	 * The group the scan is reading, if any. It decides which lines are still worth reporting: once a
	 * test summary names failing cases, the compiler errors above it are what the build step printed,
	 * not what failed. A line that matches nothing ends the group, so another tool can take over.
	 */
	let group: DigestRule["group"] | undefined;
	/** A `weak` match is a count, kept only while nothing better in its group shows up. */
	let weakIndex: number | undefined;

	for (let index = 0; index < lines.length; index++) {
		const raw = (lines[index] ?? "").replace(/\r$/, "");
		if (!raw.trim()) continue;
		const plain = stripAnsi(raw);

		// Rules of the open group are tried first, and a line it claims is the line it explains. Only
		// when the group has nothing to say does the whole table get a chance to take the scan over.
		let claimed = claimLine(plain, group);
		if (claimed === undefined && group !== undefined) claimed = claimLine(plain, undefined);

		if (claimed === undefined && CONFIGURE_CHECKING.test(plain)) {
			// Report the whole probe run once it ends: one `checking for X... no` is normal.
			let end = index;
			while (end + 1 < lines.length && CONFIGURE_CHECKING.test(stripAnsi(lines[end + 1] ?? ""))) end++;
			if (end - index + 1 > MAX_CONFIGURE_PROBES) {
				for (let probe = index; probe <= end; probe++) {
					matched.push({
						line: probe + 1,
						text: clipLine((lines[probe] ?? "").replace(/\r$/, "").trimEnd(), maxLineLength),
						source: "configure",
					});
				}
			}
			index = end;
			continue;
		}

		if (claimed === undefined) {
			if (group !== undefined) group = undefined;
			continue;
		}

		// A test framework naming its failures supersedes the compiled output that fed it.
		if (group === "compiler" && claimed.group !== undefined && claimed.group !== "compiler") {
			while (matched.at(-1)?.source === "compiler" || matched.at(-1)?.source === "tsc") matched.pop();
		}
		group = claimed.group;

		if (claimed.source !== "isolation") {
			const text = clipLine(raw.trimEnd(), maxLineLength);
			if (claimed.weak === true) {
				matched.push({ line: index + 1, text, source: claimed.source });
				weakIndex = matched.length - 1;
			} else {
				if (weakIndex !== undefined) {
					// The summary only stood in for a case line that never came.
					matched.splice(weakIndex, 1);
					weakIndex = undefined;
				}
				matched.push({ line: index + 1, text, source: claimed.source });
			}
		}
		if (claimed.breaks === true) break;
	}

	if (matched.length === 0) return undefined;
	return { failures: matched, totalLines: lines.length, omitted: 0 };
}

/**
 * The model-facing digest block.
 *
 * `maxLines` and `maxBytes` are the room left in the result after the output head was dropped, and the block is trimmed to fit here rather than by the caller: only
 * the tail of a result survives truncation, so a digest that overflows would vanish
 * together with the failures it was written to point at.
 */
export function formatFailureDigest(
	digest: FailureDigest,
	limits: { maxLines: number; maxBytes: number },
): { text: string; digest: FailureDigest } | undefined {
	const row = (failure: FailureLine) =>
		`${String(failure.line).padStart(String(digest.totalLines).length)} | ${failure.text}`;
	const kept = digest.failures;
	const rowsPerSide = Math.max(1, Math.floor((limits.maxLines - 1) / 2));
	const head = kept.slice(0, kept.length > limits.maxLines ? rowsPerSide : kept.length);
	const tail = kept.slice(Math.max(head.length, kept.length - rowsPerSide));

	const lines = ["[failures]", ...head.map(row)];
	if (tail.length > 0 && (tail[0]?.line ?? 0) > (head.at(-1)?.line ?? 0) + 1) lines.push("…");
	lines.push(...tail.map(row));
	const last = tail.at(-1) ?? head.at(-1);
	if (last && last.line < digest.totalLines) lines.push(`(${digest.totalLines} lines of output; other lines omitted)`);

	const { content } = truncateTail(lines.join("\n"), limits);
	if (!content.trim()) return undefined;
	return {
		text: content,
		digest: {
			failures: [...head, ...tail],
			totalLines: digest.totalLines,
			omitted: kept.length - head.length - tail.length,
		},
	};
}
