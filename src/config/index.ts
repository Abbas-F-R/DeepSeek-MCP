import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package root directory (works in both src/ and dist/)
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

// Load environment variables from package root .env, then process.cwd() .env as fallback
const packageEnvPath = path.resolve(PACKAGE_ROOT, '.env');
if (fs.existsSync(packageEnvPath)) {
  dotenv.config({ path: packageEnvPath });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const configuredModel = process.env.DEEPSEEK_MODEL || process.env.DEEPSEEK_DEFAULT_CHAT_MODEL || 'deepseek-v4-flash';

/** Plugin version, read from the package manifest so it cannot drift. */
export const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface Config {
  deepseek: {
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
    defaultChatModel: string;
    defaultReasonerModel: string;
    defaultReasoningEffort: string;
    /** Token budget a subagent's history is shaped against. */
    contextWindow: number;
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
    defaultModel: configuredModel,
    defaultChatModel: configuredModel,
    defaultReasonerModel: process.env.DEEPSEEK_DEFAULT_REASONER_MODEL || configuredModel,
    defaultReasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || 'max',
    contextWindow: parseInt(process.env.DEEPSEEK_CONTEXT_WINDOW || '128000', 10),
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
    warnings.push('DEEPSEEK_API_KEY is not set or using placeholder. Please set it in server .env file.');
  }

  if (warnings.length > 0) {
    console.error('⚠️  Config Warning:', warnings.join(' | '));
  }
}

