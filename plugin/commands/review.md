---
description: Send a file, folder, or diff to DeepSeek for review, audit, or refactoring notes
---

Target: $ARGUMENTS — a path inside the project, or a description of what to look at.

Use the plugin's DeepSeek MCP tool `review` with a `path` rather than pasted code,
so the file is read inside the server and stays out of this context.

Pick the `kind`:

| kind | for |
| :--- | :--- |
| `code` | bugs and quality in one file |
| `folder` | module structure and cross-file dependencies |
| `security` | OWASP/CWE issues, secrets, access control |
| `performance` | hot paths, complexity, allocation, async I/O |
| `sql` | queries, schemas, indexes, migrations |
| `architecture` | coupling, layering, scalability |
| `refactor` | a concrete rewrite proposal — set `focus` to the goal |
| `project` | code, architecture and security in parallel, merged |

For uncommitted work, run `git diff` yourself and pass the diff as `content` instead.

Report the findings ranked by severity. Drop anything the review flags that is
wrong for this codebase, and say what you dropped — a second model's output is
input, not a verdict.
