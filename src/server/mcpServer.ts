import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS } from '../tools/index.js';
import { TaskRouter } from '../router/TaskRouter.js';
import { initializeProviders } from '../providers/index.js';
import { logger } from '../logging/logger.js';
import { validateConfig } from '../config/index.js';

export class OrchestratorMCPServer {
  private server: Server;
  private router: TaskRouter;

  constructor() {
    // 1. Validate environment configuration
    validateConfig();

    // 2. Initialize Providers (DeepSeek and future extensions)
    initializeProviders();

    // 3. Instantiate Task Router
    this.router = new TaskRouter();

    // 4. Initialize MCP Server instance
    this.server = new Server(
      {
        name: 'ai-orchestrator-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.info('[MCPServer] Received ListTools request');
      return {
        tools: ALL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    });

    // Execute requested tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.info(`[MCPServer] Received CallTool request for tool '${name}'`);

      const tool = ALL_TOOLS.find((t) => t.name === name);
      if (!tool) {
        logger.error(`[MCPServer] Tool '${name}' not found`);
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error: Unknown tool '${name}'. Available tools: ${ALL_TOOLS.map((t) => t.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const outputMarkdown = await tool.handler(args || {}, this.router);
        return {
          content: [
            {
              type: 'text',
              text: outputMarkdown,
            },
          ],
        };
      } catch (error: any) {
        logger.error(`[MCPServer] Error executing tool '${name}': ${error.message}`);
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error executing tool '${name}': ${error.message || 'Internal Server Error'}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  public async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('🚀 AI Orchestrator MCP Server started successfully over stdio transport.');
  }
}
