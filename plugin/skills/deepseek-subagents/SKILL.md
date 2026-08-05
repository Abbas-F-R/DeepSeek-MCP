---
name: deepseek-subagents
description: Delegate engineering work to DeepSeek subagents that read and write the current project directly. Six tools (agent, agent_control, memory, review, generate, analyze) over a self-filling markdown memory — facts about the codebase are captured after every run, so a thread survives restarts and never leaks between projects.
---

# DeepSeek Subagents

Claude Code stays the coordinator. Subagents run out of process with their own tools on
the project's filesystem, so their intermediate steps never enter your context — only
the final answer does.

## Contract

1. **One `project_root` per call.** Omit it and the server uses `PROJECT_ROOT` (set by
   `.mcp.json`) or its cwd. Only pass it explicitly when you mean a different project.
2. **One `chat` thread per conversation.** Open it once; pass the id afterwards.
3. **Do not resend project facts or history.** The server injects the project directive
   and chat brief into every subagent's system prompt. Repeating them costs tokens twice.
4. **Do not paste code you are asking about.** Pass `path` (review/analyze) or let the
   subagent read the files itself. Use `context` only for material not on disk.
5. **Resume with `session`.** Same subagent, same thread, no re-explaining.

## Start of a chat

```
memory { action: "brief", query: "what you are about to work on" }
memory { action: "chat_start", title: "...", goal: "..." }   -> chat-2026-08-05-a1b2
```
`query` selects which remembered facts come back. Omit it and you get the project
shape and the last thread, but none of the codebase facts — with a full store that
is the difference between a brief and a dump.

Mid-task, ask for what you need: `memory { action: "recall", query: "jwt expiry" }`.

## End of a work block — always

Write it as a handoff to whoever resumes, not as a diary:

```
memory { action: "chat_save", chat: "<id>",
         summary: "where we stand now",
         constraints: ["..."],           // limits the work must respect
         next_steps: ["..."],            // replaces the list
         decisions: ["..."],             // appended
         critical: ["..."],              // exact values not to guess again
         open_questions: ["..."] }       // appended
```
`constraints` and `critical` are the two that get skipped and then missed: what
may not break, and the exact ports, paths and signatures a resumed run would
otherwise re-derive. `status: "done"` closes the thread. Without this call the
next chat starts blind.

## Tools

| Tool | Use |
| :--- | :--- |
| `agent` | Run a subagent. `role`: explore, scout, general, coder, security, sql, custom |
| `agent_control` | `action`: list, status, stop, persona |
| `memory` | `action`: brief, recall, project, rule, rule_remove, set, rescan, remember, chat_start, chat_save, chat_get, chat_list, verify, compact, stats, projects |
| `review` | `kind`: code, folder, project, sql, architecture, security, performance, refactor |
| `generate` | `kind`: code, files, sql, tests, tests_inline, docs, project, seed — returns file blocks, writes nothing |
| `analyze` | `kind`: explain, summarize, document, repo |

## Roles and permissions

| Role | Tools | Use for |
| :--- | :--- | :--- |
| `explore` | read, list, search | locate code, map structure |
| `scout` | read, list, search | manifests, APIs, dependency versions |
| `general` | read, list, search | root-cause analysis, multi-step reasoning |
| `security` | read, list, search | OWASP/CWE audit, secret hunting |
| `coder` | + write, edit, delete | implement, refactor, fix |
| `sql` | + write, edit | schema, migrations, query tuning |
| `custom` | configurable | own `system_prompt` and `allowed_tools` |

Every path is resolved against the project root. Anything outside it is refused.

## What subagents cannot see

- **Credential files are refused by every tool**, reads and writes alike — `.env*`,
  `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.netrc`, cloud credentials, `secrets.*`,
  `terraform.tfstate`. Not configurable: anything a subagent reads is sent to the model
  provider. Templates (`.env.example`) and public keys stay readable. If a task needs a
  secret value, ask the user for it.
- **Ignored paths** — build output, dependencies and caches by default, plus whatever
  `.gitignore` and `.agentignore` say. `.agentignore` uses gitignore syntax and is the
  place to exclude big fixtures, generated code or vendored trees.
- **Oversized files** — reads over 2 MB are refused with a pointer to `search_files`;
  files over 1 MB are skipped when searching.

Dot-directories like `.github` and `.claude` **are** searchable; only the ignore rules
decide.

## Examples

```
agent { role: "explore", task: "Where is auth middleware defined and what calls it?" }

agent { role: "coder", chat: "chat-2026-08-05-a1b2",
        task: "Add refresh-token rotation to src/auth/. Match existing error handling." }

agent { session: "coder-msf98hb5", task: "Now add tests for the rotation path." }

review { kind: "security", path: "src/auth" }

generate { kind: "files", spec: "Orders module: repository, service, DTOs, controller",
           architecture: "Clean Architecture" }
```

## Cost notes

- `verbose: true` returns the reasoning trace. Off by default because it is large.
- `max_steps` (default 8) caps tool round trips inside a subagent. Running out no
  longer wastes the run — the subagent is forced to answer from what it gathered.
- A subagent's own history is shaped before every model call, cheapest layer first:
  oversized tool results are capped, old ones are pruned to a reference, and only
  if it is still over 85% of the window does a summary get written. Measured on a
  run that read five large files: 37,007 to 15,007 tokens, same answer.
- Response headers report time, tool calls and token usage per session; `agent_control
  { action: "list" }` shows the running total per project.

## Memory

Plain markdown under `<project>/.agent/memory/`, so it is readable, diffable, and
travels with the repo:

| File | Layer | Retrieval |
| :--- | :--- | :--- |
| `FACTS.md` | what is true about the code, one claim per line with `file:line` | ranked by relevance to your query |
| `RULES.md` | how work is done here | always injected |
| `chats/<id>.md` | what happened, thread by thread | newest first |
| `ARCHIVE.md` | retired facts, kept recoverable | — |
| `sessions/<id>.txt` | raw transcripts, pruned after 14 days | — |

**It fills itself.** After every subagent run a cheap DeepSeek pass extracts durable
facts and merges them deterministically — a repeat claim reinforces, a changed value
supersedes, nothing already stored is overwritten by the model. Set
`MEMORY_AUTOCAPTURE=0` to turn capture off.

**Hand edits are caught.** Each fact stores a hash of its anchored lines. Edit that
code yourself and the fact comes back marked `STALE: this code changed since` — the
check runs automatically on whatever is about to be injected, so a claim about code
you have since rewritten never arrives dressed as fact. Subagents cannot run anything,
so **you** run the tests and feed failures back; never assume generated code works.

Facts decay: `memory { action: "verify" }` re-checks every anchor against the working
tree, weakens what no longer resolves and archives what falls below the floor.
`memory { action: "compact" }` does that plus compressing overgrown threads and
pruning transcripts. `memory { action: "stats" }` shows what is being held.

A machine-wide index at `~/.deepseek-mcp/PROJECTS.md` answers
`memory { action: "projects" }`.

Legacy tool names (`subagent_coder`, `review_code`, `generate_files`, …) still work —
they are aliased server-side and no longer listed, so they cost no schema tokens.
