# DeepSeek Subagents

A Claude Code plugin. Delegate bounded coding sub-tasks — generate a file, write a test
suite, audit a folder, find where something lives — to DeepSeek subagents that read and
write the project directly. Their file reads, searches and tool loops happen out of
process, so only the final answer reaches your context.

## What it does

- **Seven tools instead of thirty-four.** `agent`, `orchestrate`, `agent_control`,
  `memory`, `review`, `generate`, `analyze` — each with a `role`/`kind`/`action`
  discriminator. Tool schemas are resent on every request, so a small surface is a
  permanent token saving. Old tool names (`subagent_coder`, `review_code`, …) still
  work as hidden aliases.
- **Plans run as a graph.** Write a dependency graph of subagents and hand it over:
  independent steps run in parallel, dependent ones inherit their predecessors'
  answers, and the run survives the tool call that started it.
- **Per-project isolation.** Every call is bound to one project root. File tools refuse
  any path that escapes it, so working in one repo can never touch another.
- **Memory that fills itself.** Facts about the codebase, the rules it holds you to, and
  what each thread decided live as plain markdown in `<project>/.agent/memory/`. Facts
  are captured after every run and re-checked against the working tree before they are
  served.
- **A context pipeline per subagent.** Oversized tool results are capped, old ones pruned,
  and only then is a summary paid for.
- **Context injected for you.** Project facts and the thread brief are added to each
  subagent's system prompt automatically — the caller never resends them.

## Install

```
/plugin marketplace add Abbas-F-R/DeepSeek-MCP
/plugin install deepseek-subagents@deepseek-subagents
```

One install, every project. Ships the tool backend, the skill, and seven commands
(`/deepseek-subagents:brief`, `delegate`, `orchestrate`, `generate`, `review`, `explore`,
`save`).

Put your key in your shell profile — never in a repo:

```bash
export DEEPSEEK_API_KEY=your_actual_key
```

## Developing on this plugin

```bash
npm install
npm run build
npm test
```

To try a local checkout before publishing, point a `.mcp.json` at your build. It is
gitignored, because it names paths that only exist on your machine:

```json
{
  "mcpServers": {
    "deepseek-subagents": {
      "command": "node",
      "args": ["/abs/path/to/DeepseekMCP/dist/index.js"]
    }
  }
}
```

### How the project root is decided

The root is **never written into config**. The host launches the backend with the project
directory as its working directory, and the root is resolved from there, walking up to the
nearest `.git`, `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml` or `.sln`. A
moved, renamed or cloned project keeps working with no config change.

Precedence, if you ever need to override it:

1. `project_root` argument on an individual tool call
2. `PROJECT_ROOT` environment variable
3. the working directory (the normal path)

One process per project, over stdio. There is no network transport and no shared
instance — a project's files, memory and sessions are reachable only from the process
bound to that project's root.

The resolved root is logged at startup and shown by `memory { action: "brief" }`.

### What to commit

Commit `.claude/skills/` if you vendor the skill into a repo. Commit `.agent/memory/` too
if you want the project's remembered facts, rules and thread history to travel with it;
the shipped `.gitignore` treats it as local state. `.env` always stays out of git.

## Working agreement

1. `memory { action: "brief", query: "what you are about to do" }` — stack, rules, the
   facts that rank for that query, and where the last thread stopped.
2. `memory { action: "chat_start", title, goal }` — get a chat id, pass it on later calls.
3. Delegate: `agent { role: "coder", task: "..." }`. Pass `session` to continue a thread.
   Facts are captured from the answer automatically.
4. `memory { action: "chat_save", summary, next_steps, decisions }` before finishing.

Mid-task, `memory { action: "recall", query: "..." }` answers from what is already known
instead of re-reading the codebase. `memory { action: "projects" }` lists every project
on this machine with its active chat.

See [the skill contract](plugin/skills/deepseek-subagents/SKILL.md) for the full tool
reference.

## Tests

```bash
npm test            # unit + integration, no API calls (~15s)
npm run test:live   # real DeepSeek subagents in a temp sandbox project (~6 min)
```

Live tests skip themselves when no API key is configured. They run every agent
against a throwaway fixture project in `$TMPDIR`, never a real repo. To run one:

```bash
node --import tsx --test --test-name-pattern="@coder writes" tests/live/agents.test.ts
```

## What subagents cannot see

Anything a subagent reads is sent verbatim to a model provider, so the boundary is
enforced in the tools rather than left to the prompt.

**Credential files are refused by every tool**, reads and writes alike — `.env*`,
`*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.netrc`, cloud credentials, `secrets.*`,
`terraform.tfstate`. This is not configurable. `list_directory` will not even name them.
Templates like `.env.example` and `*.pub` stay readable.

**Ignored paths** are skipped when walking the tree: build output, dependencies and
caches by default, plus everything in `.gitignore` and `.agentignore`. Both use
gitignore syntax, including `**`, character classes and `!` negation:

```gitignore
# .agentignore — keep the agent out of things that are big or irrelevant
fixtures/**
*.generated.ts
!src/keep.generated.ts
```

Dot-directories such as `.github` and `.claude` **are** searchable — only the ignore
rules decide. Reads over 2 MB are refused with a pointer to `search_files`, and files
over 1 MB are skipped while searching.

## Reading narrowly

`read_file` takes `offset` and `limit`, and returns line-numbered output:

```
[src/big.ts lines 100-104 of 401]
100| export const value99 = 99;
101| export const value100 = 100;
```

Measured on a 400-line file: reading the whole thing is ~7,145 tokens, the five lines
that mattered are ~99. The numbers are also why `file:line` anchors in memory are
trustworthy — a subagent citing line 97 is reading "97" rather than counting.

`search_files` takes a real glob, so a search can be scoped before it runs rather than
filtered after: `*.ts`, `**/*.test.ts`, `src/**`, or a bare `.md`.

## Orchestrated runs

`agent` runs one task. `orchestrate` runs a plan of them — a dependency graph, written
by the coordinating agent and executed verbatim:

```
orchestrate { action: "start", plan: {
  goal: "Add refresh-token rotation",
  tasks: [
    { id: "scan",  role: "explore",    task: "Map src/auth." },
    { id: "impl",  role: "coder",      task: "Add rotation.",        needs: ["scan"] },
    { id: "tests", role: "coder",      task: "Cover the new path.",  needs: ["impl"] },
    { id: "audit", role: "security",   task: "Audit it.",            needs: ["impl"] },
    { id: "check", kind: "checkpoint", task: "Run npm test and report.", needs: ["tests", "audit"] },
    { id: "fix",   role: "coder",      task: "Fix what it reported.", needs: ["check"] }
  ]
}}
```

`tests` and `audit` run at the same time; each dependent starts with its predecessors'
answers already in its context, capped at 6k chars each and 20k in total.

**The scheduler makes no model calls.** It resolves dependencies, holds a concurrency
ceiling, and records state — arithmetic on a graph, so it is testable and cannot drift.
Judgement about what to run stays with the agent that wrote the plan.

**Checkpoints are where tests get run.** Subagents cannot execute anything, so a
`checkpoint` task runs nothing: the graph stops, you run the suite, and the note you
approve with becomes the result its dependents read.

```
orchestrate { action: "approve", task: "check",
              note: "2 failing: auth.test.ts:41 expects 401, got 500" }
```

**The run outlives the call.** `start` returns the board immediately; `wait` parks until
a gate opens or the run ends, up to 4 minutes per call. Polling a twenty-minute run costs
more in tool calls than the run costs in tokens.

```
run-2026-08-06-77k2 [waiting] · Add a slugify helper alongside the existing string utilities
4/5 done · 20.7k tok · 1m12s

  done        scan     explore     2.4k tok  14s
  done        impl     coder       5.4k tok  17s     src/slug.ts
  done        tests    coder       9.4k tok  41s     src/slug.test.ts
  done        audit    security    3.5k tok  12s
  awaiting    verify   checkpoint                    ← Run the test suite and report the output.
```

**Nothing is lost when the chat closes.** Every state change is written to
`.agent/runs/<id>.md` through a temp file and a rename. On shutdown, in-flight model
calls are aborted and unfinished tasks are recorded as `interrupted`;
`action: "resume"` re-queues exactly those. A run left `running` by a process that no
longer exists is reported as interrupted rather than as working.

| Failure policy | Effect on the graph |
| :--- | :--- |
| `block` (default) | dependents are blocked, unrelated branches still finish |
| `continue` | dependents run anyway and are told what failed |
| `abort` | the whole run is cancelled |

**Delegation.** A task with `allowSpawn` gets a `spawn_agent` tool: it hands one piece
of its work to another subagent and only that subagent's final answer comes back, up to
two levels deep. The child appears as its own row in the run rather than as invisible
work. Note that a delegate may hold a role its parent does not — a read-only task with
`allowSpawn` can get files written — so set `allowedTools` to cap its delegates.

**Parallel writes are refused, not merged.** Two tasks writing the same file is the one
way this plugin could silently destroy work: the loser's edit vanishes with no error
anywhere. A task claims a file on first write and the other is refused by name. All
writes go through a temp file and a rename, so no reader ever sees a half-written file.

## Context pipeline

A subagent's own history is shaped before every model call, cheapest layer first — the
ordering matters more than any single layer, because it means you never pay a model to
do what arithmetic can:

| Layer | Does | Fires when |
| :--- | :--- | :--- |
| Budget | caps a single tool result, keeping head and tail | that result exceeds 6k tokens |
| Prune | replaces old tool results with a reference to what they returned | tool output over 40k tokens and at least 20k is reclaimable |
| Fold | writes a structured handoff note over the older turns | still over 85% of the usable window |

The last two turns are never touched, and compaction happens at 85% rather than at the
cliff, so it never lands mid-task. Measured on a run reading five large files:
**37,007 → 15,007 tokens, same answer.**

Set `DEEPSEEK_CONTEXT_WINDOW` if your model's window is not 128k.

## Memory

Plain markdown, no JSON — the agent reads this back on every run, and markdown costs a
fraction of the tokens for the same content.

```
<project>/.agent/memory/PROJECT.md      stack and modules, one line per package
<project>/.agent/memory/FACTS.md        what is true about the code, with file:line anchors
<project>/.agent/memory/RULES.md        conventions, always injected
<project>/.agent/memory/ARCHIVE.md      retired facts, kept recoverable
<project>/.agent/memory/chats/<id>.md   goal, state, decisions, next steps, files
<project>/.agent/memory/sessions/<id>.txt  transcripts, pruned after 14 days
~/.deepseek-mcp/PROJECTS.md             machine-wide project index
```

Three layers, each retrieved differently: facts by relevance to the task, rules always,
threads by recency. `FACTS.md` entries look like

```
- [a3f] Kestrel binds 0.0.0.0:6777 @server/src/Program.cs:30 #config x4 c0.90 2026-08-05
```

**Capture is automatic.** After each subagent run a cheap DeepSeek pass proposes facts;
deterministic code merges them. A repeat claim reinforces the existing entry, a changed
value supersedes it and the old one moves to the archive. The model proposes, it never
rewrites the store — letting a model rewrite its own accumulated context is what makes
these systems collapse. Set `MEMORY_AUTOCAPTURE=0` to disable.

**Edits by hand are noticed.** Each fact stores a hash of the lines its anchors point
at. Anchors alone only prove a file still exists — the hash proves the code behind the
claim is the code it was made about. Change a port by hand and the next prompt says:

```
- Kestrel binds IPAddress.Any on port 6777 [server/src/Program.cs:30]
  — STALE: this code changed since, re-read before relying on it
```

The check runs automatically on the facts about to be injected, so a stale claim can
never reach a prompt unlabelled. Only the anchored lines are hashed, so editing
elsewhere in the same file leaves unrelated facts alone, and re-observing a claim
clears the flag.

**Forgetting is deliberate.** `memory { action: "verify" }` re-checks every anchor
against the working tree; entries that no longer resolve lose confidence and retire.
`memory { action: "compact" }` also compresses overgrown threads and prunes transcripts.
`memory { action: "stats" }` reports what is held and what it costs on disk.

Sandbox escape is refused by default; set `ALLOW_OUTSIDE_WORKSPACE=1` to disable that
check (not recommended).
