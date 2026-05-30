import type { MountArgs, MountEnv, RenderModel } from "./schema.js";

/** Opaque handle to a renderer-native view; ashi never inspects it. */
declare const nodeBrand: unique symbol;
export interface RenderNode {
  readonly [nodeBrand]: true;
}

export interface StyledSink {
  /** Pre-styled lines, painted verbatim (no reflow). */
  setLines(lines: string[]): void;
  setText(text: string): void;
}

export interface TextView extends StyledSink {
  node: RenderNode;
  /** Recompute lines from the live width (first paint + resize); null clears it. */
  setRenderFn(fn: ((width: number) => string[]) | null): void;
}

export interface MarkdownOptions {
  color?: (t: string) => string;
  bgColor?: (t: string) => string;
  paddingX?: number;
  paddingY?: number;
  /** Bracket with OSC 133 shell-integration zones; renderers may ignore. */
  osc133Zones?: boolean;
}

/** Streaming markdown: ashi pushes the full buffer each update; renderer reflows. */
export interface MarkdownView {
  node: RenderNode;
  setText(full: string): void;
}

export interface ContainerView {
  node: RenderNode;
  addChild(child: RenderNode): void;
  removeChild(child: RenderNode): void;
  clear(): void;
}

export interface RenderNodes {
  text(opts?: { paddingX?: number; paddingY?: number }): TextView;
  markdown(opts?: MarkdownOptions): MarkdownView;
  /** Inline image, or null when the renderer can't show it. */
  image(png: Buffer): RenderNode | null;
  container(): ContainerView;
  spacer(rows: number): RenderNode;
}

export interface KeyEvent {
  matches(name: string): boolean;
  isRelease(): boolean;
  isRepeat(): boolean;
}

export type KeyHandler = (key: KeyEvent) => { consume: boolean } | void;

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

/** Editor autocomplete in renderer-neutral terms (lines + cursor). */
export interface AutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
}

export interface InputView {
  node: RenderNode;
  getText(): string;
  setText(text: string): void;
  onChange(fn: (text: string) => void): void;
  onSubmit(fn: (text: string) => void): void;
  setAutocompleteProvider(p: AutocompleteProvider): void;
  /** Default border color fn, so callers can restore after a temporary change. */
  readonly defaultBorderColor: (t: string) => string;
  setBorderColor(fn: (t: string) => string): void;
  invalidate(): void;
}

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

/** Imperative (not a Promise) so the host can mutate the list in place —
 *  e.g. delete-and-repopulate in the session picker. */
export interface SelectView {
  node: RenderNode;
  setSelectedIndex(i: number): void;
  getSelectedItem(): SelectItem | undefined;
  onSelect(fn: (item: SelectItem) => void | Promise<void>): void;
  onCancel(fn: () => void): void;
}

export interface LoaderView {
  node: RenderNode;
  stop(): void;
}

export interface App {
  scrollback: ContainerView;
  footerSlot: ContainerView;
  queueSlot: ContainerView;
  input: InputView;
  status: TextView;
  setFocus(target: RenderNode): void;
  focusInput(): void;
  requestRender(force?: boolean): void;
  start(): void;
  stop(): void;
  onKey(handler: KeyHandler): void;
  createSelectList(items: SelectItem[], opts: { visibleRows: number }): SelectView;
  createLoader(label: string, color: (t: string) => string, muted: (t: string) => string): LoaderView;
}

/** Satisfied by the schema renderer; extension authors write RenderModels. */
export interface ToolCallView {
  node: RenderNode;
  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void;
  toggleExpanded?(): void;
}

export interface ToolResultView {
  node: RenderNode;
  appendChunk(chunk: string): void;
  /** Width-aware diff closure produced by the edit/write tool at finalize. */
  setDiffRenderer(fn: (width: number) => string[]): void;
  finalize(opts: { exitCode: number | null; summary?: string }): void;
  toggleExpanded(): void;
}

export interface RendererCapabilities {
  images: boolean;
  /** When false, assistant/thinking fall back to plain styled text. */
  markdownStreaming: boolean;
}

/** What ashi depends on: content-node factories + app shell + capabilities. */
export interface Renderer extends RenderNodes {
  readonly capabilities: RendererCapabilities;
  /** Visible (ANSI-aware) width of a styled string. */
  measureWidth(text: string): number;
  mountToolCall(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolCallView;
  mountToolResult(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolResultView;
  mount(): App;
}
