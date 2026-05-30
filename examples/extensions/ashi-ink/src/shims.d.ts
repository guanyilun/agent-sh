// marked-terminal ships no type declarations.
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";
  export function markedTerminal(options?: unknown, highlightOptions?: unknown): MarkedExtension;
}
