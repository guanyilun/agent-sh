# Sandbox

Sandboxing for unattended runs. It does nothing unless a run file has a `sandbox` section or `SBX_GUARD=1` is set,
so interactive sessions are unaffected. There are two layers:

- **Guard**, on every platform: refuses tool calls that break the policy, for every agent in the run. It's a tripwire
  against honest mistakes, not isolation: `bash` can still reach files by other means.
- **OS sandbox**: the whole run is restarted inside one, so even `bash` and code the agents run are confined.
  - **Linux: bubblewrap** (`sandbox.sh`), where it works (it needs unprivileged user namespaces): the host is
    read-only, only the write dirs are writable, hidden paths are masked, `/tmp` is private, processes are isolated.
  - **Linux without usable bubblewrap: Landlock** (`landlock.py`, needs Linux 5.13+ with Landlock enabled and
    `python3`; no user namespaces): writes only under the write dirs, the agent-sh home's runtime state and temp dirs;
    hidden paths unreadable. Landlock can only allow, so hiding a path means allowing reads beside it at each level:
    entries created later next to a hidden path's ancestors aren't readable, and names inside a hidden dir can be
    listed but not read. New top-level entries in the agent-sh home can't be created.
  - **macOS: Seatbelt** (the built-in `sandbox-exec`): writes only under the write dirs, the agent-sh home's runtime
    state and your temp dirs; hidden paths unreadable.
  - Landlock and Seatbelt, unlike bubblewrap, leave temp dirs shared rather than private and don't isolate processes.
  - **Elsewhere (e.g. Windows)** there's no OS sandbox, only the guard; nothing is probed or wrapped. The guard there is
    best effort: path checks are case-sensitive, and only POSIX `rm -r` is recognised.

## Setup

Copy or link this directory into `~/.agent-sh/extensions/`, or load it for one run:

```bash
agent-sh run campaign.ts -e path/to/examples/extensions/sandbox
```

A run file with a `sandbox` section refuses to start when this extension isn't loaded.

## The `sandbox` section

```ts
export const config = {
  sandbox: {
    write: ["./out"], hide: ["../private"],     // relative to the file
    policy: "./rules.json",                     // optional extra rules (format below)
    os: "preferred",                            // "required" | "preferred" | "off"
  },
};
```

| `os` | OS sandbox usable | Not usable (e.g. bwrap blocked, or another OS) |
|---|---|---|
| `"preferred"` (default) | restarted inside the OS sandbox, plus the guard | guard only, with a notice saying why |
| `"required"` | OS sandbox plus the guard | refuses to start (exit 2), before any model call |
| `"off"` | guard only | guard only |

Usability is probed by running the sandbox once, not by checking that it's installed; on Linux, bubblewrap is tried
first, then Landlock. `SBX_BWRAP`, `SBX_SANDBOX_EXEC` and `SBX_PYTHON` override the tool paths, and
`SBX_LANDLOCK=off` skips Landlock. The startup notice says which applies, e.g. `os sandbox: on (seatbelt)`.

An option the sandbox doesn't have (a misspelled `writes`, say) also refuses to start.

`net: false` isn't supported yet and refuses to start: the sandbox wraps the whole run, which needs the network to
reach the model. Cutting the network for the agents' own commands needs per-agent isolation.

## Rules

Built in:

- `write_file`/`edit_file` only under the write dirs.
- No reads of hidden paths: through the file tools, and in `bash` commands that name a path under one. A command
  that only mentions a hidden dir's name is allowed.
- No `rm -r` outside the write dirs.

A policy file adds rules for your environment or project:

```json
{ "forbid": [{ "regex": "\\bgit\\s+(push|commit|reset|rebase)\\b", "message": "git history is the user's" },
             { "regex": "(^|\\s)(sbatch|squeue)\\b", "message": "agents don't use the job scheduler" }],
  "noRecursiveSearch": { "at": ["/shared/home"], "under": ["/shared/software"], "message": "too big to search" } }
```

`forbid` regexes apply to `bash`/`pwsh` commands; `noRecursiveSearch` blocks recursive searches rooted at (`at`) or
under (`under`) those paths, from `bash` and from `glob`/`grep`. An unreadable policy refuses every tool call rather
than silently dropping its rules.

## From environment variables

For callers that start agent-sh themselves, such as a controller running many `agent-sh -p` agents:

| Variable | Effect |
|---|---|
| `SBX_GUARD=1` | arms the guard |
| `SBX_WRITE_ROOTS=a:b` | the write dirs (unset: every write is refused) |
| `SBX_HIDE=a:b` | hidden paths |
| `SBX_POLICY=a.json:b.json` | policy files |

When armed it emits the notice `sandbox guard armed (...)` (a `notice` event under `--output json`); a caller
should require it, since an extension that failed to load arms nothing. This path arms only the guard. For OS
isolation, wrap each process yourself:

```bash
sandbox.sh [--rw DIR]... [--hide PATH]... [--home AGENT_SH_HOME] [--no-net] [--chdir DIR] -- agent-sh -p "..."
```

`--no-net` cuts the network, for running generated code rather than an agent, which needs to reach the model.

## Limits

- The guard reads commands as text. A path built up inside a command (quoting tricks, variables, a script) gets past
  it; only the OS sandbox stops those.
- The run's own process needs your provider credentials, so `keys.json` and `settings.json` stay readable inside
  every OS sandbox (they're read-only there). Don't rely on the sandbox to keep API keys from the agents.
- To keep agents off a service entirely (a job scheduler, say), hide its socket and client binaries with `hide`,
  which the OS sandbox enforces, as well as forbidding the commands.

## Self-test

`sandbox.sh --selftest /dir [/hidden-dir]` checks bubblewrap on a Linux machine (set `SBX_ENDPOINT=host:port` to
check the network too). The guard, the Seatbelt profile and
the Landlock rule plan are covered by `tests/extensions/sandbox-guard.test.ts`, and Seatbelt and Landlock are
exercised for real by `tests/cli/run-sandbox.test.ts` where they're available.
