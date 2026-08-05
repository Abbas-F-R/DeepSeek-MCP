#!/usr/bin/env node
import { SubagentServer } from './server/server.js';
import { logger } from './logging/logger.js';

async function main() {
  try {
    await new SubagentServer().start();
  } catch (error: any) {
    logger.error(`Fatal error starting DeepSeek Subagents: ${error.message || error}`);
    process.exit(1);
  }
}

main();
