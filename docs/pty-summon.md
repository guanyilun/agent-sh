# PTY summon protocol

agent-sh detects shell command boundaries by reading three OSC escape sequences emitted by the inner shell's hooks. Two of them have a public, untagged form that any shell can emit — making any session "agent-summonable" without installing agent-sh on the remote.

## Marker shapes

| OSC | Body                          | Meaning                          |
| --- | ----------------------------- | -------------------------------- |
| 9999 | `id=<tag>;PROMPT` or `PROMPT` | shell returned to a prompt        |
| 9997 | `id=<tag>;<cmd>` or `<cmd>`   | shell is starting `<cmd>`         |
| 9998 | `id=<tag>;READY` or `READY`   | prompt rendering finished         |

`<tag>` is the agent-sh instance id (6 hex chars), the same id surfaced as `instanceId` in the extension context.

## Parser semantics

For every marker:

- **Tag matches our own** → self event. Update foreground state, finalize/start commands as usual.
- **No tag (untagged)** → foreign summon. Treated identically to a self event; the assumption is that the user deliberately wired the marker into a foreign shell to make it observable.
- **Tag doesn't match** → nested agent-sh instance. Ignore. The inner instance is tracking its own lifecycle; reacting here would cross the streams.

## Summoning your local agent inside an SSH session

Add to the remote shell's rc file (only the prompt marker is needed for summon):

**bash** (`~/.bashrc` on the remote):
```bash
if [[ $- == *i* ]]; then
  PROMPT_COMMAND='printf "\033]9999;PROMPT\007"; '"$PROMPT_COMMAND"
fi
```

**zsh** (`~/.zshrc` on the remote):
```zsh
if [[ -o interactive ]]; then
  precmd() { printf '\033]9999;PROMPT\007' }
fi
```

After this is in place, any SSH session you start from inside agent-sh becomes summonable: type `>` at the remote prompt and your local agent's input mode opens. The remote machine doesn't need agent-sh installed.

## What you get

Your local agent observes the remote PTY (commands, outputs, cwd via OSC 7) but its tools (`Bash`, `Read`, `Edit`) act on the local host, not the remote. To act on the remote, you'd need pty-write tools — see the `ssh-vision` extension (TODO).
