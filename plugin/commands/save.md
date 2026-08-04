---
description: Record where this chat stopped so the next session resumes from it
---

Call the plugin's DeepSeek MCP tool `memory` with `{"action": "chat_save"}` and fill in:

- `summary`: where the work stands right now, one or two sentences
- `next_steps`: what should happen next — this **replaces** the stored list, so
  drop the steps that are already done
- `decisions`: choices made this session that future sessions must respect (appended)
- `open_questions`: anything still unresolved (appended)
- `status`: `done` when the thread is finished, otherwise leave it active

Base the content on what actually happened in this conversation, not on
$ARGUMENTS alone — treat $ARGUMENTS as extra notes to fold in.

Confirm with one line: the chat id and the number of next steps stored.
