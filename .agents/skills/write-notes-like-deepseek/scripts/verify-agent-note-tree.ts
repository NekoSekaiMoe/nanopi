/**
 * Verify tree: lifecycle/class/filename/INDEX, internal relative markdown links,
 * and bare `test/...test.ts` paths in prose.
 * Run: npx tsx <skill-dir>/scripts/verify-agent-note-tree.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { agentNoteRoot, walkAgentNoteTree } from "./agent-note-tree.ts";

const { notes, errors } = walkAgentNoteTree();

// Check relative markdown links inside active notes
const LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

// Bare test path: `test/x.test.ts` not already behind `packages/<pkg>/`.
// A leading [\w./-] means it is part of a longer path, so leave it alone.
const BARE_TEST_PATH = /(?<![\w./-])test\/[A-Za-z0-9_./-]+\.test\.ts/g;
// Command context: the paragraph runs tests or cd's into a package, so the
// package is given by the command rather than by the path. Deliberately narrow:
// a paragraph that merely mentions `pnpm run build` next to a test filename is
// still prose about that file, and prose needs the prefix.
const COMMAND_LINE =
  /\b(?:pnpm|npm|npx|yarn)\s+(?:exec\s+|run\s+)?(?:vitest|tsx|tsc|test)\b|\bvitest\b|\bcd\s+packages\/|--filter\s+@?[\w/-]+/;

const repoRoot = resolve(agentNoteRoot, "..", "..");

/** Map `x/y.test.ts` -> packages owning `packages/<pkg>/test/x/y.test.ts`. */
function buildTestPathIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const packagesDir = resolve(repoRoot, "packages");
  if (!existsSync(packagesDir)) return index;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const testDir = resolve(packagesDir, entry.name, "test");
    if (!existsSync(testDir)) continue;
    for (const rel of listTs(resolve(testDir), "")) {
      const owners = index.get(rel) ?? [];
      owners.push(entry.name);
      index.set(rel, owners);
    }
  }
  return index;
}

function listTs(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTs(resolve(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

const testPathIndex = buildTestPathIndex();

/** Suggest `packages/<pkg>/test/<rel>` when exactly one package owns it. */
function suggestTestPath(rel: string): string | undefined {
  const owners = testPathIndex.get(rel) ?? [];
  return owners.length === 1 ? `packages/${owners[0]}/test/${rel}` : undefined;
}

/**
 * Flags for lines whose bare test paths are exempt:
 * fences (commands and output), and paragraphs that name a command or a cd into
 * a package — a command example given by its package has no need for the prefix.
 * Paragraph-scoped because a long `pnpm exec vitest --run a b c` wraps.
 */
function exemptLineFlags(content: string): boolean[] {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const exempt = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}```/.test(lines[i] ?? "")) {
      exempt[i] = true;
      inFence = !inFence;
      continue;
    }
    if (inFence) exempt[i] = true;
  }
  for (let i = 0; i < lines.length; i++) {
    if (exempt[i] || (lines[i] ?? "").trim() === "") continue;
    let end = i;
    while (end + 1 < lines.length && !exempt[end + 1] && (lines[end + 1] ?? "").trim() !== "") end++;
    const block = lines.slice(i, end + 1).join("\n");
    if (COMMAND_LINE.test(block)) for (let j = i; j <= end; j++) exempt[j] = true;
    i = end;
  }
  return exempt;
}

for (const note of notes) {
  const noteFullPath = resolve(agentNoteRoot, note.rel);
  const content = readFileSync(noteFullPath, "utf8");
  let match: RegExpExecArray | null;

  while ((match = LINK_REGEX.exec(content)) !== null) {
    const rawTarget = match[2]?.trim();
    if (!rawTarget) continue;

    // Ignore web links, intra-page anchors and ellipsis placeholders
    if (rawTarget.startsWith("http://") || rawTarget.startsWith("https://") || rawTarget.startsWith("#") || rawTarget.startsWith("mailto:") || rawTarget.includes("…")) {
      continue;
    }

    // Strip anchor fragment if present
    const fileTarget = rawTarget.split("#")[0];
    if (!fileTarget) continue;

    const resolvedTarget = resolve(dirname(noteFullPath), fileTarget);

    // Only verify internal links within agentNoteRoot (boundary-aware: a
    // sibling like .agents/notes-backup/ must not prefix-match)
    if (!resolvedTarget.startsWith(agentNoteRoot + sep)) {
      continue;
    }

    if (!existsSync(resolvedTarget)) {
      errors.push(`link: ${note.rel} -> "${rawTarget}" target file does not exist`);
    }
  }

  // Bare test paths make the owning package a guess: 102 of the 104 bare paths
  // resolved uniquely only because no second package happened to have the same
  // filename. Notes are read from the repository root, so spell the package out.
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const exempt = exemptLineFlags(content);
  for (let i = 0; i < lines.length; i++) {
    if (exempt[i]) continue;
    const line = lines[i] ?? "";
    for (const bare of line.match(BARE_TEST_PATH) ?? []) {
      const rel = bare.slice("test/".length);
      const suggested = suggestTestPath(rel);
      errors.push(
        `test-path: ${note.rel}:${i + 1} — bare "${bare}" in prose; write ${suggested ?? `packages/<pkg>/${bare}`}` +
          " (or leave it bare only inside a command that cd's into the package)",
      );
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`ok: ${notes.length} note(s) tree, relative links and test paths verified`);
