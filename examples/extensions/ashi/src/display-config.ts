import { getExtensionSettings } from "agent-sh/settings";

export type ToolResultMode = "hidden" | "summary" | "preview";

export interface ToolEntryConfig {
  result: ToolResultMode;
  previewLines: number;
}

export interface DisplayResolver {
  resolve(name: string, modelDisplay?: Partial<ToolEntryConfig>): ToolEntryConfig;
}

const DEFAULT_ENTRY: ToolEntryConfig = { result: "preview", previewLines: 5 };

const BUILTIN_OVERRIDES: Record<string, Partial<ToolEntryConfig>> = {
  read: { result: "hidden" },
  ls: { result: "hidden" },
  grep: { result: "summary" },
  find: { result: "summary" },
  glob: { result: "summary" },
  bash: { result: "preview" },
  edit: { result: "preview" },
  edit_file: { result: "preview" },
  write: { result: "preview" },
  write_file: { result: "preview" },
};

interface AshiSettings extends Record<string, unknown> {
  display?: Record<string, Partial<ToolEntryConfig>>;
  groupMaxVisible?: number;
}

export function loadGroupMaxVisible(): number {
  const ashi = getExtensionSettings<AshiSettings>("ashi", {});
  const v = ashi.groupMaxVisible;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 2) return Infinity;
  return Math.floor(v);
}

function mergeEntry(base: ToolEntryConfig, patch?: Partial<ToolEntryConfig>): ToolEntryConfig {
  if (!patch) return { ...base };
  return {
    result: patch.result ?? base.result,
    previewLines: patch.previewLines ?? base.previewLines,
  };
}

export function loadDisplayResolver(): DisplayResolver {
  const ashi = getExtensionSettings<AshiSettings>("ashi", {});
  const userDisplay = ashi.display ?? {};
  const userDefault = mergeEntry(DEFAULT_ENTRY, userDisplay.default);
  return {
    resolve(name, modelDisplay) {
      let entry = mergeEntry(userDefault, BUILTIN_OVERRIDES[name]);
      if (modelDisplay) entry = mergeEntry(entry, modelDisplay);
      if (userDisplay[name]) entry = mergeEntry(entry, userDisplay[name]);
      return entry;
    },
  };
}
