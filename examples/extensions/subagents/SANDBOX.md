# Sandbox

Sandboxing for unattended runs, built into the subagents extension. It's inactive unless armed, so interactive
sessions are unaffected. There are two layers:

- **Guard**, on every platform: refuses tool calls that break the policy, for the main agent, subagents and
  workflows alike. It's a tripwire against honest mistakes, not isolation: `bash` can still reach files by other means.
- **OS sandbox**: the whole run is restarted inside one, so even `bash` and code the agents run are confined.
  - **Linux: bubblewrap** (`sandbox/sandbox.sh`), where it works (it needs unprivileged user namespaces): the host is
    read-only, only the write dirs are writable, hidden paths are masked, `/tmp` is private, processes are isolated.
  - **Linux without usable bubblewrap: Landlock** (`sandbox/landlock.py`, needs Linux 5.13+ with Landlock enabled and
    `python3`; no user namespaces): writes only under the write dirs, the agent-sh home's runtime state and temp dirs;
    hidden paths unreadable. Landlock can only allow, so hiding a path means allowing reads beside it at each level:
    entries created later next to a hidden path's ancestors aren't readable, and names inside a hidden dir can be
    listed but not read. New top-level entries in the agent-sh home can't be created.
  - **macOS: Seatbelt** (the built-in `sandbox-exec`): writes only under the write dirs, the agent-sh home's runtime
    state and your temp dirs; hidden paths unreadable.
  - Landlock and Seatbelt, unlike bubblewrap, leave temp dirs shared rather than private and don't isolate processes.
  - **Elsewhere (e.g. Windows)** there's no OS sandbox, only the guard; nothing is probed or wrapped. The guard there is
    best effort: path checks are case-sensitive, and only POSIX `rm -r` is recognised.

## From a run file

```ts
export const config = {
  hours: 3,                                     // clock in every request + hard stop
  sandbox: {
    write: ["./out"], hide: ["../heldout"],     // relative to the file
    policy: "./rules.json",                     // optional extra rules (format below)
    os: "preferred",                            // "required" | "preferred" | "off"
  },
};
```

Run files without a `sandbox` section aren't sandboxed. With one:

| `os` | OS sandbox usable | Not usable (e.g. bwrap blocked, or another OS) |
|---|---|---|
| `"preferred"` (default) | restarted inside bubblewrap, plus the guard | guard only, with a notice saying why |
| `"required"` | bubblewrap plus the guard | refuses to start (exit 2), before any model call |
| `"off"` | guard only | guard only |

Usability is probed by running the sandbox once, not by checking that it's installed; on Linux, bubblewrap is tried
first, then Landlock. `SBX_BWRAP`, `SBX_SANDBOX_EXEC` and `SBX_PYTHON` override the tool paths, and
`SBX_LANDLOCK=off` skips Landlock. The startup notice says which applies, e.g. `os sandbox: on (seatbelt)`.

`net: false` isn't supported yet and refuses to start: the sandbox wraps the whole run, which needs the network to
reach the model. Cutting the network for the agents' own commands needs per-agent isolation.

## Rules

Built in: `write_file`/`edit_file` only under the write dirs; no reads of hidden paths (file tools or `bash`); no git
commands that change history or branches; no `rm -r` outside the write dirs.

A policy file adds rules for your environment:

```json
{ "forbid": [{ "regex": "(^|\\s)(sbatch|squeue)\\b", "message": "agents don't use the job scheduler" }],
  "noRecursiveSearch": { "at": ["/shared/home"], "under": ["/shared/software"], "message": "too big to search" } }
```

`forbid` regexes apply to `bash`/`pwsh` commands; `noRecursiveSearch` blocks recursive searches rooted at (`at`) or
under (`under`) those paths, from `bash` and from `glob`/`grep`. An unreadable policy refuses every tool call rather
than silently dropping its rules. To keep agents off a scheduler entirely, also hide its socket and client binaries
(`hide`), which the OS sandbox enforces.

## From environment variables

For callers that start agent-sh themselves (e.g. a search controller running many `agent-sh -p` agents):
`SBX_GUARD=1` arms the guard, with `SBX_WRITE_ROOTS=a:b`, `SBX_HIDE=a:b`, `SBX_POLICY=file.json` and
`SBX_DEADLINE=<unix seconds>` (`SBX_BUDGET_MIN`) for the clock. Wrap the process in `sandbox/sandbox.sh` yourself for
OS isolation. When armed it emits `sandbox guard armed (...)`; headless callers should require that notice.

## Self-tests

`SBX_WRITE_ROOTS=/dir [SBX_HIDE=/secret] node sandbox/guard_selftest.mjs` (built-in rules plus an example policy);
`sandbox/sandbox.sh --selftest /dir [/secret]` on Linux (set `SBX_ENDPOINT=host:port` to check the network too).
