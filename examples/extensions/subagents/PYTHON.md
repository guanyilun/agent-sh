# Writing agent-sh workflows in Python

A workflow is a Python file that coordinates AI agents. The file is an ordinary `asyncio` program; agent-sh runs the agents for it, records every finished call so an interrupted run can resume, and enforces the limits the file sets. This guide is self-contained: read it top to bottom once and you can write one.

```bash
agent-sh run review.py --target src        # run it
agent-sh run review.py --help              # the file's own arguments
agent-sh run review.py --dry-run           # walk through it without calling a model
agent-sh run review.py --resume            # continue this file's latest run
agent-sh run --status                      # what each agent of the latest run is doing
```

## A complete file

```python
"""Review a target from several angles, fix what the reviewers find, and repeat until it is clean."""
import asyncio
from dataclasses import dataclass

from agentsh import run

description = "Review until clean"                       # one line, shown by --help

args = dict(                                             # command-line arguments
    target=dict(default="the uncommitted changes", help="what to review"),
    rounds=3,
)

config = dict(concurrency=4, budgetTokens=2_000_000, hours=1)   # limits, enforced by agent-sh


@dataclass
class Review:                                            # the shape an agent must answer in
    clean: bool
    findings: list[str]


async def main(args):
    for round in range(1, args.rounds + 1):
        reviews = await asyncio.gather(*[
            run(f"Review {args.target} for {focus}.", agent="reviewer", returns=Review)
            for focus in ["correctness", "missing tests"]])
        findings = [finding for review in reviews for finding in review.findings]
        if not findings:
            return f"Clean after {round} round(s)."
        await run("Fix only these findings:\n" + "\n".join(findings), agent="worker")
    return "Findings remain."
```

What `main` returns is the run's result: text, or anything JSON can hold (a dataclass instance is fine).

## The five names

```python
from agentsh import run, Agent, race, checkpoint, budget, RunError
```

### `run(task, ...)`: give one task to an agent

```python
answer = await run("Summarise CHANGES.md in five lines.")
plan = await run("Split this goal into tasks: ...", agent="plan", returns=Plan)
```

| Keyword | Meaning |
|---|---|
| `agent` | a named agent (table below). Leave it out for a plain agent with every tool. |
| `returns` | a dataclass; the answer comes back as an instance instead of as text. |
| `tools` | for a plain agent, the tools it may use; `[]` for none. Named agents keep their own. |
| `system` | for a plain agent, its role and rules. Not allowed together with `agent`. |
| `model` | override the model for this call. |
| `thinking` | how hard the model reasons: `"low"`, `"high"`, or `"off"`. Left out, the agent uses your agent-sh thinking level. |
| `label` | the name shown for it in progress lines. |

`run` starts the agent immediately and returns an awaitable. Start several and wait for them together:

```python
first, second = await asyncio.gather(run("..."), run("..."))
```

A run that fails (a model or tool error, or an answer that never fitted `returns`) raises `RunError`.

**Every agent starts from nothing.** It sees only its task: not your variables, not other agents' answers, not earlier calls. Put everything it needs into the task text, including file paths and the earlier results it should build on.

### `Agent(name)`: keep talking to one agent

```python
worker = Agent("worker")
draft = await worker.ask("Write the function described in SPEC.md.")
fixed = await worker.ask(f"The tests fail:\n{output}\nFix it.")      # it remembers the first turn
```

`Agent(name, ...)` takes `tools`, `system`, `model`, `thinking` and `label`, which apply to every turn; `ask(task, ...)` takes `returns`, `model`, `thinking` and `label`. Turns run one at a time. Use it for repair loops, where restating the history to a fresh agent would cost more and lose detail.

### `race(*attempts, accept=...)`: first good result wins

```python
proof = await race(prove(lemma, "by induction"), prove(lemma, "by contradiction"),
                   accept=lambda proof: proof.complete)
```

Each attempt is an awaitable: a `run(...)`, or a call to one of your own `async def` functions. The first result `accept` approves is returned and the other attempts are cancelled, which stops their agents. It returns `None` when every attempt finished and none was accepted. Without `accept`, any result that is not `None` wins. Attempts that write files should each use their own directory, since a cancelled attempt's files stay behind.

### `@checkpoint`: don't redo your own work on resume

```python
@checkpoint
async def run_tests(directory):
    ...                                   # slow work of your own: a test suite, a build, a download
    return passed, output

passed, output = await run_tests(directory)
```

Agent answers are saved automatically. Your own functions are not, and a resumed run would call them again. Mark a function with `@checkpoint` and its result is saved too. The function may be async or not, but the call is always awaited. Its result must be plain data (numbers, text, lists, dicts); a tuple comes back as a list. Each call is remembered by where it happens in the program, not by its arguments.

### `budget`: tokens left

`budget.remaining`, `budget.spent`, `budget.cached` and `budget.total`, as of the last call that finished. `total` is `None` and `remaining` is infinite unless `config` sets `budgetTokens`. Check it in open-ended loops:

```python
while budget.remaining > 200_000:
    ...
```

### What a call costs

An agent works in steps, and every step sends its whole conversation again: the tool descriptions, the task, and everything it has read so far. Three things keep that down:

- **Give an agent only the tools it needs.** Each tool's description is resent on every step. `tools=["read_file", "bash"]` covers most read-only work; `tools=[]` is cheapest.
- **Ask for few, large steps**: "read the whole file in one call", not page by page.
- **Lower `thinking`** for roles that only sort or merge text.

Most of a resent conversation is answered from the model server's cache, which is fast for it but still counted. `budget.cached` says how much of `budget.spent` that was.

## Answers with a shape

Pass a dataclass as `returns` and branch on real values, never on text you would have to parse.

```python
from dataclasses import dataclass
from typing import Literal, Optional

@dataclass
class Finding:
    file: str
    line: Optional[int]                       # Optional: the agent may leave it out
    severity: Literal["high", "medium", "low"]

@dataclass
class Report:
    findings: list[Finding]                   # nested dataclasses and lists work
    notes: str = ""                           # a default also makes a field optional
```

Supported field types: `str`, `int`, `float`, `bool`, `list[...]`, another dataclass, `Literal[...]`, `Optional[...]`. `returns=list[Finding]` works too. The agent is given a tool whose parameters are this shape and must call it to finish; an answer that doesn't fit is sent back to it to fix. Write `Optional[int]`, not `int | None`, to stay compatible with Python 3.9.

## Doing things at the same time

Concurrency is plain asyncio. There is nothing workflow-specific to learn.

```python
# all at once; any failure raises
answers = await asyncio.gather(*[run(f"Research {topic}") for topic in topics])

# all at once; keep going past failures
answers = await asyncio.gather(*[run(...) for ...], return_exceptions=True)
good = [answer for answer in answers if isinstance(answer, str)]     # or isinstance(answer, YourDataclass)

# several steps per item, items independent of each other
async def handle(item):
    draft = await run(f"Draft {item}")
    return await run(f"Check this draft of {item}:\n{draft}", agent="reviewer", returns=Verdict)

results = await asyncio.gather(*[handle(item) for item in items], return_exceptions=True)
```

- **`config.concurrency` caps how many agents work at once.** Starting a hundred runs is fine; the rest wait their turn.
- **Cancelling stops the agent.** If the task waiting on a call is cancelled (`asyncio.wait_for` timing out, a lost `race`), agent-sh stops that agent.
- **Hitting a limit cancels the program.** When the token budget, the run cap or the deadline is reached, or the user presses Ctrl-C, `main()` is cancelled like any asyncio task. `finally` blocks run. Don't catch `asyncio.CancelledError` to carry on.

## The file's three settings

```python
description = "One line for --help and listings."     # a plain string literal

args = dict(
    target=dict(default="src", help="what to review"),   # --target lib
    rounds=3,                                             # a bare value is the default; --rounds 5
    strict=False,                                         # booleans are switches: --strict / --no-strict
    name=dict(required=True),
)

config = dict(
    concurrency=6,            # agents working at once
    maxRuns=200,              # agent runs in total (default 50)
    maxIterations=60,         # steps one agent may take
    budgetTokens=5_000_000,   # stop when the agents have used this many tokens
    hours=3,                  # stop at this deadline
    agents="./agents",        # a folder of extra agent definitions, next to this file
    python=".venv/bin/python",   # the interpreter for this file, relative to it
    model="...", provider="...", # optional; otherwise agent-sh's defaults
)
```

`main(args)` receives the parsed arguments as `args.target`, `args.rounds`. Leftover words on the command line fill the first text argument. `config` must be a literal (plain values, lists, dicts, `dict(...)`), because it is read without running the file. A misspelled key refuses to start.

## The agents and their tools

| `agent=` | For | Can change files |
|---|---|---|
| `"explore"` | finding where things are in files, folders, documents or data | no |
| `"plan"` | turning a goal into steps, risks and open questions | no |
| `"research"` | answering from documentation and the web, with sources | no |
| `"reviewer"` | reviewing a result for errors and gaps | no |
| `"oracle"` | a second opinion on a plan or diagnosis | no |
| `"worker"` | carrying out a well-specified task and checking the result | yes |

A plain agent (no `agent=`) has every tool; narrow it with `tools=[...]`. Tool names: `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `ls`, `bash`. Use `tools=[]` for an agent that only needs to think about the text it is given. Agents cannot start other agents.

Define a role inline when no named agent fits:

```python
proofreader = dict(system="You proofread LaTeX. Report only typos and grammar.", tools=[], label="proofreader")
issues = await run(section_text, returns=Issues, **proofreader)
```

## Resume: what must hold

`--resume` runs the program again from the top and answers every call that already finished from the saved record. For that to line up:

- **Make the same calls given the same answers.** Don't let the clock, an unseeded random number or anything else outside the program decide which calls happen. Seed `random.Random(seed)` if you need randomness.
- **Mark your own side effects with `@checkpoint`**, or they run again.
- **Only the main program calls `run`, `Agent` and `race`.** Not threads, not other processes, not Ray or Dask workers.
- **Resume with the same Python version** that started the run.

If you edit the file and resume, calls whose inputs did not change are still reused; the first changed call and what follows it in that branch run live. A resume without arguments repeats the earlier run's arguments.

## Heavy work on other machines

The agents live in the one agent-sh process and mostly wait on the model. Your own heavy work (builds, test suites, simulations) can go out through whatever you already use, because the file is plain Python. Wrap it in `@checkpoint`:

```python
import ray

@ray.remote(num_cpus=8)
def build(directory): ...

@checkpoint
async def build_on_cluster(directory):
    return await build.remote(directory)
```

Start such libraries inside `main()`, not at the top of the file, which is also loaded for `--help`.

## Patterns worth copying

**Verify before trusting.** One agent saying something is so is weak evidence. Send the claim to skeptics told to refute it, and keep it only if most cannot. A skeptic whose run failed is not a vote for the claim.

**Let a command be the judge.** When there is a test suite, a compiler or a checker, run it from the program (a subprocess under `@checkpoint`) and go by its exit code or output. Agents write and repair; the command decides. Send its output back to the same `Agent` to fix failures.

**Different angles beat repetition.** Three reviewers with three different questions find more than one question asked three times.

**Stop early when the outcome is decided.** Ask voters one at a time and stop as soon as two agree, instead of always paying for three.

**Cap every loop**, by rounds and by `budget.remaining`. Say in the result what was left undone; never let a truncated job read as complete.

**Build the report in code.** Collect structured results and format them yourself. Ask an agent to write prose only when prose is the product.

## Mistakes to avoid

- **Forgetting `await`.** `run(...)` without `await` gives you an awaitable, not an answer.
- **Parsing an agent's prose.** Use `returns=` for anything the program branches on.
- **Tasks that assume shared knowledge.** An agent cannot see your variables or another agent's answer unless you paste them into its task.
- **Two writers on the same files.** Give concurrent `worker` agents separate directories.
- **`asyncio.gather(..., return_exceptions=True)` without checking types.** The list then holds exceptions next to results.
- **A top-level side effect.** Code outside `main()` runs for `--help` too.
- **Expecting `--dry-run` to skip your own code.** It replaces only the agents' answers with placeholders; your subprocesses and file writes still happen.
- **Leaving `maxRuns` at its default** in a workflow that makes more than 50 agent calls.

## Checking a file before spending tokens

1. `agent-sh run file.py --help` shows the arguments parse.
2. `agent-sh run file.py --dry-run` walks every branch your placeholders reach and prints each call. Dataclass answers come back filled with placeholders (`False`, `0`, `"<field>"`, one-item lists).
3. Run it for real on the smallest input you have, with a low `budgetTokens`.

Progress goes to stderr and the result to stdout. `print()` in the file becomes a progress line. Every run has a folder under `~/.agent-sh/workflow-runs/<id>/` with the saved answers and a full transcript per agent.

## Examples to read

- `examples/workflows/campaign.py`: plan, do the planned tasks at once, repeat.
- `examples/workflows/solve.py`: tasks in parallel, two agents racing per task, a check command as the judge, repairs sent back to the same agent, reviewers attacking the winner.

Needs Python 3.9 or later. Not tried on Windows.
