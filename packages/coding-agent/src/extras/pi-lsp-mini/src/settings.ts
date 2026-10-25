import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Opt-in diagnostics-after-edit, the `editDiagnostics` key of `lsp.json`. */
export interface EditDiagnosticsSettings {
  enabled: boolean;
  /** Wait this long for a publish that is newer than the edit before giving up. */
  timeoutMs: number;
  /** Only report errors (1) instead of errors and warnings (1-2). */
  errorsOnly: boolean;
  /** Cap on reported diagnostics. */
  maxDiagnostics: number;
}

export const DEFAULT_EDIT_DIAGNOSTICS: EditDiagnosticsSettings = {
  enabled: false,
  timeoutMs: 8000,
  errorsOnly: false,
  maxDiagnostics: 8,
};

function userConfigPath(): string {
  const envDir = process.env.NANOPI_CODING_AGENT_DIR;
  if (envDir) return path.join(envDir, "lsp.json");
  return path.join(os.homedir(), ".nanopi", "agent", "lsp.json");
}

/**
 * Reads `editDiagnostics` from lsp.json. Defaults to disabled: a module loaded
 * into every build must not start spawning a language server after each edit
 * unless the user asked for it.
 */
export function loadEditDiagnosticsSettings(configPath: string = userConfigPath()): EditDiagnosticsSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { ...DEFAULT_EDIT_DIAGNOSTICS };
  }
  const entry = (raw as { editDiagnostics?: Partial<EditDiagnosticsSettings> } | null)?.editDiagnostics;
  if (!entry || typeof entry !== "object") return { ...DEFAULT_EDIT_DIAGNOSTICS };
  return {
    enabled: entry.enabled === true,
    timeoutMs: typeof entry.timeoutMs === "number" && entry.timeoutMs >= 0 ? entry.timeoutMs : DEFAULT_EDIT_DIAGNOSTICS.timeoutMs,
    errorsOnly: entry.errorsOnly === true,
    maxDiagnostics:
      typeof entry.maxDiagnostics === "number" && entry.maxDiagnostics > 0
        ? Math.floor(entry.maxDiagnostics)
        : DEFAULT_EDIT_DIAGNOSTICS.maxDiagnostics,
  };
}
