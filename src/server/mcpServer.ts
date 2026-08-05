import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { ALL_TOOLS, resolveToolCall } from '../tools/index.js';
import { TaskRouter } from '../router/TaskRouter.js';
import { initializeProviders } from '../providers/index.js';
import { logger } from '../logging/logger.js';
import { config, validateConfig } from '../config/index.js';
import { resolveWorkspace } from '../workspace/WorkspaceContext.js';

export class OrchestratorMCPServer {
  private router: TaskRouter;

  constructor() {
    validateConfig();
    initializeProviders();
    this.router = new TaskRouter();
  }

  /**
   * @param defaultRoot Project root bound to this connection. In stdio mode it
   * comes from PROJECT_ROOT/cwd; in SSE mode a client may pass `?root=` so a
   * shared server still keeps each project's files, memory and sessions apart.
   */
  private createMCPServer(defaultRoot?: string): Server {
    const server = new Server(
      { name: 'deepseek-subagents-mcp', version: '1.1.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const resolved = resolveToolCall(name, rawArgs || {});

      if (!resolved) {
        logger.error(`[MCPServer] Unknown tool '${name}'`);
        return {
          content: [{ type: 'text', text: `Error: unknown tool '${name}'. Available: ${ALL_TOOLS.map((t) => t.name).join(', ')}` }],
          isError: true,
        };
      }

      const args = { ...resolved.args };
      if (!args.project_root && defaultRoot) args.project_root = defaultRoot;

      logger.info(`[MCPServer] ${name}${name !== resolved.tool.name ? ` -> ${resolved.tool.name}` : ''} (root: ${args.project_root || 'inferred'})`);

      try {
        const output = await resolved.tool.handler(args, this.router);
        return { content: [{ type: 'text', text: output }] };
      } catch (error: any) {
        logger.error(`[MCPServer] Tool '${resolved.tool.name}' failed: ${error.message}`);
        return {
          content: [{ type: 'text', text: `Error in '${resolved.tool.name}': ${error.message || 'internal error'}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  public async start(): Promise<void> {
    const transportType = config.orchestrator.transport;
    const port = config.orchestrator.port;

    if (transportType === 'stdio') {
      // One server process per project: the root is fixed for the whole session.
      const workspace = resolveWorkspace();
      const server = this.createMCPServer(workspace.root);
      await server.connect(new StdioServerTransport());
      logger.info(`DeepSeek Subagents MCP started over stdio · project root: ${workspace.root}`);
      return;
    }

    const app = express();
    const transports = new Map<string, SSEServerTransport>();

    app.get('/sse', async (req, res) => {
      // A shared SSE server serves many projects, so the client must say which
      // one it is. `?root=` binds it per connection; otherwise every call needs
      // an explicit project_root argument.
      const requestedRoot = typeof req.query.root === 'string' ? req.query.root : undefined;
      let boundRoot: string | undefined;
      if (requestedRoot) {
        try {
          boundRoot = resolveWorkspace(requestedRoot).root;
        } catch (err: any) {
          res.status(400).send(`Invalid root: ${err.message}`);
          return;
        }
      }

      const transport = new SSEServerTransport('/messages', res);
      const server = this.createMCPServer(boundRoot);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };

      logger.info(`[MCPServer] SSE connection ${transport.sessionId} (root: ${boundRoot || 'per-call'})`);
      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        logger.warn(`[MCPServer] POST for unknown session '${sessionId}'`);
        res.status(404).send('Session not found or closed');
      }
    });

    app.post('/sse', (_req, res) => {
      res.status(405).send('Use GET /sse for the stream and POST /messages for MCP messages');
    });

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', server: 'deepseek-subagents-mcp', version: '1.1.0', activeSessions: transports.size });
    });

    app.listen(port, () => {
      logger.info(`DeepSeek Subagents MCP running over SSE at http://localhost:${port}/sse`);
      console.log(`\nDeepSeek Subagents MCP online — http://localhost:${port}/sse`);
      console.log(`Bind a project per connection with: http://localhost:${port}/sse?root=/abs/path/to/project\n`);
    });
  }
}
