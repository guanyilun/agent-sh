// The Renderer contract: ashi renders through this interface and never imports a
// concrete TUI library directly.

import type { MountArgs, MountEnv, RenderModel } from "./schema.js";

/** Opaque handle to a renderer-native view. ashi passes these between factory
 *  and container methods but never inspects them — the concrete type (a pi-tui
 *  Component, an OpenTUI node, …) is renderer-private. */
declare const nodeBrand: unique symbol;
export interface RenderNode {
  readonly [nodeBrand]: true;
}

export interface StyledSink {
  /** Replace content with pre-styled ANSI lines; painted verbatim. */
  setLines(lines: string[]): void;
  /** Convenience for a single (possibly multi-line) string. */
  setText(text: string): void;
}

/** A text view whose content the renderer may recompute from the live width.
 *  Callers that don't care about width just use setText/setLines; callers that
 *  do (status bar, width-aware rows) register a render function. */
export interface TextView extends StyledSink {
  node: RenderNode;
  /** Renderer invokes fn with the real width (first paint + on resize) and
   *  paints the returned lines. Pass null to fall back to setText/setLines. */
  setRenderFn(fn: ((width: number) => string[]) | null): void;
}

export interface MarkdownOptions {
  /** Wrap each painted line — e.g. the thinking-block color or a message bg. */
  color?: (t: string) => string;
  bgColor?: (t: string) => string;
  paddingX?: number;
  paddingY?: number;
  /** Bracket the rendered block with OSC 133 shell-integration zones (prompt
   *  navigation). Renderers without terminal-zone support ignore it. */
  osc133Zones?: boolean;
}

/** Streaming markdown. ashi owns the buffer and pushes the full text on every
 *  update; the renderer owns width-aware reflow and partial redraw. */
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

/** Content-node factories every renderer supplies. The chat controllers and the
 *  frontend build their views from these. */
export interface RenderNodes {
  text(opts?: { paddingX?: number; paddingY?: number }): TextView;
  markdown(opts?: MarkdownOptions): MarkdownView;
  /** Inline image from a PNG buffer, or null when the renderer can't show it. */
  image(png: Buffer): RenderNode | null;
  container(): ContainerView;
  spacer(rows: number): RenderNode;
}

/** Raw key event, wrapped so ashi matches keys without importing the renderer's
 *  key utilities. */
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

/** Editor autocomplete contract, expressed in renderer-neutral terms (lines +
 *  cursor). Each renderer adapts it to its editor's native provider shape. */
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
  /** The renderer's default border color fn, captured so callers can restore it. */
  readonly defaultBorderColor: (t: string) => string;
  setBorderColor(fn: (t: string) => string): void;
  /** Force the input to recompute its own chrome (e.g. after a border change). */
  invalidate(): void;
}

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

/** A modal selection list. Imperative (not a Promise) so the host can mutate the
 *  list in place — e.g. delete-and-repopulate in the session picker. */
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

/** The composed chat surface: scrollback + auxiliary slots + input + status,
 *  plus lifecycle and input. mount() wires the standard vertical stack and
 *  focuses the input. */
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

/** Live handle to a mounted tool call line. The schema renderer satisfies this;
 *  extension authors write RenderModels, not this interface. */
export interface ToolCallView {
  node: RenderNode;
  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void;
  toggleExpanded?(): void;
}

/** Result-side counterpart. setDiffRenderer receives the width-aware diff closure
 *  produced by the edit/write tool at finalize. */
export interface ToolResultView {
  node: RenderNode;
  appendChunk(chunk: string): void;
  setDiffRenderer(fn: (width: number) => string[]): void;
  finalize(opts: { exitCode: number | null; summary?: string }): void;
  toggleExpanded(): void;
}

export interface RendererCapabilities {
  images: boolean;
  /** When false, the chat controllers fall back to plain styled text for
   *  assistant/thinking content instead of live markdown reflow. */
  markdownStreaming: boolean;
}

/** What ashi depends on. A renderer bundles the content-node factories, the app
 *  shell, and a capability list so the substrate can degrade rather than crash. */
export interface Renderer extends RenderNodes {
  readonly capabilities: RendererCapabilities;
  /** Visible width of a styled string (ANSI-aware, wide-char-aware). */
  measureWidth(text: string): number;
  /** Mount a tool-call / tool-result schema model into live views. */
  mountToolCall(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolCallView;
  mountToolResult(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolResultView;
  mount(): App;
}
