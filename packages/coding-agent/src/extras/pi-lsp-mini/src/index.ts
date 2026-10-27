import fs from "node:fs/promises";
import path from "node:path";
import type { ModuleApi } from "@nanopi/pi-coding-agent";
import {
  LspManager,
  type Ctx,
  formatDiagnostic,
  severityRank,
  delay,
  findProjectRoot,
  type MatchedServer,
} from "./manager.ts";
import { uriToFilePath, type LspClient } from "./client.ts";
import { loadServers, requestTimeoutFor, type LspServerConfig } from "./config.ts";
import { createBudget } from "./budget.ts";
import { DIAGNOSTICS, HOVER, DEFINITION, QUERY, EDIT, LSP_GUIDANCE } from "./schemas.ts";
import type { CallHierarchyItem, Diagnostic, DocumentSymbol, Location, Range, SymbolInformation } from "./lsp-types.ts";
import { clampHover, hoverText } from "./hover.ts";
import { resolveTarget } from "./symbol-target.ts";
import { callGraphReport, type Direction } from "./callgraph.ts";
import { appendReport, collectEditDiagnostics } from "./edit-diagnostics.ts";
import { collectReadDiagnostics } from "./read-diagnostics.ts";
import { loadEditDiagnosticsSettings, loadReadDiagnosticsSettings } from "./settings.ts";
import {
  applyLineRangeDeletes,
  applyTextEdits,
  expandOverDocLines,
  mergeLineRanges,
  normalizeWorkspaceEdit,
  planUsage,
  type LineRange,
} from "./edits.ts";

const manager = new LspManager();

/** Single-request budget: the per-call `timeoutMs`, else the server's own deadline. */
function perCall(match: { server: LspServerConfig }, timeoutMs: number | undefined, signal?: AbortSignal) {
  return createBudget({ timeoutMs, defaultTimeoutMs: requestTimeoutFor(match.server), signal });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * What the model is told when no installed server handles the path.
 *
 * A bare "no language server matches" reads like "this tool does not work here",
 * and the model stops calling the whole family for the rest of the session.
 * Naming the cause and the alternative keeps the failure local to one file.
 */
function noServer(file: string) {
  return textResult(
    `no language server matches ${file}: no installed server handles this language. Use read/grep instead, and mention the missing server to the user (/lsp lists configured-but-not-installed ones).`,
  );
}

function pos(params: { line: number; character?: number }) {
  return { line: params.line - 1, character: (params.character ?? 1) - 1 };
}

/** Tolerates off-by-one columns: snaps to the nearest identifier character on the line. */
function snapPos(lines: string[], p: { line: number; character: number }): { line: number; character: number } {
  const line = lines[p.line] ?? "";
  const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);
  if (isWord(line[p.character])) return p;
  for (let c = p.character + 1; c < line.length; c++) if (isWord(line[c])) return { ...p, character: c };
  for (let c = p.character - 1; c >= 0; c--) if (isWord(line[c])) return { ...p, character: c };
  return p;
}

function fmtLoc(location: Location): string {
  return `${location.uri.replace(/^file:\/\//, "")}:${location.range.start.line + 1}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function contains(range: Range, line: number, character: number): boolean {
  const { start, end } = range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && character < start.character) return false;
  if (line === end.line && character > end.character) return false;
  return true;
}

/** Deepest DocumentSymbol (or SymbolInformation) covering the position; returns its full range + name. */
function findSymbolAt(
  symbols: DocumentSymbol[] | SymbolInformation[] | null,
  line: number,
  character: number,
): { name: string; range: Range; kind: number } | undefined {
  let best: { name: string; range: Range; kind: number; size: number } | undefined;
  const visit = (symbol: { name: string; range: Range; kind: number; children?: DocumentSymbol[] }): void => {
    if (contains(symbol.range, line, character)) {
      const size = (symbol.range.end.line - symbol.range.start.line) * 10000 + symbol.range.end.character - symbol.range.start.character;
      if (!best || size < best.size) best = { name: symbol.name, range: symbol.range, kind: symbol.kind, size };
    }
    for (const child of symbol.children ?? []) visit(child);
  };
  const list = symbols ?? [];
  if (list.length > 0 && "location" in list[0]) {
    for (const info of list as SymbolInformation[]) {
      if (info.location && contains(info.location.range, line, character)) visit({ ...info, range: info.location.range });
    }
  } else {
    for (const symbol of list as DocumentSymbol[]) visit(symbol);
  }
  return best ? { name: best.name, range: best.range, kind: best.kind } : undefined;
}

async function readLines(file: string): Promise<string[]> {
  return (await fs.readFile(file, "utf8")).split(/\r?\n/);
}

/** After applying edits to disk, push new content to the server and report fresh diagnostics. */
async function rescan(ctx: { cwd: string; signal?: AbortSignal }, files: string[]): Promise<string> {
  const touched: string[] = [];
  for (const file of files) {
    try {
      await manager.openFile(ctx, file);
      touched.push(path.resolve(ctx.cwd, file));
    } catch {
      // server may not match; ignore
    }
  }
  if (touched.length === 0) return "";
  await delay(1500, ctx.signal);
  const lines: string[] = [];
  for (const file of touched) {
    for (const { serverId, diagnostics } of manager.latestDiagnostics(file)) {
      const errors = diagnostics.filter((d) => (d.severity ?? 1) <= 2);
      if (errors.length > 0) lines.push(`⚠️ ${path.relative(ctx.cwd, file)} [${serverId}]`);
      lines.push(...errors.slice(0, 5).map(formatDiagnostic));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// lsp_query branches
// ---------------------------------------------------------------------------

type Opened = { client: LspClient; match: MatchedServer };
type ToolResult = ReturnType<typeof textResult>;

/** Who uses the symbol at the cursor, one block per file with the line's text. */
async function references(
  target: Opened,
  file: string,
  p: { line: number; character: number },
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<ToolResult> {
  const refs = await target.client.references(file, p.line, p.character, false, perCall(target.match, timeoutMs, signal));
  if (!refs || refs.length === 0) return textResult("no references found");
  const byFile = new Map<string, Location[]>();
  for (const ref of refs) {
    const name = fmtLoc(ref).replace(/:\d+$/, "");
    byFile.set(name, [...(byFile.get(name) ?? []), ref]);
  }
  const lines = [`symbol used in ${refs.length} place(s):`];
  for (const [name, locations] of byFile) {
    lines.push(`\n${path.relative(cwd, name)}`);
    const fileLines = await readLines(name);
    for (const location of locations) {
      const ln = location.range.start.line;
      lines.push(`  ${ln + 1}: ${fileLines[ln]?.trim().slice(0, 120) ?? ""}`);
    }
  }
  return textResult(lines.join("\n"));
}

/**
 * Callers/callees of the function at the cursor. A server without call
 * hierarchy answers with references instead of nothing: the same question
 * ("who touches this") at a coarser granularity, which is what the model would
 * otherwise have to ask for in a second call.
 */
async function callGraph(
  target: Opened,
  file: string,
  p: { line: number; character: number },
  params: { direction?: string; depth?: number; timeoutMs?: number },
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<ToolResult> {
  if (!target.client.supportsCallHierarchy) {
    return references(target, file, p, params.timeoutMs, signal, cwd);
  }
  // One deadline for the whole walk (see budget.ts): with `both` and depth 3
  // this is dozens of sequential hops, and per-hop timeouts add up to minutes.
  const budget = createBudget({
    timeoutMs: params.timeoutMs,
    defaultTimeoutMs: requestTimeoutFor(target.match.server),
    signal,
  });
  const items = await target.client.prepareCallHierarchy(file, p.line, p.character, budget);
  const root: CallHierarchyItem | undefined = items?.[0];
  if (!root) return textResult("no callable symbol at that position");
  const report = await callGraphReport(
    target.client,
    root,
    (params.direction ?? "both") as Direction,
    Math.min(4, Math.max(1, params.depth ?? 2)),
    budget,
  );
  return textResult(report);
}

// ---------------------------------------------------------------------------
// lsp_edit branches
// ---------------------------------------------------------------------------

/** `apply` is opt-in for both branches: a workspace edit is destructive and the
 *  model can preview it for one extra call. */
function willApply(params: { apply?: boolean }): boolean {
  return params.apply === true;
}

function dryRunHint(kind: string): string {
  return `\n\nre-run with apply=true to execute this ${kind}.`;
}

async function renameSymbol(
  target: Opened,
  file: string,
  p: { line: number; character: number },
  newName: string,
  params: { apply?: boolean; timeoutMs?: number },
  request: Ctx,
): Promise<ToolResult> {
  if (!target.client.supportsRename) return textResult(`${target.match.server.id} does not support rename`);
  const ws = await target.client.rename(file, p.line, p.character, newName, perCall(target.match, params.timeoutMs, request.signal));
  const { fileEdits, skipped } = normalizeWorkspaceEdit(ws);
  if (fileEdits.length === 0) {
    return textResult(`cannot rename at ${path.relative(request.cwd, file)} (no edits returned${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""})`);
  }
  const root = target.match.root;
  const outside = fileEdits.filter((fe) => {
    const rel = path.relative(root, fe.file);
    return rel.startsWith("..") && path.relative(request.cwd, fe.file).startsWith("..");
  });
  const usable = fileEdits.filter((fe) => !outside.includes(fe));

  const total = usable.reduce((sum, fe) => sum + fe.edits.length, 0);
  const plan = usable.map((fe) => `  ${path.relative(request.cwd, fe.file)}: ${fe.edits.length} edit(s)`).join("\n");
  const notes: string[] = [];
  if (outside.length > 0) notes.push(`skipped (outside project): ${outside.map((fe) => path.relative(request.cwd, fe.file)).join(", ")}`);
  if (skipped.length > 0) notes.push(`unsupported ops skipped: ${skipped.join(", ")}`);

  const header = `rename to '${newName}': ${total} edit(s) in ${usable.length} file(s)`;
  const body = [plan, ...notes].filter(Boolean).join("\n");
  if (!willApply(params)) return textResult(`dry-run: ${header}\n${body}${dryRunHint("rename")}`);

  for (const fe of usable) {
    const text = await fs.readFile(fe.file, "utf8");
    await fs.writeFile(fe.file, applyTextEdits(text, fe.edits));
  }
  const report = await rescan(request, usable.map((fe) => fe.file));
  return textResult([`✓ renamed to '${newName}': ${total} edit(s) in ${usable.length} file(s)`, body, report ? `\npost-rename check:\n${report}` : ""].filter(Boolean).join("\n"));
}

async function deleteSymbol(
  target: Opened,
  file: string,
  p: { line: number; character: number },
  params: { apply?: boolean; timeoutMs?: number },
  request: Ctx,
): Promise<ToolResult> {
  const cwd = request.cwd;
  const symbols = await target.client.documentSymbol(file, perCall(target.match, undefined, request.signal));
  const decl = findSymbolAt(symbols, p.line, p.character);
  if (!decl) return textResult(`no symbol found at ${path.relative(cwd, file)}:${p.line + 1} — place the position on the declaration name`);

  const declRange = expandOverDocLines(await readLines(file), {
    start: decl.range.start.line,
    end: decl.range.end.line,
  });

  const refs = (await target.client.references(file, p.line, p.character, false, perCall(target.match, params.timeoutMs, request.signal))) ?? [];
  const usages = refs.filter((ref) => !(fmtLoc(ref) === `${file}:${decl.range.start.line + 1}`));

  const plans: string[] = [];
  const rangesByFile = new Map<string, LineRange[]>();
  const addRange = (f: string, range: LineRange) => rangesByFile.set(f, [...(rangesByFile.get(f) ?? []), range]);
  addRange(file, declRange);
  const kindName = decl.kind === 12 ? "function" : decl.kind === 6 ? "variable" : decl.kind === 13 ? "method" : "symbol";
  plans.push(`declaration: ${path.relative(cwd, file)}:${declRange.start + 1}-${declRange.end + 1}  delete ${kindName} '${decl.name}' (${declRange.end - declRange.start + 1} line(s))`);

  const manual: string[] = [];
  const cacheLines = new Map<string, string[]>();
  const linesOf = async (f: string): Promise<string[]> => {
    if (!cacheLines.has(f)) cacheLines.set(f, await readLines(f));
    return cacheLines.get(f)!;
  };

  for (const ref of usages) {
    const f = fmtLoc(ref).replace(/:\d+$/, "");
    if (f === file && ref.range.start.line >= declRange.start && ref.range.start.line <= declRange.end) continue;
    const plan = planUsage(await linesOf(f), ref);
    if (plan.kind === "delete") {
      addRange(f, plan.lines);
      plans.push(`usage: ${path.relative(cwd, f)}:${plan.lines.start + 1}${plan.lines.end > plan.lines.start ? `-${plan.lines.end + 1}` : ""}  delete line(s)`);
    } else {
      manual.push(`${path.relative(cwd, f)}:${ref.range.start.line + 1}  ${plan.snippet}`);
    }
  }

  const header = `delete '${decl.name}': ${usages.length} usage(s)`;
  const body = [
    ...plans.sort(),
    ...(manual.length > 0 ? ["", "needs MANUAL cleanup (not standalone statements):", ...manual.sort().map((m) => `  ✋ ${m}`)] : []),
  ].join("\n");
  if (!willApply(params)) return textResult(`dry-run: ${header}\n${body}${dryRunHint("delete")}`);

  const changed: string[] = [];
  for (const [f, ranges] of rangesByFile) {
    const lines = await linesOf(f);
    const out = applyLineRangeDeletes(lines, mergeLineRanges(lines, ranges));
    await fs.writeFile(f, out.join(dominantEolOf(await fs.readFile(f, "utf8"))));
    changed.push(f);
  }
  const report = await rescan(request, changed);
  return textResult([`✓ deleted '${decl.name}': ${changed.length} file(s) changed`, body, report ? `\npost-delete check:\n${report}` : ""].filter(Boolean).join("\n"));
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function lspMiniExtension(pi: ModuleApi): void {
  pi.on("session_shutdown", async () => {
    await manager.shutdownAll();
  });

  // A language server answers in the same message as the file content, both
  // before the model starts editing (`read`) and after it writes, so the errors
  // it inherited and the errors it introduced arrive with the code itself.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    const inputPath = (event.input as { path?: string } | undefined)?.path;
    if (!inputPath) return undefined;

    // Before a file is opened: the errors it already has travel with the
    // content, so a session does not spend a turn finding out that the file it
    // just started editing was broken before it touched it.
    if (event.toolName === "read") {
      const report = await collectReadDiagnostics(manager, ctx, inputPath, loadReadDiagnosticsSettings());
      return report.lines.length === 0 ? undefined : { content: appendReport(event.content, report) };
    }

    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

    const editDiagnostics = loadEditDiagnosticsSettings();
    if (event.toolName === "edit" && editDiagnostics.enabled) {
      const report = await collectEditDiagnostics(manager, ctx, inputPath, editDiagnostics);
      if (report.lines.length === 0) return undefined;
      return { content: appendReport(event.content, report) };
    }

    if (event.toolName !== "write") return undefined;

    try {
      const absolute = path.resolve(ctx.cwd, inputPath);
      const match = await manager.matchServer(absolute, ctx.cwd);
      if (!match) return undefined;
      await manager.openFile(ctx, absolute);
      await delay(match.server.diagnosticsWaitMs ?? 1200, ctx.signal);
      const entries = manager.latestDiagnostics(absolute).flatMap(({ diagnostics }) => diagnostics);
      const issues = entries.filter((d) => (d.severity ?? 1) <= 2);
      if (issues.length === 0) return undefined;
      const label = path.relative(ctx.cwd, absolute) || path.basename(absolute);
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n${issues.slice(0, 8).map(formatDiagnostic).join("\n")}\n(${issues.length} LSP issue${issues.length > 1 ? "s" : ""} in ${label})` },
        ],
      };
    } catch {
      return undefined;
    }
  });

  pi.registerCommand("lsp", {
    description: "List configured language servers",
    handler: async (_args: string, ctx) => {
      const available = manager.listServers();
      const availableIds = new Set(available.map((server) => server.id));
      const installed = available.length === 0
        ? ["  (none found on PATH)"]
        : available.map((server) => `  ${server.id.padEnd(14)} ${server.include?.join(" ")}`);
      // Listing only what resolved leaves the useful question unanswered ("why is
      // my language unsupported?"), so every built-in entry is shown with its state.
      const missing = loadServers()
        .filter((server) => !availableIds.has(server.id))
        .map((server) => `  ${server.id.padEnd(14)} ${Array.isArray(server.command) ? server.command.join(" | ") : server.command}`);
      ctx.ui.notify(
        [
          `pi-lsp-mini: ${available.length} language server(s) installed`,
          ...installed,
          ...(missing.length > 0 ? ["", `${missing.length} configured but not installed (first command on PATH wins):`, ...missing] : []),
        ].join("\n"),
      );
    },
  });

  // --- diagnostics ---------------------------------------------------------
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: DIAGNOSTICS.description,
    promptSnippet: DIAGNOSTICS.promptSnippet,
    promptGuidelines: DIAGNOSTICS.promptGuidelines,
    parameters: DIAGNOSTICS.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const target = path.resolve(ctx.cwd, params.path ?? ".");
      const min = severityRank(params.severity ?? "warning");
      // `timeoutMs` on this tool is the wait allowance for the whole call, not
      // per server: a directory scan asks every matching server in parallel and
      // waits once. Without it, each server's own diagnosticsWaitMs decides.
      const waitFor = (server: LspServerConfig, fallback: number): number =>
        params.timeoutMs ?? server.diagnosticsWaitMs ?? fallback;
      const stat = await fs.stat(target).catch(() => undefined);
      if (!stat) return textResult(`not found: ${target}`);

      const render = (file: string, serverId: string, diags: Diagnostic[]): string[] => {
        const kept = diags.filter((d) => (d.severity ?? 1) <= min);
        return kept.length === 0 ? [] : [`\n${path.relative(ctx.cwd, file)} [${serverId}]`, ...kept.slice(0, 12).map(formatDiagnostic)];
      };
      if (stat.isFile()) {
        const match = await manager.matchServer(target, ctx.cwd);
        if (!match) return noServer(target);
        await manager.openFile(ctx, target);
        await delay(waitFor(match.server, 1500), signal);
        const sections: string[] = [];
        for (const { serverId, diagnostics } of manager.latestDiagnostics(target)) sections.push(...render(target, serverId, diagnostics));
        return textResult(sections.length === 0 ? `✅ no LSP issues (>= ${params.severity ?? "warning"}) in ${path.basename(target)}` : sections.join("\n"));
      }

      // Directory scan: servers are independent, so they run together and the
      // call waits once rather than once per server.
      const scans = await Promise.all(
        manager.listServers().map(async (server) => {
          const root = await findProjectRoot(target, server.rootMarkers, ctx.cwd);
          const files = await manager.listFiles(target, server, root);
          if (files.length === 0) return { files, result: new Map<string, { serverId: string; diagnostics: Diagnostic[] }[]>() };
          const result = await manager.collectDiagnostics({ cwd: ctx.cwd, signal }, files, waitFor(server, 3000));
          return { files, result };
        }),
      );
      const sections: string[] = [];
      let scanned = 0;
      for (const { files, result } of scans) {
        scanned += files.length;
        for (const [file, entries] of result) {
          for (const { serverId, diagnostics } of entries) sections.push(...render(file, serverId, diagnostics));
        }
      }
      if (scanned === 0) return textResult(`no supported source files under ${path.relative(ctx.cwd, target) || target}`);
      const count = sections.filter((line) => /^[EWHI] /.test(line)).length;
      if (sections.length === 0) return textResult(`✅ no LSP issues (>= ${params.severity ?? "warning"}) in ${scanned} file(s)`);
      return textResult(`LSP diagnostics (${count} issue(s) in ${scanned} file(s)):\n${sections.join("\n")}`);
    },
  });

  // --- hover ---------------------------------------------------------------
  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: HOVER.description,
    promptSnippet: HOVER.promptSnippet,
    promptGuidelines: [LSP_GUIDANCE],
    parameters: HOVER.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return noServer(params.path);
      const file = path.resolve(ctx.cwd, params.path);
      const resolved = await resolveTarget(target.client, file, params, perCall(target.match, params.timeoutMs, signal));
      if (!resolved) {
        return textResult(`no symbol '${params.symbol ?? ""}' in ${path.relative(ctx.cwd, file)}; pass line/character instead`);
      }
      if (!target.client.supportsHover) return textResult(`${target.match.server.id} does not support hover`);
      const hover = await target.client.hover(file, resolved.cursor.line, resolved.cursor.character, perCall(target.match, params.timeoutMs, signal));
      const text = hoverText(hover).trim();
      if (!text) return textResult(`no hover information at ${path.relative(ctx.cwd, file)}:${resolved.label}`);
      return textResult(clampHover(text));
    },
  });

  // --- definition ----------------------------------------------------------
  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Definition",
    description: DEFINITION.description,
    promptSnippet: DEFINITION.promptSnippet,
    promptGuidelines: [LSP_GUIDANCE],
    parameters: DEFINITION.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return noServer(params.path);
      const file = path.resolve(ctx.cwd, params.path);
      const resolved = await resolveTarget(target.client, file, params, perCall(target.match, params.timeoutMs, signal));
      if (!resolved) {
        return textResult(`no symbol '${params.symbol ?? ""}' in ${path.relative(ctx.cwd, file)}; pass line/character instead`);
      }
      if (!target.client.supportsDefinition) return textResult(`${target.match.server.id} does not support definition`);
      const answer = await target.client.definition(file, resolved.cursor.line, resolved.cursor.character, perCall(target.match, params.timeoutMs, signal));
      const locations = !answer ? [] : Array.isArray(answer) ? answer : [answer];
      if (locations.length === 0) {
        return textResult(`no definition found for ${resolved.label} at ${path.relative(ctx.cwd, file)}:${resolved.cursor.line + 1}`);
      }
      const lines = locations.slice(0, 10).map((location) => {
        const declaredIn = uriToFilePath(location.uri);
        return `${path.relative(ctx.cwd, declaredIn) || path.basename(declaredIn)}:${location.range.start.line + 1}`;
      });
      const more = locations.length > lines.length ? `\n(${locations.length - lines.length} more)` : "";
      return textResult(`definition of ${resolved.label}:\n${lines.join("\n")}${more}`);
    },
  });

  // --- query (references / call graph) -------------------------------------
  pi.registerTool({
    name: "lsp_query",
    label: "LSP Query",
    description: QUERY.description,
    promptSnippet: QUERY.promptSnippet,
    promptGuidelines: [LSP_GUIDANCE],
    parameters: QUERY.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return noServer(params.path);
      const file = path.resolve(ctx.cwd, params.path);
      const p = snapPos((await fs.readFile(file, "utf8")).split(/\r?\n/), pos(params));
      if (params.kind === "callgraph") return callGraph(target, file, p, params, signal, ctx.cwd);
      return references(target, file, p, params.timeoutMs, signal, ctx.cwd);
    },
  });

  // --- edit (rename / delete symbol) ---------------------------------------
  // Both branches are destructive, workspace-wide, need a dry-run first, and
  // change the files the server already has open, so they share one tool: the
  // shared invariants (position resolution, outside-project skip, sequential
  // execution, post-change rescan) have one place to live instead of two that
  // have to be kept in sync by comment.
  pi.registerTool({
    name: "lsp_edit",
    label: "LSP Edit",
    description: EDIT.description,
    promptSnippet: EDIT.promptSnippet,
    promptGuidelines: [LSP_GUIDANCE],
    executionMode: "sequential",
    parameters: EDIT.parameters,
    async execute(_id, params, signal, _u, ctx) {
      if (params.kind === "rename" && !params.newName?.trim()) return textResult("kind=rename needs newName");
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return noServer(params.path);
      const file = path.resolve(ctx.cwd, params.path);
      const p = snapPos((await fs.readFile(file, "utf8")).split(/\r?\n/), pos(params));
      const request = { cwd: ctx.cwd, signal };
      if (params.kind === "rename") {
        return renameSymbol(target, file, p, params.newName!.trim(), params, request);
      }
      return deleteSymbol(target, file, p, params, request);
    },
  });
}

function dominantEolOf(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}
