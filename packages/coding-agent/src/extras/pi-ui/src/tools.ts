/** Flat Codex-style renderers for Pi's built-in and selected extension tools. */

import type { ModuleRenderingSurface, ModuleToolsSurface, ToolDefinition } from "../../../core/modules/types.ts";
import { createEditToolDefinition } from "../../../core/tools/edit.ts";
import type { AgentToolResult, ToolRenderResultOptions } from "@nanopi/pi-coding-agent";
import { Text } from "@nanopi/pi-tui";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fgRgb } from "./gradient.ts";
import { createBashToolDefinition } from "../../../core/tools/bash.ts";
import { createLsToolDefinition } from "../../../core/tools/ls.ts";
import { createReadToolDefinition } from "../../../core/tools/read.ts";
import { createWriteToolDefinition } from "../../../core/tools/write.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { renderDiff } from "../../../modes/interactive/components/diff.ts";
import { BashExecutionComponent } from "../../../modes/interactive/components/bash-execution.ts";
import { generateDiffString } from "../../../core/tools/edit-diff.ts";

interface RowConfig {
  running: string | ((args: Record<string, unknown>) => string);
  done: string | ((args: Record<string, unknown>) => string);
  primary: (args: Record<string, unknown>) => string;
  shell?: boolean;
  showPrimary?: boolean;
}

/** The stable subset of ToolRenderContext used by these renderers. */
interface RenderContext {
  lastComponent: unknown;
  isPartial: boolean;
  isError: boolean;
  args?: unknown;
  state?: Record<string, unknown>;
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export const DOT_RUNNING: readonly [number, number, number] = [148, 148, 158];
export const DOT_DONE: readonly [number, number, number] = [74, 222, 128];
const DOT_ERROR: readonly [number, number, number] = [244, 63, 94];
const COMMAND_COLOR: readonly [number, number, number] = [137, 180, 250];
const FLAG_COLOR: readonly [number, number, number] = [239, 160, 190];
const SHELL_PREVIEW_LINES = 7;
const DIFF_PREVIEW_LINES = 12;
const EXPLORED_PREVIEW_LINES = 12;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const ROWS: Record<string, RowConfig> = {
  bash: { running: "Running", done: "Ran", primary: (args) => str(args.command), shell: true },
  read: { running: "Reading", done: "Read", primary: (args) => str(args.path) },
  edit: { running: "Editing", done: "Edited", primary: (args) => str(args.path) },
  write: { running: "Writing", done: "Wrote", primary: (args) => str(args.path) },
  grep: { running: "Searching", done: "Searched", primary: (args) => str(args.pattern) },
  find: { running: "Finding", done: "Found", primary: (args) => str(args.pattern) },
  ls: { running: "Listing", done: "Listed", primary: (args) => str(args.path) || "." },
  // These tools are supplied by extensions rather than Pi itself. Their
  // names and default shells are intentionally normalized to the same row
  // shape as the built-in search/question tools.
  fffind: { running: "Finding", done: "Found", primary: (args) => str(args.pattern) },
  ffgrep: { running: "Searching", done: "Searched", primary: (args) => str(args.pattern) },
  search: {
    running: "Searching",
    done: "Searched",
    primary: (args) => {
      if (typeof args.query === "string") return args.query;
      return Array.isArray(args.queries) ? `${args.queries.length} queries` : "";
    },
  },
  web_search: {
    running: "Searching",
    done: "Searched",
    primary: (args) => {
      if (typeof args.query === "string") return args.query;
      return Array.isArray(args.queries) ? `${args.queries.length} queries` : "";
    },
  },
  batch_web_fetch: {
    running: "Fetching",
    done: "Fetched",
    primary: (args) => Array.isArray(args.requests) ? `${args.requests.length} URLs` : "",
  },
  ask_user_question: {
    running: "Asking",
    done: "Asked",
    primary: (args) => {
      const questions = args.questions;
      if (!Array.isArray(questions)) return "";
      const first = questions[0];
      return first && typeof first === "object" ? str((first as Record<string, unknown>).question) : "";
    },
  },
  // The live row is suppressed entirely while the call is in flight: its
  // work shows up in the "• Exploring" group (see EXPLORE_TOOLS below), and
  // the call leaves no row behind once it settles — same as Codex, where an
  // exploration group collapses into the calls it grouped.
  subagent: { running: "Exploring", done: "Explored", primary: () => "", showPrimary: false },
  // @zhushanwen/pi-todo: only plan creation earns a transcript row
  // ("Plan created · N steps"); updates/deletes/clears hide their component
  // entirely and silently advance the Working line (see working.ts).
  todo: {
    running: (args) => (args.action === "add" ? "Creating plan" : args.action === "clear" ? "Clearing plan" : "Updating plan"),
    done: (args) => (args.action === "add" ? "Plan created" : args.action === "clear" ? "Plan cleared" : "Plan updated"),
    primary: (args) => {
      if (args.action === "add" && Array.isArray(args.texts)) return `${args.texts.length} steps`;
      if (typeof args.id === "number") return `#${args.id}`;
      if (Array.isArray(args.updates)) return `${args.updates.length} updates`;
      if (Array.isArray(args.ids)) return `${args.ids.length} todos`;
      return "";
    },
  },
};

const FACTORIES: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
  bash: (cwd) => createBashToolDefinition(cwd) as ToolDefinition<any, any, any>,
  read: (cwd) => createReadToolDefinition(cwd) as ToolDefinition<any, any, any>,
  edit: (cwd) => createEditToolDefinition(cwd) as ToolDefinition<any, any, any>,
  write: (cwd) => createWriteToolDefinition(cwd) as ToolDefinition<any, any, any>,
  ls: (cwd) => createLsToolDefinition(cwd) as ToolDefinition<any, any, any>,
};

function styleShellCommand(command: string, theme: Theme): string {
  let tokenIndex = 0;
  return command
    .split(/(\s+)/)
    .map((part) => {
      if (!part.trim()) return part;
      const current = tokenIndex++;
      if (current === 0) return fgRgb(part, COMMAND_COLOR);
      if (/^-{1,2}[\w-]/.test(part)) return fgRgb(part, FLAG_COLOR);
      if (/^(?:\||\|\||&&|;|>|>>|<)$/.test(part)) return theme.fg("dim", part);
      return theme.fg("toolOutput", part);
    })
    .join("");
}

function renderPrimary(value: string, config: RowConfig, theme: Theme): string {
  if (!value) return theme.fg("toolOutput", "…");
  return config.shell ? styleShellCommand(value, theme) : theme.fg("accent", value);
}

function renderTitle(
  config: RowConfig,
  args: Record<string, unknown>,
  context: RenderContext,
  theme: Theme,
  suffix = "",
): string {
  const running = context.isPartial;
  const dot = fgRgb("•", context.isError ? DOT_ERROR : running ? DOT_RUNNING : DOT_DONE);
  const resolveVerb = (verb: RowConfig["running"]): string => (typeof verb === "function" ? verb(args) : verb);
  const verb = theme.bold(theme.fg("toolTitle", running ? resolveVerb(config.running) : resolveVerb(config.done)));
  const primary = config.primary(args);
  const target = config.showPrimary === false || !primary ? "" : ` ${renderPrimary(primary, config, theme)}`;
  return `${dot} ${verb}${target}${suffix}`;
}

function textOutput(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

interface PreviewLine {
  text: string;
  omitted?: number;
}

interface DiffStats {
  added: number;
  removed: number;
}

interface RowRenderState {
  callComponent?: Text;
  diffStats?: DiffStats;
}

function selectPreviewLines(lines: string[], expanded: boolean, limit: number): PreviewLine[] {
  if (expanded) return lines.map((text) => ({ text }));
  if (limit <= 1) {
    return [{ text: lines.find((line) => line.trim().length > 0) ?? "(no output)" }];
  }
  if (lines.length <= limit) return lines.map((text) => ({ text }));

  const contentLines = Math.max(2, limit - 1);
  const headCount = Math.ceil(contentLines / 2);
  const tailCount = contentLines - headCount;
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount).map((text) => ({ text })),
    { text: "", omitted },
    ...lines.slice(-tailCount).map((text) => ({ text })),
  ];
}

function diffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function renderDiffStats(stats: DiffStats | undefined, theme: Theme): string {
  if (!stats) return "";
  return (
    " " +
    theme.fg("dim", "(") +
    theme.fg("success", `+${stats.added}`) +
    " " +
    theme.fg("error", `-${stats.removed}`) +
    theme.fg("dim", ")")
  );
}

function renderDiffText(diff: string, expanded: boolean, theme: Theme): string {
  const lines = selectPreviewLines(renderDiff(diff).split("\n"), expanded, DIFF_PREVIEW_LINES);
  return lines
    .map((line) => {
      const indent = "    ";
      if (line.omitted !== undefined) {
        return indent + theme.fg("muted", `… +${line.omitted} diff lines (ctrl+t to view full diff)`);
      }
      return indent + line.text;
    })
    .join("\n");
}

function renderResultText(
  toolName: string,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  if (options.isPartial) return "";

  const diff = getResultDiff(result);
  if ((toolName === "edit" || toolName === "write") && typeof diff === "string" && diff) {
    return renderDiffText(diff, options.expanded, theme);
  }

  const output = textOutput(result);
  const previewLines = ROWS[toolName]?.shell ? SHELL_PREVIEW_LINES : 1;
  return renderOutputText(output, options.expanded, theme, previewLines);
}

function getResultDiff(result: AgentToolResult<unknown>): string | undefined {
  const details = result.details;
  if (!details || typeof details !== "object") return undefined;
  const diff = (details as Record<string, unknown>).diff;
  return typeof diff === "string" ? diff : undefined;
}

function renderOutputText(output: string, expanded: boolean, theme: Theme, previewLines = 1): string {
  const lines = output ? output.split("\n") : ["(no output)"];
  const visibleLines = selectPreviewLines(lines, expanded, previewLines);

  return visibleLines
    .map((line, index) => {
      const branch = theme.fg("dim", index === 0 ? "  └ " : "    ");
      if (line.omitted !== undefined) {
        return branch + theme.fg("muted", `… +${line.omitted} lines (ctrl+t to view transcript)`);
      }
      return branch + theme.fg("toolOutput", line.text);
    })
    .join("\n");
}

interface ExploredLine {
  action: string;
  detail: string;
}

function formatExploredSearchDetail(name: string, detail: string): string {
  if (!detail.startsWith("{")) return detail;
  try {
    const args = JSON.parse(detail) as Record<string, unknown>;
    const pattern = str(args.pattern);
    const path = str(args.path);
    if (name === "grep" || name === "ffgrep") {
      return `${pattern}${path ? ` in ${path}` : ""}`;
    }
    if (name === "find" || name === "fffind") return pattern;
  } catch {
    // Keep extension-provided summaries that are not JSON objects.
  }
  return detail;
}

function formatRawSubagentTool(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return `$ ${str(args.command)}`.trim();
  if (name === "read" || name === "write" || name === "edit") {
    return `${name} ${str(args.path) || str(args.file_path)}`.trim();
  }
  if (name === "grep" || name === "ffgrep") {
    const pattern = str(args.pattern);
    const path = str(args.path);
    return `${name} ${pattern}${path ? ` in ${path}` : ""}`.trim();
  }
  if (name === "find" || name === "fffind") return `${name} ${str(args.pattern)}`.trim();
  const encoded = JSON.stringify(args);
  return `${name}${encoded && encoded !== "{}" ? ` ${encoded}` : ""}`;
}

function classifyExploredCall(raw: string): ExploredLine {
  const value = raw.trim();
  if (value.startsWith("$ ")) return { action: "Run", detail: value.slice(2) };

  const separator = value.search(/\s/);
  const name = (separator < 0 ? value : value.slice(0, separator)).toLowerCase();
  const rawDetail = separator < 0 ? "" : value.slice(separator).trim();
  const detail = formatExploredSearchDetail(name, rawDetail);
  const action =
    name === "read" ? "Read" :
    name === "grep" || name === "ffgrep" || name === "find" || name === "fffind" ? "Search" :
    name === "edit" ? "Edit" :
    name === "write" ? "Write" :
    name;
  return { action, detail };
}

function extractExploredCalls(result: AgentToolResult<unknown>, expanded: boolean): ExploredLine[] {
  const details = result.details;
  if (!details || typeof details !== "object") return [];
  const rawDetails = details as Record<string, unknown>;
  const runs = Array.isArray(rawDetails.results) ? rawDetails.results : [];
  const calls: ExploredLine[] = [];

  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const data = run as Record<string, unknown>;
    if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
      for (const call of data.toolCalls) {
        if (!call || typeof call !== "object") continue;
        const item = call as Record<string, unknown>;
        const text = expanded ? str(item.expandedText) || str(item.text) : str(item.text) || str(item.expandedText);
        if (text) calls.push(classifyExploredCall(text));
      }
      continue;
    }

    if (!Array.isArray(data.messages)) continue;
    for (const message of data.messages) {
      if (!message || typeof message !== "object") continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const item = part as Record<string, unknown>;
        if (item.type !== "toolCall" || typeof item.name !== "string") continue;
        const args = item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
          ? item.arguments as Record<string, unknown>
          : {};
        calls.push(classifyExploredCall(formatRawSubagentTool(item.name, args)));
      }
    }
  }

  return calls;
}

function groupExploredCalls(calls: ExploredLine[]): ExploredLine[] {
  const grouped: ExploredLine[] = [];
  for (const call of calls) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.action === "Read" && call.action === "Read") {
      previous.detail = `${previous.detail}, ${call.detail}`;
    } else {
      grouped.push({ ...call });
    }
  }
  return grouped;
}

function renderExploredResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  const calls = groupExploredCalls(extractExploredCalls(result, options.expanded));
  if (calls.length === 0) return renderOutputText(textOutput(result), options.expanded, theme, SHELL_PREVIEW_LINES);

  const lines = selectPreviewLines(
    calls.map((call) => `${call.action}\t${call.detail}`),
    options.expanded,
    EXPLORED_PREVIEW_LINES,
  );
  return lines
    .map((line, index) => {
      const branch = theme.fg("dim", index === 0 ? "  └ " : "    ");
      if (line.omitted !== undefined) {
        return branch + theme.fg("muted", `… +${line.omitted} actions (ctrl+t to view explored tools)`);
      }
      const separator = line.text.indexOf("\t");
      const action = separator < 0 ? line.text : line.text.slice(0, separator);
      const detail = separator < 0 ? "" : line.text.slice(separator + 1);
      return branch + theme.fg("accent", action) + (detail ? ` ${theme.fg("toolOutput", detail)}` : "");
    })
    .join("\n");
}

function resolveWritePath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function readPreviousWriteContent(path: string, cwd: string): Promise<string | undefined> {
  try {
    return await readFile(resolveWritePath(path, cwd), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    return undefined;
  }
}

function withWriteDiff(
  definition: ToolDefinition<any, any, any>,
  cwd: string,
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  const executeWithDiff: typeof execute = async (toolCallId, params, signal, onUpdate, context) => {
    const path = str((params as Record<string, unknown>).path);
    const content = str((params as Record<string, unknown>).content);
    const previousContent = path ? await readPreviousWriteContent(path, cwd) : undefined;
    const result = await execute(toolCallId, params, signal, onUpdate, context);
    if (previousContent === undefined) return result;

    const diff = generateDiffString(previousContent, content).diff;
    const previousDetails =
      result.details && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : {};
    return { ...result, details: { ...previousDetails, diff } };
  };

  return { ...definition, execute: executeWithDiff };
}

/**
 * User `!` commands are rendered by a separate BashExecutionComponent, which
 * tool renderers cannot reach. A shell row renderer replaces its bordered body
 * with the same flat rows the bash tool uses.
 */
export function installShellRenderer(pi: ModuleRenderingSurface): void {
  pi.registerShellRenderer((state, next, theme) => {
    const title = renderTitle(
      ROWS.bash!,
      { command: state.command },
      { isPartial: state.status === "running", isError: state.status === "error", lastComponent: undefined },
      theme,
    );
    let content = title;
    if (state.status !== "running") {
      let output = state.output.replace(ANSI_PATTERN, "").trim();
      if (!output && state.status === "error") output = `(exit ${state.exitCode ?? "?"})`;
      if (!output && state.status === "cancelled") output = "(cancelled)";
      content += `\n${renderOutputText(output, state.expanded, theme, SHELL_PREVIEW_LINES)}`;
    }
    const text = new Text(content, 0, 0);
    // The bordered row starts with a spacer. Preserve that rhythm while
    // replacing its body with the flat row.
    return { invalidate: () => {}, render: (width: number) => ["", ...text.render(width)] };
  });
}

/** Arg keys probed, in order, when deriving a primary label for unknown tools. */
const PRIMARY_ARG_KEYS = [
  "command",
  "path",
  "pattern",
  "query",
  "url",
  "file_path",
  "file",
  "name",
];

/** Best-effort primary label for tools without a curated ROWS entry. */
function genericPrimary(args: Record<string, unknown>): string {
  for (const key of PRIMARY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  if (Array.isArray(args.queries)) return `${args.queries.length} queries`;
  if (Array.isArray(args.requests)) return `${args.requests.length} URLs`;
  try {
    const encoded = JSON.stringify(args);
    if (!encoded || encoded === "{}") return "";
    return encoded.length > 80 ? `${encoded.slice(0, 77)}…` : encoded;
  } catch {
    return "";
  }
}

/** Derived row config for any tool without a curated entry: `• Running web search …`. */
function genericRowConfig(name: string): RowConfig {
  const label = name.replace(/[_-]+/g, " ").trim() || name;
  return { running: `Running ${label}`, done: `Ran ${label}`, primary: genericPrimary };
}

function rowConfigFor(name: string): RowConfig {
  return ROWS[name] ?? genericRowConfig(name);
}

/** Tools pi-ui re-registers via installToolRenderers; their flat rows come from those definitions. */
const PI_UI_BUILTIN_TOOLS = new Set(Object.keys(FACTORIES));

function isPiUiBuiltinTool(name: unknown): boolean {
  return typeof name === "string" && PI_UI_BUILTIN_TOOLS.has(name);
}

/**
 * Tools that only ever look at the repository. Every call of these groups into
 * one "• Exploring" run in the transcript, mirroring Codex's exploring cell:
 * read facts are combined into a single `Read a, b` row, and a running subagent
 * keeps the group open because its output is not in this transcript.
 */
const EXPLORE_TOOLS = new Set(["read", "ls", "grep", "find", "ffgrep", "fffind", "subagent"]);

export interface ExploreCall {
  action: string;
  detail: string;
}

function isExploreTool(name: string): boolean {
  return EXPLORE_TOOLS.has(name);
}

/**
 * Everything a subagent call contributes to the Exploring group: one action
 * per tool call the child made, read from the call's own `details.results`
 * (toolCalls or raw assistant messages, whichever the child runner emitted).
 */
export function exploringCalls(result: AgentToolResult<unknown>, expanded: boolean): ExploreCall[] {
  const details = result.details;
  if (!details || typeof details !== "object") return [];
  const raw = details as Record<string, unknown>;
  const runs = Array.isArray(raw.results) ? raw.results : [];
  const calls: ExploreCall[] = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const data = run as Record<string, unknown>;
    if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
      for (const call of data.toolCalls) {
        if (!call || typeof call !== "object") continue;
        const item = call as Record<string, unknown>;
        const text = expanded ? str(item.expandedText) || str(item.text) : str(item.text) || str(item.expandedText);
        if (text) calls.push(classifyExploredCall(text));
      }
      continue;
    }
    if (!Array.isArray(data.messages)) continue;
    for (const message of data.messages) {
      if (!message || typeof message !== "object") continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const item = part as Record<string, unknown>;
        if (item.type !== "toolCall" || typeof item.name !== "string") continue;
        const args = item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
          ? (item.arguments as Record<string, unknown>)
          : {};
        calls.push(classifyExploredCall(formatRawSubagentTool(item.name, args)));
      }
    }
  }
  return calls;
}

/**
 * One executed exploration call as the single action row it contributes to the
 * group. Read/List/Search mirror Codex's own action vocabulary; anything else
 * falls back to its classification. The subagent's own actions go through
 * `exploringCalls` instead — they are already classified.
 */
export function exploreCallFor(name: string, detail: string): ExploreCall {
  if (name === "read") return { action: "Read", detail };
  if (name === "ls") return { action: "List", detail: detail || "." };
  if (name === "grep" || name === "find" || name === "ffgrep" || name === "fffind") {
    return { action: "Search", detail };
  }
  return classifyExploredCall(detail);
}

/** Result body for renderer-redirected tools: flat output preview, no diff handling. */
function renderRedirectedResultText(
  name: string,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  isError = false,
): string {
  if (options.isPartial) return "";
  // The plan already lives in pi-todo's own status/widget; keep the transcript
  // to the single "Plan created/updated" row. Errors still surface.
  if (name === "todo" && !isError) return "";
  if (isExploreTool(name) && !isError) return "";
  const output = textOutput(result);
  // Image-only results would otherwise print a misleading "(no output)" row
  // above the image block the component renders separately.
  if (!output && result.content.some((item) => item.type !== "text")) return "";
  return renderOutputText(output, options.expanded, theme, ROWS[name]?.shell ? SHELL_PREVIEW_LINES : 1);
}

/**
 * Every tool pi-ui does not re-register itself gets the flat Codex row through
 * this resolver, with no per-tool declaration required. Tools listed in ROWS
 * use their curated verbs; anything else (new extension tools, MCP tools, …)
 * falls back to a derived `Running <name>` row.
 *
 * `next()` is the row the tool's own definition would draw, so this only
 * intercepts the tools pi-ui has not re-registered: their execute functions
 * stay with the owning module, and the tool's own renderers keep winning for
 * anything pi-ui ships itself.
 */
export function installExternalToolRenderers(pi: ModuleRenderingSurface): void {
  pi.registerToolRowRenderer((name, next) => {
    if (isPiUiBuiltinTool(name)) return undefined;
    return {
      // Flat rows draw their own framing, exactly like the tools pi-ui
      // re-registers with renderShell: "self".
      renderShell: "self",
      renderCall: (args, theme, context) => {
        const record = (args as Record<string, unknown>) ?? {};
        // Silent todo updates: hide the whole row; the Working line picks up
        // the new step. updateDisplay re-evaluates this flag before each pass,
        // and the result renderer re-shows the row when the call failed.
        if (name === "todo" && record.action !== "add") context.hide();
        // An exploration call owns no row of its own: the tool_result joins it
        // to the "• Exploring" group. Its result body is suppressed the same
        // way (see renderRedirectedResultText), so the resolved call keeps
        // rendering as an empty group. An exploration call that fails has
        // nothing to join, so it falls back to a plain row.
        if (isExploreTool(name) && !context.isError) context.hide();
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(renderTitle(rowConfigFor(name), record, context, theme));
        return text;
      },
      renderResult: (result, options, theme, context) => {
        // A failed silent todo update still surfaces its error row.
        if (name === "todo" && context.isError) context.hide();
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const content =
          name === "subagent"
            ? renderExploredResult(result, options, theme)
            : renderRedirectedResultText(name, result, options, theme, context.isError);
        text.setText(content);
        return text;
      },
    };
  });
}

function codexifyTool(name: string, cwd: string): ToolDefinition<any, any, any> | undefined {
  const factory = FACTORIES[name];
  const config = ROWS[name];
  if (!factory || !config) return undefined;

  const builtin = name === "write" ? withWriteDiff(factory(cwd), cwd) : factory(cwd);
  return {
    ...builtin,
    renderShell: "self",
    renderCall(args: unknown, theme: Theme, context: RenderContext): Text {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const state = (context.state ?? {}) as RowRenderState;
      state.callComponent = text;
      text.setText(
        renderTitle(
          config,
          (args as Record<string, unknown>) ?? {},
          context,
          theme,
          renderDiffStats(state.diffStats, theme),
        ),
      );
      return text;
    },
    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RenderContext,
    ): Text {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const state = (context.state ?? {}) as RowRenderState;
      const diff = getResultDiff(result);
      if ((name === "edit" || name === "write") && diff) {
        state.diffStats = diffStats(diff);
        const args = (context.args as Record<string, unknown> | undefined) ?? {};
        state.callComponent?.setText(
          renderTitle(config, args, context, theme, renderDiffStats(state.diffStats, theme)),
        );
      }
      text.setText(renderResultText(name, result, options, theme));
      return text;
    },
  };
}

export function installToolRenderers(pi: ModuleRenderingSurface & ModuleToolsSurface, cwd: string): string[] {
  const installed: string[] = [];
  for (const name of Object.keys(FACTORIES)) {
    try {
      const definition = codexifyTool(name, cwd);
      if (!definition) continue;
      pi.registerTool(definition);
      installed.push(name);
    } catch {
      // Keep Pi's built-in renderer when an internal factory changes.
    }
  }
  return installed;
}
