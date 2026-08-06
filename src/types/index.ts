/**
 * Shared Type Definitions for AI Orchestrator MCP Server
 */

export type ProviderId = 'deepseek' | 'gemini' | 'openai' | 'qwen' | 'local' | string;

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  stream?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | string;
  tools?: any[];
  /**
   * Aborts the request in flight. Without it a cancelled run keeps paying for
   * the model call it started, and the process cannot exit until it returns.
   */
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: any[];
  usage?: TokenUsage;
  modelUsed: string;
  executionTimeMs: number;
}


export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'down';
  providerId: string;
  message?: string;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly name: string;

  health(): Promise<HealthCheckResult>;
  models(): Promise<string[]>;
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: ChatOptions
  ): Promise<ProviderResponse>;
  stream?(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onChunk: (chunk: string, reasoningChunk?: string) => void,
    options?: ChatOptions
  ): Promise<ProviderResponse>;
}

export interface TaskDefinition {
  id: string;
  name: string;
  toolName: string;
  providerId?: ProviderId;
  model?: string;
  promptTemplate: string;
  variables: Record<string, string>;
  options?: ChatOptions;
}

export interface TaskResult {
  taskId: string;
  taskName: string;
  toolName: string;
  providerId: string;
  modelUsed: string;
  success: boolean;
  response?: ProviderResponse;
  error?: string;
  executionTimeMs: number;
}

export type SeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface Finding {
  id: string;
  category: string;
  severity: SeverityLevel;
  title: string;
  description: string;
  location?: string;
  suggestion?: string;
  sourceTool: string;
}

export interface GeneratedFile {
  path: string;
  action: 'create' | 'modify';
  language?: string;
  content: string;
}

export interface GenerationResult {
  summary: string;
  architecture?: string;
  files: GeneratedFile[];
  followUps?: string[];
  parseWarning?: string;
}

export interface MergedReport {
  summary: {
    totalTasks: number;
    successfulTasks: number;
    failedTasks: number;
    totalExecutionTimeMs: number;
    totalTokensUsed: number;
    findingsCountBySeverity: Record<SeverityLevel, number>;
  };
  findings: Finding[];
  rawTaskOutputs: Array<{
    taskName: string;
    toolName: string;
    content: string;
    reasoningContent?: string;
    executionTimeMs: number;
  }>;
  markdownReport: string;
}
