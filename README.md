# 🤖 AI Orchestrator MCP Server (DeepSeek & Multi-LLM)

Production-ready Model Context Protocol (MCP) Server for delegating tasks from **Claude Code** to **DeepSeek** (`deepseek-chat` & `deepseek-reasoner`) and future LLM providers (Gemini, OpenAI, Qwen, Local LLMs).

---

## 🌟 Key Features

- **Layered Architecture**: Decoupled Tools, Router, Merger, Prompt Library, and Provider Abstraction.
- **Provider Abstraction**: Single unified `AIProvider` interface. Extendable to Gemini, OpenAI, Qwen without modifying tools or Claude Code integration.
- **DeepSeek Integration**: Full support for `deepseek-chat` and reasoning model `deepseek-reasoner`.
- **Parallel Task Execution**: Execute concurrent audits (e.g. Code + SQL + Security + Architecture) simultaneously.
- **Result Merger Engine**: Automatic deduplication, severity prioritization (`CRITICAL` -> `LOW`), and unified report generation.
- **External Prompt Library**: Markdown prompt templates stored in `prompts/*.md`.
- **20 Standalone MCP Tools**:
  - **Review & Analysis (14 Tools)**:
    - `review_code`
    - `review_folder`
    - `review_project`
    - `review_sql`
    - `review_architecture`
    - `review_security`
    - `review_performance`
    - `write_tests`
    - `generate_seed`
    - `summarize`
    - `documentation`
    - `analyze_repository`
    - `explain_code`
    - `refactor_code`
  - **Scaffolding & Code Generation (6 Tools)**:
    - `generate_code`
    - `generate_files`
    - `generate_sql`
    - `generate_tests`
    - `generate_documentation`
    - `generate_project`

---

## 🚀 Setup & Configuration

### 1. Installation

```bash
npm install
npm run build
```

### 2. Configure Environment

Create `.env` file from `.env.example`:

```env
DEEPSEEK_API_KEY=your_actual_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_DEFAULT_CHAT_MODEL=deepseek-chat
DEEPSEEK_DEFAULT_REASONER_MODEL=deepseek-reasoner
DEEPSEEK_REASONING_EFFORT=max

DEFAULT_PROVIDER=deepseek
MAX_PARALLEL_TASKS=5
DEFAULT_TIMEOUT_MS=120000
MAX_RETRIES=3
LOG_LEVEL=info
```

### 3. Integration with Claude Code (`claude_desktop_config.json` or Claude Code config)

Add the following to your MCP settings:

```json
{
  "mcpServers": {
    "ai-orchestrator": {
      "command": "node",
      "args": ["c:/Users/User/RiderProjects/DeepSeek-MCP/dist/index.js"],
      "env": {
        "DEEPSEEK_API_KEY": "your_deepseek_api_key_here"
      }
    }
  }
}
```

---

## 🛠️ Adding a New Provider (e.g. GeminiProvider)

1. Create `src/providers/gemini/GeminiProvider.ts` implementing `AIProvider`.
2. Register the new provider in `src/providers/index.ts`.
3. Set `DEFAULT_PROVIDER=gemini` or specify `"provider": "gemini"` when invoking MCP tools.

No changes to Claude Code or MCP Tool definitions are required!
