import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Opt-in diagnostics-after-edit, the `editDiagnostics` key of `lsp.json`. */
export interface EditDiagnosticsSettings {
  enabled: boolean;
  /** Initial pause after didChange; many servers publish partial results earlier. */
  debounceMs: number;
  /** Wait this long for a publish that is newer than the edit before giving up. */
  timeoutMs: number;
  /** Only report errors (1) instead of errors and warnings (1-2). */
  errorsOnly: boolean;
  /** Cap on reported diagnostics. */
  maxDiagnostics: number;
}

export const DEFAULT_EDIT_DIAGNOSTICS: EditDiagnosticsSettings = {
  enabled: false,
  debounceMs: 500,
  timeoutMs: 8000,
  errorsOnly: false,
  maxDiagnostics: 8,
};

/**
 * The `readDiagnostics` key: the errors a file already has, attached to the
 * read result.
 *
 * The cost this removes is a round of the agent loop. A model that opens a file
 * it is about to edit learns the compile errors only after the edit, when the
 * post-edit report arrives, so it spends a turn discovering context it could
 * have had in the same message that showed it the code. Reading is what a
 * session does most, though, so the check is bounded like the edit one: never
 * fatal, never slower than `timeoutMs`, and silent when the file is clean.
 *
 * Only errors (severity 1) by default. Warnings on a freshly opened file are
 * mostly style noise from whatever the project's config happens to enforce, and
 * a report full of them is one the model learns to skip.
 */
export interface ReadDiagnosticsSettings {
  enabled: boolean;
  /** Only report diagnostics at or above this severity: 1 error, 2 warning. */
  maxSeverity: number;
  /** Total budget; on expiry the read result is returned unchanged. */
  timeoutMs: number;
  /** Cap on reported diagnostics per read. */
  maxDiagnostics: number;
  /** Files larger than this are skipped: a big file is usually not the one being edited. */
  maxFileBytes: number;
}

export const DEFAULT_READ_DIAGNOSTICS: ReadDiagnosticsSettings = {
  enabled: true,
  maxSeverity: 1,
  timeoutMs: 4000,
  maxDiagnostics: 8,
  maxFileBytes: 512 * 1024,
};

function userConfigPath(): string {
  const envDir = process.env.NANOPI_CODING_AGENT_DIR;
  if (envDir) return path.join(envDir, "lsp.json");
  return path.join(os.homedir(), ".nanopi", "agent", "lsp.json");
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.min(max, value) : fallback;
}

function readConfig(configPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Reads `editDiagnostics` from lsp.json. Defaults to disabled: a module loaded
 * into every build must not start spawning a language server after each edit
 * unless the user asked for it.
 */
export function loadEditDiagnosticsSettings(configPath: string = userConfigPath()): EditDiagnosticsSettings {
  const raw = readConfig(configPath);
  const entry = (raw as { editDiagnostics?: Partial<EditDiagnosticsSettings> } | null)?.editDiagnostics;
  if (!entry || typeof entry !== "object") return { ...DEFAULT_EDIT_DIAGNOSTICS };
  return {
    enabled: entry.enabled === true,
    debounceMs: numberIn(entry.debounceMs, DEFAULT_EDIT_DIAGNOSTICS.debounceMs, 0, 5000),
    timeoutMs: numberIn(entry.timeoutMs, DEFAULT_EDIT_DIAGNOSTICS.timeoutMs, 0, 60_000),
    errorsOnly: entry.errorsOnly === true,
    maxDiagnostics:
      typeof entry.maxDiagnostics === "number" && entry.maxDiagnostics > 0
        ? Math.floor(entry.maxDiagnostics)
        : DEFAULT_EDIT_DIAGNOSTICS.maxDiagnostics,
  };
}

/**
 * Reads `readDiagnostics` from lsp.json. Defaults to enabled: an error report
 * attached to a read costs one short paragraph when the file has problems and
 * nothing when it does not, which is the opposite trade from the post-edit
 * check (latency on the hottest path in the session).
 */
export function loadReadDiagnosticsSettings(configPath: string = userConfigPath()): ReadDiagnosticsSettings {
  const entry = (readConfig(configPath) as { readDiagnostics?: Partial<ReadDiagnosticsSettings> } | null)?.readDiagnostics;
  if (!entry || typeof entry !== "object") return { ...DEFAULT_READ_DIAGNOSTICS };
  return {
    enabled: entry.enabled !== false,
    maxSeverity: numberIn(entry.maxSeverity, DEFAULT_READ_DIAGNOSTICS.maxSeverity, 1, 4),
    timeoutMs: numberIn(entry.timeoutMs, DEFAULT_READ_DIAGNOSTICS.timeoutMs, 0, 60_000),
    maxDiagnostics: numberIn(entry.maxDiagnostics, DEFAULT_READ_DIAGNOSTICS.maxDiagnostics, 1, 100),
    maxFileBytes: numberIn(entry.maxFileBytes, DEFAULT_READ_DIAGNOSTICS.maxFileBytes, 0, 64 * 1024 * 1024),
  };
}
