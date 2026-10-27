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

/** Per-call deadline override; a cold server on a large repo outlives the default. */
const TIMEOUT = Type.Optional(Type.Number({ description: "request timeout in ms (default from lsp.json)" }));

export const DIAGNOSTICS = {
  description: "LSP errors/warnings for a file or directory. Omit path to scan cwd.",
  promptSnippet: "Check code errors via LSP",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "file or dir (default .)" })),
    severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("information")], { description: "min severity (default warning)" })),
    timeoutMs: TIMEOUT,
  }),
};

export const HOVER = {
  description: "Type signature and doc comment of the symbol at a position.",
  promptSnippet: "Read a symbol's signature/doc, without reading the file",
  parameters: Type.Object({ ...AT, timeoutMs: TIMEOUT }),
};

export const DEFINITION = {
  description: "Where the symbol at a position is defined (file:line).",
  promptSnippet: "Jump to a symbol's definition, without grepping for it",
  parameters: Type.Object({ ...AT, timeoutMs: TIMEOUT }),
};

/** One read-only query, two granularities: who uses the symbol, and who calls the function. */
export const QUERY = {
  description: "Usages or call relations of the symbol at a 1-based line/column.",
  promptSnippet: "Find usages of a symbol, or trace callers/callees of a function",
  parameters: Type.Object({
    ...POSITION,
    kind: Type.Optional(Type.Union([Type.Literal("references"), Type.Literal("callgraph")], { description: "default references" })),
    direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")], { description: "callgraph only; default both" })),
    depth: Type.Optional(Type.Number({ description: "callgraph only, 1-4, default 2" })),
    timeoutMs: TIMEOUT,
  }),
};

export const EDIT = {
  description: "Rename or delete a symbol across the workspace. scope-aware; dry-run unless apply=true.",
  promptSnippet: "Rename/delete a symbol workspace-wide (dry-run first)",
  parameters: Type.Object({
    ...POSITION,
    kind: Type.Union([Type.Literal("rename"), Type.Literal("delete")], { description: "rename needs newName" }),
    newName: Type.Optional(Type.String({ description: "target name for kind=rename" })),
    apply: Type.Optional(Type.Boolean({ description: "default false: preview only" })),
    timeoutMs: TIMEOUT,
  }),
};
