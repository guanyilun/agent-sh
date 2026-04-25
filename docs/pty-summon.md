# Shell hook markers

agent-sh injects three invisible OSC escape sequences into its inner shell to detect command boundaries and prompt state:

| OSC | Body                | Meaning                       |
| --- | ------------------- | ----------------------------- |
| 9999 | `id=<tag>;PROMPT`  | shell returned to a prompt    |
| 9997 | `id=<tag>;<cmd>`   | shell is starting `<cmd>`     |
| 9998 | `id=<tag>;READY`   | prompt rendering finished     |

`<tag>` is the agent-sh process's `instanceId` (6 hex chars), the same identifier surfaced as `ExtensionContext.instanceId`. Each running instance has its own.

## Parser semantics

For every marker:

- **Tag matches our own** → self event. Update foreground state, finalize/start commands.
- **Tag doesn't match (or no tag)** → ignore. The bytes are treated as opaque foreground output. This is what prevents nested agent-sh instances (e.g. an `ash` launched inside an SSH session) from cross-triggering the outer instance.

## Future: foreign-shell summon

Untagged markers from a foreign shell (e.g. a remote `bashrc` snippet that emits `\033]9999;PROMPT\007`) are not honored by core. Summoning a local agent into a foreign session — including proper redraw handling, command-done semantics, and PTY-write tools — will live in a dedicated extension that owns the full lifecycle.
