#!/usr/bin/env node
import { OrchestratorMCPServer } from './server/mcpServer.js';
import { installIntoProject } from './cli/install.js';
import { logger } from './logging/logger.js';

async function main() {
  const args = process.argv.slice(2);

  const installIndex = args.indexOf('--install');
  if (installIndex !== -1) {
    const target = args[installIndex + 1] && !args[installIndex + 1].startsWith('-') ? args[installIndex + 1] : undefined;
    installIntoProject(target, args.includes('--portable') ? 'portable' : 'local');
    return;
  }

  try {
    const server = new OrchestratorMCPServer();
    await server.start();
  } catch (error: any) {
    logger.error(`Fatal error starting DeepSeek Subagents MCP Server: ${error.message || error}`);
    process.exit(1);
  }
}

main();
