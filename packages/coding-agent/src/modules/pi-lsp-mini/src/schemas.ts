import { Type } from "typebox";

/** Shared, token-lean parameter schemas + tool texts (measured: see README). */

/** Exact position, or a `symbol` name the server is asked to locate first. */
const AT = {
  path: Type.String(),
  line: Type.Optional(Type.Number({ description: "1-based line" })),
  character: Type.Optional(Type.Number({ description: "1-based column" })),
  symbol: Type.Optional(Type.String({ description: "symbol name, used when line/character are omitted" })),
};

const POSITION = {
  path: Type.String(),
  line: Type.Number({ description: "1-based line" }),
  character: Type.Number({ description: "1-based column" }),
};

/**
 * Shared guidance for the lsp_ tool group, carried by the first declaration.
 * The tools are registered by an extra that can disappear at runtime (subsystem
 * switch), which is why the hint lives on the tool and not in the system prompt.
 *
 * The wording names `read` first on purpose. An earlier version only said "try
 * LSP before grepping", and the model still opened whole files to answer what a
 * signature was: grep was never the tool it was reaching for, `read` was. The
 * competing rule it had was "use read to examine files", so this one has to be
 * about files, not about grep.
 *
 * `buildRules` dedups identical bullets, so the rendered <rules> carries it
 * once. The per-tool lists are read elsewhere too (`getAllTools()`, the docs),
 * where five copies measured 1520 of the 1959 characters this module
 * contributes: `index.ts` attaches `DIAGNOSTICS.promptGuidelines` — the only
 * list that carries the shared sentence — and gives the other four their own.
 */
export const LSP_GUIDANCE =
  "Before opening a file to answer what a symbol is or where it comes from, use the lsp_ tool for that question: hover for a signature or doc, definition for where it is declared, query for usages or callers, diagnostics for errors. The server already resolved imports and types, so these questions do not need a read.";

/** Per-call deadline override; a cold server on a large repo outlives the default. */
const TIMEOUT = Type.Optional(Type.Number({ description: "request timeout in ms (default from lsp.json)" }));

export const DIAGNOSTICS = {
  description: "LSP errors/warnings for a file or directory. Omit path to scan cwd.",
  promptSnippet: "Check code errors via LSP",
  promptGuidelines: [
    LSP_GUIDANCE,
    "After an edit, diagnostics reports what the compiler says without a build; a directory path covers the tree in one call.",
  ],
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "file or dir (default .)" })),
    severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("information")], { description: "min severity (default warning)" })),
    timeoutMs: TIMEOUT,
  }),
};

export const HOVER = {
  description: "Type signature and doc comment of the symbol at a 1-based position, or of a named `symbol`.",
  promptSnippet: "What a symbol's signature/doc is, by name or position",
  promptGuidelines: ["Pass `symbol` when you know the name but not the position."],
  parameters: Type.Object({ ...AT, timeoutMs: TIMEOUT }),
};

export const DEFINITION = {
  description: "Where the symbol at a 1-based position, or a named `symbol`, is declared (file:line).",
  promptSnippet: "Where a symbol is declared, by name or position",
  promptGuidelines: [
    "A same-named symbol in another file is not a false positive here; grep returns all of them.",
  ],
  parameters: Type.Object({ ...AT, timeoutMs: TIMEOUT }),
};

/** One read-only query, two granularities: who uses the symbol, and who calls the function. */
export const QUERY = {
  description: "Usages or call relations of the symbol at a 1-based line/column.",
  promptSnippet: "Find usages of a symbol, or trace callers/callees of a function",
  promptGuidelines: [
    "Before a rename, signature change, or delete, query separates real usages from matches in strings and comments.",
  ],
  parameters: Type.Object({
    ...POSITION,
    kind: Type.Optional(Type.Union([Type.Literal("references"), Type.Literal("callgraph")], { description: "default references" })),
    direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")], { description: "callgraph only; default both" })),
    depth: Type.Optional(Type.Number({ description: "callgraph only, 1-4, default 2" })),
    timeoutMs: TIMEOUT,
  }),
};

export const EDIT = {
  description: "Rename or delete a symbol across the workspace, scope-aware; dry-run unless apply=true.",
  promptSnippet: "Rename/delete a symbol workspace-wide (dry-run first)",
  promptGuidelines: [],
  parameters: Type.Object({
    ...POSITION,
    kind: Type.Union([Type.Literal("rename"), Type.Literal("delete")], { description: "rename needs newName" }),
    newName: Type.Optional(Type.String({ description: "target name for kind=rename" })),
    apply: Type.Optional(Type.Boolean({ description: "default false: preview only" })),
    timeoutMs: TIMEOUT,
  }),
};
