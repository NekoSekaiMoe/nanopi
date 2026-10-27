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
  description: "Type signature and doc comment of the symbol at a position, without reading the file.",
  promptSnippet: "Read a symbol's signature/doc at a position",
  parameters: Type.Object({ ...AT, timeoutMs: TIMEOUT }),
};

export const DEFINITION = {
  description: "Where the symbol at a position is defined (file:line), without grepping for it.",
  promptSnippet: "Jump to a symbol's definition",
  parameters: Type.Object({ ...AT, timeoutMs: TIMEOUT }),
};

export const REFERENCES = {
  description: "All references (usages) of the symbol at a 1-based line/column.",
  promptSnippet: "Find all usages of a symbol",
  parameters: Type.Object({ ...POSITION, timeoutMs: TIMEOUT }),
};

export const CALLGRAPH = {
  description: "Call relations of the function at a 1-based position: callers and callees, recursive.",
  promptSnippet: "Trace callers/callees of a function",
  parameters: Type.Object({
    ...POSITION,
    direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")], { description: "default both" })),
    depth: Type.Optional(Type.Number({ description: "1-4, default 2" })),
    timeoutMs: TIMEOUT,
  }),
};

export const RENAME = {
  description: "Rename a symbol across the workspace (scope-aware batch replace). apply=false previews.",
  promptSnippet: "Rename a symbol workspace-wide",
  parameters: Type.Object({
    ...POSITION,
    newName: Type.String(),
    apply: Type.Optional(Type.Boolean({ description: "default true" })),
    timeoutMs: TIMEOUT,
  }),
};

export const DELETE = {
  description: "Delete a function and its standalone call-statement lines; other usages are listed as manual. Dry-run unless apply=true.",
  promptSnippet: "Delete a function and its call sites",
  parameters: Type.Object({
    ...POSITION,
    apply: Type.Optional(Type.Boolean({ description: "default false" })),
    timeoutMs: TIMEOUT,
  }),
};
