# DeepSeek Subagents — Claude Code plugin

Delegate bounded coding sub-tasks — generate a file, write a test suite, audit a
folder, find where something lives — to DeepSeek subagents that read and write the
project directly. Their file reads, searches and tool loops happen out of process,
so only the final answer reaches Claude's context.

## Install

```
/plugin marketplace add Abbas-F-R/DeepSeek-MCP
/plugin install deepseek-subagents@deepseek-subagents
```

Then put your key in your own shell profile — it is read from the environment, not
from any file in the repo:

```bash
export DEEPSEEK_API_KEY=...
```

Restart Claude Code (or `/reload-plugins`) afterwards.

## Commands

| Command | Does |
| :--- | :--- |
| `/deepseek-subagents:brief` | Load project memory, open or resume a chat thread |
| `/deepseek-subagents:delegate` | Route a side task to the right subagent — or keep it |
| `/deepseek-subagents:generate` | Write a file, module, or test suite |
| `/deepseek-subagents:review` | Review, audit, or propose a refactor for a path |
| `/deepseek-subagents:explore` | Find code and answer structure questions |
| `/deepseek-subagents:save` | Record where this chat stopped |

The tools (`agent`, `agent_control`, `memory`, `review`, `generate`, `analyze`) are
also available directly; the commands are shortcuts with the routing rules baked in.

## What it is good at

Reading- and volume-heavy work: locating code across many files, auditing a folder,
scaffolding a module, generating tests or docs, mechanical refactors.

## What it is not for

Judgement about your architecture, one- or two-file edits, and anything faster to do
directly than to specify. DeepSeek output is input to Claude, not a verdict — a
`coder` run should always be followed by reading the files it touched.

## Memory

Each project keeps its own state in `<project>/.agent/memory/`, as plain markdown you
can read and diff:

- `FACTS.md` — what is true about this codebase, one claim per line with the
  `file:line` that backs it
- `RULES.md` — conventions this project holds you to
- `chats/<id>.md` — one file per thread: goal, state, decisions, next steps
- `ARCHIVE.md` — retired facts, kept recoverable
- `sessions/<id>.txt` — raw transcripts, pruned after 14 days

Nothing is shared between projects.

**The store fills itself.** After every subagent run, a cheap DeepSeek pass pulls
durable facts out of the answer and merges them with deterministic code — a repeat
claim reinforces the existing one, a changed value supersedes it, and the model never
rewrites the file wholesale. Facts that stop resolving to real code lose confidence
and eventually retire to the archive.

Retrieval is by relevance, not by dumping: `/deepseek-subagents:brief` and every
subagent prompt inject only the facts that rank for the task at hand, so the store
does not get more expensive as it gets more useful.

Commit `.agent/memory/` if you want the project's knowledge to travel with the repo;
the default `.gitignore` treats it as local state.

## Note while the v2 branch is open

`.mcp.json` currently pins `github:Abbas-F-R/DeepSeek-MCP#moamal/refactoring/v2`.
Once that branch merges, drop the `#moamal/refactoring/v2` suffix so the plugin
tracks the default branch.
