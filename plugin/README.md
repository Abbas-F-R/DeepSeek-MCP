# DeepSeek Subagents — Claude Code plugin

Delegate bounded coding sub-tasks — generate a file, write a test suite, audit a
folder, find where something lives — to DeepSeek subagents that read and write the
project directly. Their file reads, searches and tool loops happen inside the MCP
server, so only the final answer reaches Claude's context.

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

The MCP tools (`agent`, `agent_control`, `memory`, `review`, `generate`, `analyze`)
are also available directly; the commands are shortcuts with the routing rules
baked in.

## What it is good at

Reading- and volume-heavy work: locating code across many files, auditing a folder,
scaffolding a module, generating tests or docs, mechanical refactors.

## What it is not for

Judgement about your architecture, one- or two-file edits, and anything faster to do
directly than to specify. DeepSeek output is input to Claude, not a verdict — a
`coder` run should always be followed by reading the files it touched.

## Memory

Each project keeps its own state in `<project>/.agent/`: detected stack and quality
rules, one file per chat thread (goal, state, decisions, next steps), and subagent
transcripts. Nothing is shared between projects. `/deepseek-subagents:brief` at the
start of a session replaces re-reading the codebase to remember where you stopped.

Commit `.agent/project.json` and `.agent/chats/`; `.agent/sessions/` is gitignored.

## Note while the v2 branch is open

`.mcp.json` currently pins `github:Abbas-F-R/DeepSeek-MCP#moamal/refactoring/v2`.
Once that branch merges, drop the `#moamal/refactoring/v2` suffix so the plugin
tracks the default branch.
