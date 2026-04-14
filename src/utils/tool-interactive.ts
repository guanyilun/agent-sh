/**
 * Interactive UI primitive for tools.
 *
 * Gives a tool imperative control over rendering and input on the active
 * surface. The tool provides render() + handleInput(), the primitive
 * handles surface writing, input interception, shell pause/unpause,
 * and cleanup.
 */
import type { EventBus } from "../event-bus.js";
import type { RenderSurface } from "./compositor.js";
import type { InteractiveSession, ToolUI } from "../agent/types.js";

/** Clear N lines above the cursor. */
function clearLines(surface: RenderSurface, count: number): void {
  for (let i = 0; i < count; i++) {
    surface.write("\x1b[A\x1b[2K");
  }
}

export function createToolUI(
  bus: EventBus,
  surface: RenderSurface,
): ToolUI {
  return {
    custom<T>(session: InteractiveSession<T>): Promise<T> {
      return new Promise<T>((resolve) => {
        let prevLineCount = 0;
        let finished = false;

        const done = (result: T) => {
          if (finished) return;
          finished = true;
          clearLines(surface, prevLineCount);
          bus.offPipe("input:intercept", interceptor);
          bus.emit("shell:stdout-hide", {});
          bus.emit("tool:interactive-end", {});
          session.onUnmount?.();
          resolve(result);
        };

        const render = () => {
          if (finished) return;
          clearLines(surface, prevLineCount);
          const lines = session.render(surface.columns);
          for (const line of lines) {
            surface.writeLine(line);
          }
          prevLineCount = lines.length;
        };

        const interceptor = (payload: { data: string; consumed: boolean }) => {
          if (finished) return payload;
          // Let Ctrl+C through for agent cancellation
          if (payload.data === "\x03") return payload;
          session.handleInput(payload.data, done);
          render();
          return { ...payload, consumed: true };
        };

        // Setup
        bus.emit("tool:interactive-start", {});
        bus.emit("shell:stdout-show", {});
        bus.onPipe("input:intercept", interceptor);
        session.onMount?.(() => render());
        render();
      });
    },
  };
}
