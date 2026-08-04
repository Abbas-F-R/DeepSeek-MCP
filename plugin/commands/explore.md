---
description: Send a codebase search or structure question to a read-only DeepSeek subagent
---

Delegate this question to a read-only DeepSeek subagent instead of reading files
yourself — the file reads happen inside the MCP server and never enter this context.

Call the plugin's DeepSeek MCP tool `agent`
(scoped name: `mcp__plugin_deepseek-subagents_deepseek__agent`) with:

- `role`: `explore` for code location and structure, `scout` for manifests,
  dependency versions and API contracts
- `task`: $ARGUMENTS, rewritten as a precise question that asks for `file:line`
  references in the answer
- `chat`: the active chat id if one is open

Do not pass file contents in `context` — the subagent reads the project itself.

Relay the answer as-is if it is already short. If it is long, give the file
references and the conclusion, and say the full answer is available on the session id.
