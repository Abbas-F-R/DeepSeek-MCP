---
description: Route a side task to the right DeepSeek subagent
---

Task: $ARGUMENTS

Decide whether this belongs to DeepSeek at all, then route it.

**Delegate** when the task is bounded and reading- or volume-heavy:
locating code, auditing a folder, generating a module or a test suite, writing
documentation, mechanical refactors across files.

**Keep it** when it needs judgement about this codebase, touches one or two files,
or is faster to do directly than to specify. Say so in one line and just do it.

If delegating, call the `agent` tool with the matching role:

| role | tools | for |
| :--- | :--- | :--- |
| `explore` | read, list, search | find code, map structure |
| `scout` | read, list, search | manifests, APIs, dependency versions |
| `general` | read, list, search | root-cause analysis, multi-step reasoning |
| `security` | read, list, search | vulnerability audit |
| `coder` | + write, edit, delete | implement, refactor, fix |
| `sql` | + write, edit | schema, migrations, query tuning |

Pass the active `chat` id so the thread stays connected, and `session` to continue
an earlier subagent instead of starting cold. Do not paste project files into
`context` — the subagent reads them itself.

After a `coder` run, read the files it reports touching before you call it done.
