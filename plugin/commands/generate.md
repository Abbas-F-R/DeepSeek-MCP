---
description: Have DeepSeek write a bounded file, module, or test suite
---

Task: $ARGUMENTS

Pick one of two paths and say which you chose.

**Write it directly** — use the `agent` tool with `role: "coder"` when the work
touches existing code and must match it. The subagent reads the neighbouring
files first, then writes. Pass the active `chat` id. It reports the files it
touched; verify the important ones with Read afterwards.

**Return content for review** — use the `generate` tool when the output is new,
self-contained, and you want to see it before it lands:

- `kind`: `code` (one file) · `files` (a module) · `tests` · `docs` · `sql` ·
  `project` (scaffold) · `seed`
- `spec`: the full specification — purpose, inputs and outputs, behaviour, dependencies
- add `language`, `framework`, `architecture`, `target_folder` when they are not
  obvious from the project

`generate` never writes to disk; save the returned blocks yourself.

Before delegating, make the spec concrete. A vague spec produces a file that has
to be rewritten, which costs more than writing it directly. If the task needs
judgement about existing architecture rather than volume of code, do it yourself
and say why.
