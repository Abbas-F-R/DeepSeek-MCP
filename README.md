# DeepSeek Sub-Agents MCP Server

An MCP server that gives Claude Code a team of DeepSeek subagents with direct read/write
access to **whichever project it is serving**. Subagents do their file reading, searching
and writing inside the server, so only their final answer enters Claude's context.

## What it does

- **Six tools instead of thirty-four.** `agent`, `agent_control`, `memory`, `review`,
  `generate`, `analyze` — each with a `role`/`kind`/`action` discriminator. Tool schemas
  are resent on every request, so a small surface is a permanent token saving.
  Old tool names (`subagent_coder`, `review_code`, …) still work as hidden aliases.
- **Per-project isolation.** Every call is bound to one project root. File tools refuse
  any path that escapes it, so working in one repo can never touch another.
- **Per-project and per-chat memory.** Stack, quality rules, chat threads (goal, state,
  decisions, next steps) and subagent transcripts live in `<project>/.agent/` and survive
  restarts. A chat can pick up exactly where the previous one stopped.
- **Context injected server-side.** Project facts and the chat brief are added to each
  subagent's system prompt automatically — the caller never resends them.

## Install

```bash
npm install
npm run build
```

Set the API key once, in this server's `.env` (never in a project's `.mcp.json`):

```env
DEEPSEEK_API_KEY=your_actual_key
DEEPSEEK_MODEL=deepseek-v4-flash
```

## Use it in another project

```bash
node /path/to/DeepseekMCP/dist/index.js --install /path/to/your/project
```

That writes `.mcp.json`, copies `SKILL.md` to `.claude/skills/deepseek-subagents/`, and
gitignores `.agent/sessions/`. Restart Claude Code in that project afterwards.

One server process per project is the recommended setup — each gets its own root, memory
and sessions.

### How the project root is decided

The root is **never written into `.mcp.json`**. Claude Code launches the server with the
project directory as its working directory, and the server resolves the root from there,
walking up to the nearest `.git`, `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`
or `.sln`. A moved, renamed or cloned project keeps working with no config change.

Precedence, if you ever need to override it:

1. `project_root` argument on an individual tool call
2. `PROJECT_ROOT` environment variable
3. the server's working directory (the normal path)

The resolved root is logged at startup and shown by `memory { action: "brief" }`.

### Sharing a project with someone else

The default install pins absolute paths for your machine. Add `--portable` to write a
config that is safe to commit:

```bash
node /path/to/DeepseekMCP/dist/index.js --install /path/to/your/project --portable
```

```json
{
  "mcpServers": {
    "deepseek-subagents": {
      "command": "npx",
      "args": ["-y", "github:Abbas-F-R/DeepSeek-MCP"],
      "env": { "DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}" }
    }
  }
}
```

No path in that file — not the project's, not the server's. Claude Code expands `${VAR}`
and `${VAR:-default}` in `command`, `args`, `env`, `url` and `headers`, so the only thing
whoever clones the project needs is `DEEPSEEK_API_KEY` in their own shell. To use a local
checkout instead of npx, swap in `"command": "node", "args":
["${DEEPSEEK_MCP_HOME}/dist/index.js"]`.

Commit `.mcp.json`, `.claude/skills/`, `.agent/project.json` and `.agent/chats/` — the
project rules and chat history travel with the repo. `.agent/sessions/` and `.env` stay
out of git.

### Shared SSE server (optional)

```bash
npm run start:sse
```

Then bind a project per connection: `http://localhost:3000/sse?root=/abs/path/to/project`.
Without `?root=`, every tool call must pass `project_root` explicitly.

## Working agreement

1. `memory { action: "brief" }` at the start of a chat — stack, rules, and where the last
   thread stopped.
2. `memory { action: "chat_start", title, goal }` — get a chat id, pass it on later calls.
3. Delegate: `agent { role: "coder", task: "..." }`. Pass `session` to continue a thread.
4. `memory { action: "chat_save", summary, next_steps, decisions }` before finishing.

`memory { action: "projects" }` lists every project on this machine with its active chat.

See [SKILL.md](SKILL.md) for the full tool contract.

## Tests

```bash
npm test            # unit + integration, no API calls (~15s)
npm run test:live   # real DeepSeek subagents in a temp sandbox project (~6 min)
```

Live tests skip themselves when no API key is configured. They run every agent
against a throwaway fixture project in `$TMPDIR`, never a real repo. To run one:

```bash
node --import tsx --test --test-name-pattern="@coder writes" tests/live/agents.test.ts
```

## Memory layout

```
<project>/.agent/project.json      stack, framework, quality rules
<project>/.agent/chats/<id>.json   goal, state, decisions, next steps, files
<project>/.agent/sessions/<id>.json subagent transcripts (gitignored)
~/.deepseek-mcp/projects.json      machine-wide project index
```

Sandbox escape is refused by default; set `ALLOW_OUTSIDE_WORKSPACE=1` to disable that
check (not recommended).
