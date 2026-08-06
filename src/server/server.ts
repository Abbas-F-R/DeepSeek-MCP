import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS, resolveToolCall } from '../tools/index.js';
import { TaskRouter } from '../router/TaskRouter.js';
import { initializeProviders } from '../providers/index.js';
import { logger } from '../logging/logger.js';
import { VERSION, validateConfig } from '../config/index.js';
import { resolveWorkspace } from '../workspace/WorkspaceContext.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';

/**
 * The plugin's tool backend.
 *
 * One process per project, spoken to over stdio by the host agent. There is no
 * network transport and no shared instance: a project's files, memory and
 * sessions are reachable only from the process bound to that project's root,
 * which is what makes cross-project leakage impossible rather than merely
 * unlikely.
 */
export class SubagentServer {
  private router: TaskRouter;

  constructor() {
    validateConfig();
    initializeProviders();
    this.router = new TaskRouter();
  }

  /** @param defaultRoot Project root bound to this process, from PROJECT_ROOT or cwd. */
  private createServer(defaultRoot: string): Server {
    const server = new Server({ name: 'deepseek-subagents', version: VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const resolved = resolveToolCall(name, rawArgs || {});

      if (!resolved) {
        logger.error(`[Server] Unknown tool '${name}'`);
        return {
          content: [
            {
              type: 'text',
              text: `Error: unknown tool '${name}'. Available: ${ALL_TOOLS.map((t) => t.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const args = { ...resolved.args };
      if (!args.project_root) args.project_root = defaultRoot;

      logger.info(
        `[Server] ${name}${name !== resolved.tool.name ? ` -> ${resolved.tool.name}` : ''} (root: ${args.project_root})`
      );

      try {
        const output = await resolved.tool.handler(args, this.router);
        return { content: [{ type: 'text', text: output }] };
      } catch (error: any) {
        logger.error(`[Server] Tool '${resolved.tool.name}' failed: ${error.message}`);
        return {
          content: [{ type: 'text', text: `Error in '${resolved.tool.name}': ${error.message || 'internal error'}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  /**
   * Stop the moment the host does.
   *
   * A run keeps executing after the request that started it returns, which is
   * the point — but it means the process can be holding live subagents when the
   * chat closes. Every way that can happen ends here: stdin EOF is the normal
   * one (the host closed the pipe), the signals cover a killed process.
   *
   * The handler is synchronous and idempotent, because anything deferred to a
   * microtask may never run once the event loop is being torn down.
   */
  private installShutdownHooks(): void {
    const orchestrator = Orchestrator.getInstance();
    let done = false;

    const shutdown = (reason: string, exit: boolean) => {
      if (done) return;
      done = true;
      orchestrator.shutdown(reason);
      if (exit) process.exit(0);
    };

    process.stdin.on('end', () => shutdown('the host closed the connection', true));
    process.stdin.on('close', () => shutdown('the host closed the connection', true));
    process.on('SIGINT', () => shutdown('interrupted', true));
    process.on('SIGTERM', () => shutdown('terminated', true));
    // Flushing run files is the last useful thing this process can do, so it
    // happens even on an orderly exit.
    process.on('beforeExit', () => shutdown('the process is exiting', false));
  }

  public async start(): Promise<void> {
    const workspace = resolveWorkspace();
    const server = this.createServer(workspace.root);
    this.installShutdownHooks();
    await server.connect(new StdioServerTransport());
    logger.info(`DeepSeek Subagents ${VERSION} started · project root: ${workspace.root}`);
  }
}
