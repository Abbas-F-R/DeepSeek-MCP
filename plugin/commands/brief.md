---
description: Load the DeepSeek project memory and open or resume a chat thread
---

Call the plugin's DeepSeek MCP tool `memory` with `{"action": "brief"}`
(scoped name: `mcp__plugin_deepseek-subagents_deepseek__memory`).

It returns the project's detected stack, its stored quality rules, and the state
of the last chat thread — goal, where work stopped, decisions, next steps.

Then:

- If the brief shows an active thread that matches what we are about to do, reuse
  its chat id on later calls.
- Otherwise open a new one with `{"action": "chat_start", "title": "...", "goal": "..."}`
  using $ARGUMENTS as the goal when provided.

Report back in three lines at most: the stack, the active chat id, and the next
step recorded in it. Do not dump the raw brief.
