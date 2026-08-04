---
name: deepseek-subagents
description: Delegate engineering work to DeepSeek subagents that read and write the current project directly. Six tools (agent, agent_control, memory, review, generate, analyze) with per-project and per-chat memory, so a thread survives restarts and never leaks between projects.
---

# DeepSeek Subagents

Claude Code stays the coordinator. Subagents run inside the MCP server with their own
tools on the project's filesystem, so their intermediate steps never enter your context —
only the final answer does.

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
memory { action: "brief" }                       -> stack, rules, active chat, where we stopped
memory { action: "chat_start", title: "...", goal: "..." }   -> chat-2026-08-05-a1b2
```

## End of a work block — always

```
memory { action: "chat_save", chat: "<id>",
         summary: "where we stand now",
         next_steps: ["..."],            // replaces the list
         decisions: ["..."],             // appended
         open_questions: ["..."] }       // appended
```
`status: "done"` closes the thread. Without this call the next chat starts blind.

## Tools

| Tool | Use |
| :--- | :--- |
| `agent` | Run a subagent. `role`: explore, scout, general, coder, security, sql, custom |
| `agent_control` | `action`: list, status, stop, persona |
| `memory` | `action`: brief, project, rule, set, rescan, chat_start, chat_save, chat_get, chat_list, projects |
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
- `max_steps` (default 8) caps tool round trips inside a subagent.
- Response headers report time, tool calls and token usage per session; `agent_control
  { action: "list" }` shows the running total per project.

## Memory layout

`<project>/.agent/project.json` (stack + rules) · `chats/<id>.json` (threads) ·
`sessions/<id>.json` (transcripts, gitignored). A machine-wide index at
`~/.deepseek-mcp/projects.json` answers `memory { action: "projects" }`.

Legacy tool names (`subagent_coder`, `review_code`, `generate_files`, …) still work —
they are aliased server-side and no longer listed, so they cost no schema tokens.
