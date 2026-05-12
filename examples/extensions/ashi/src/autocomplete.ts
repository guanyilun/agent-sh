import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { EventBus } from "agent-sh/event-bus";

/** Adapt pi-tui's AutocompleteProvider to agent-sh's autocomplete:request pipe.
 *  Reads the line up to the cursor, asks the bus for suggestions, returns them. */
export class BusAutocompleteProvider implements AutocompleteProvider {
  constructor(private bus: EventBus) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    if (cursorLine !== 0) return null;
    const line = lines[0] ?? "";
    const before = line.slice(0, cursorCol);
    if (!before.startsWith("/")) return null;

    // Split command from args. "/backend " → command="/backend", args=""
    const sp = before.indexOf(" ");
    const command = sp === -1 ? null : before.slice(0, sp);
    const commandArgs = sp === -1 ? null : before.slice(sp + 1);

    const result = this.bus.emitPipe("autocomplete:request", {
      buffer: before,
      command,
      commandArgs,
      items: [],
    });
    if (result.items.length === 0) return null;

    const items: AutocompleteItem[] = result.items.map((it) => ({
      value: it.name,
      label: it.name,
      description: it.description,
    }));
    // pi-tui matches selected completion against this prefix. When in arg
    // context, the prefix is the whole line so far ("/backend cla"); when
    // matching command names, the prefix is just the slash word.
    const prefix = command === null ? before : before;
    return { items, prefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    // Replace the prefix span (the leading slash-word + args we sent) with
    // the completion value. Anything after the cursor is preserved.
    const head = line.slice(0, cursorCol - prefix.length);
    const tail = line.slice(cursorCol);
    const newLine = `${head}${item.value}${tail}`;
    const out = lines.slice();
    out[cursorLine] = newLine;
    return {
      lines: out,
      cursorLine,
      cursorCol: (head + item.value).length,
    };
  }
}
