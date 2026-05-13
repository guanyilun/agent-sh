import { getExtensionSettings } from "agent-sh/settings";

export type ToolResultMode = "hidden" | "summary" | "preview";

export interface ToolEntryConfig {
  result: ToolResultMode;
  previewLines: number;
}

export interface ToolDisplayConfig {
  default: ToolEntryConfig;
  [toolName: string]: ToolEntryConfig;
}

const DEFAULT_ENTRY: ToolEntryConfig = { result: "preview", previewLines: 8 };

const BUILTIN_OVERRIDES: Record<string, Partial<ToolEntryConfig>> = {
  read: { result: "hidden" },
  ls: { result: "hidden" },
  grep: { result: "summary" },
  find: { result: "summary" },
  glob: { result: "summary" },
  bash: { result: "preview", previewLines: 12 },
  edit: { result: "preview" },
  edit_file: { result: "preview" },
  write: { result: "preview" },
  write_file: { result: "preview" },
};

interface AshiSettings extends Record<string, unknown> {
  display?: Record<string, Partial<ToolEntryConfig>>;
}

function mergeEntry(base: ToolEntryConfig, patch?: Partial<ToolEntryConfig>): ToolEntryConfig {
  if (!patch) return { ...base };
  return {
    result: patch.result ?? base.result,
    previewLines: patch.previewLines ?? base.previewLines,
  };
}

export function loadToolDisplayConfig(): ToolDisplayConfig {
  const ashi = getExtensionSettings<AshiSettings>("ashi", {});
  const userDisplay = ashi.display ?? {};
  const userDefault = mergeEntry(DEFAULT_ENTRY, userDisplay.default);
  const config: ToolDisplayConfig = { default: userDefault };
  const names = new Set([
    ...Object.keys(BUILTIN_OVERRIDES),
    ...Object.keys(userDisplay).filter((k) => k !== "default"),
  ]);
  for (const name of names) {
    config[name] = mergeEntry(
      mergeEntry(userDefault, BUILTIN_OVERRIDES[name]),
      userDisplay[name],
    );
  }
  return config;
}

export function entryFor(config: ToolDisplayConfig, name: string): ToolEntryConfig {
  return config[name] ?? config.default;
}
