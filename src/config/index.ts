import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface Config {
  deepseek: {
    apiKey: string;
    baseUrl: string;
    defaultChatModel: string;
    defaultReasonerModel: string;
    defaultReasoningEffort: string;
  };
  orchestrator: {
    defaultProvider: string;
    maxParallelTasks: number;
    defaultTimeoutMs: number;
    maxRetries: number;
    logLevel: string;
  };
}

export const config: Config = {
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    defaultChatModel: process.env.DEEPSEEK_DEFAULT_CHAT_MODEL || 'deepseek-chat',
    defaultReasonerModel: process.env.DEEPSEEK_DEFAULT_REASONER_MODEL || 'deepseek-reasoner',
    defaultReasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || 'max',
  },
  orchestrator: {
    defaultProvider: process.env.DEFAULT_PROVIDER || 'deepseek',
    maxParallelTasks: parseInt(process.env.MAX_PARALLEL_TASKS || '5', 10),
    defaultTimeoutMs: parseInt(process.env.DEFAULT_TIMEOUT_MS || '120000', 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};

export function validateConfig(): void {
  const warnings: string[] = [];
  if (!config.deepseek.apiKey || config.deepseek.apiKey === 'your_deepseek_api_key_here') {
    warnings.push('DEEPSEEK_API_KEY is not set or using placeholder in .env file.');
  }

  if (warnings.length > 0) {
    console.error('⚠️  Config Warning:', warnings.join(' | '));
  }
}
