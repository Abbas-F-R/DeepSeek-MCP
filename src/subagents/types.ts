import { SubagentToolName } from './tools/workspaceTools.js';

export type SubagentRole =
  | 'explore'   // Codebase exploration, file discovery, symbol search
  | 'scout'     // Dependency, documentation, API schema inspection
  | 'general'   // Multi-step complex reasoning & problem solving
  | 'coder'     // Heavy production code generation & refactoring
  | 'security'  // Vulnerability audit, secret detection, exploit analysis
  | 'sql'       // Database schema, indexing, query plan optimization
  | 'custom'    // Dynamic persona subagent
  | string;     // Dynamically registered roles

export type SessionStatus = 'active' | 'completed' | 'cancelled' | 'error';

export interface SubagentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SubagentSession {
  sessionId: string;
  /** Project this session is bound to — sessions never cross projects. */
  projectRoot: string;
  projectSlug: string;
  /** Chat thread this session belongs to, if any. */
  chatId?: string;
  role: SubagentRole;
  personaName: string;
  systemPrompt: string;
  allowedTools: SubagentToolName[];
  status: SessionStatus;
  stepCount: number;
  totalExecutionTimeMs: number;
  usage: TokenUsage;
  touchedFiles: string[];
  lastTask?: string;
  createdAt: number;
  updatedAt: number;
  messages: SubagentMessage[];
}

export interface SubagentRunOptions {
  sessionId?: string;
  /** Absolute project root. Falls back to PROJECT_ROOT env, then cwd. */
  projectRoot?: string;
  /** Chat thread id; defaults to the project's active chat when omitted. */
  chatId?: string;
  role?: SubagentRole;
  task: string;
  context?: string;
  systemPrompt?: string;
  allowedTools?: SubagentToolName[];
  temperature?: number;
  model?: string;
  providerId?: string;
  /** Max tool-use round trips before the subagent must answer. Default 8. */
  maxSteps?: number;
}

export interface SubagentRunResult {
  sessionId: string;
  projectRoot: string;
  chatId?: string;
  role: SubagentRole;
  personaName: string;
  status: SessionStatus;
  content: string;
  reasoningContent?: string;
  modelUsed: string;
  executionTimeMs: number;
  isNewSession: boolean;
  allowedTools: SubagentToolName[];
  usage: TokenUsage;
  touchedFiles: string[];
  toolCallsMade: number;
}

export interface SubagentDefinition {
  role: string;
  personaName: string;
  systemPrompt: string;
  allowedTools: SubagentToolName[];
}
