import { OrchestratorMCPServer } from './server/mcpServer.js';
import { logger } from './logging/logger.js';

async function main() {
  try {
    const server = new OrchestratorMCPServer();
    await server.start();
  } catch (error: any) {
    logger.error(`Fatal error starting AI Orchestrator MCP Server: ${error.message || error}`);
    process.exit(1);
  }
}

main();
