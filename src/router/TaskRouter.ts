import { TaskDefinition, TaskResult } from '../types/index.js';
import { ProviderRegistry } from '../providers/base/ProviderRegistry.js';
import { PromptManager } from '../prompts/PromptManager.js';
import { logger } from '../logging/logger.js';
import { config } from '../config/index.js';

export class TaskRouter {
  private registry: ProviderRegistry;
  private promptManager: PromptManager;

  constructor() {
    this.registry = ProviderRegistry.getInstance();
    this.promptManager = PromptManager.getInstance();
  }

  public async executeTask(task: TaskDefinition): Promise<TaskResult> {
    const startTime = Date.now();
    const providerId = task.providerId || config.orchestrator.defaultProvider;
    logger.info(`[TaskRouter] Executing task '${task.name}' (${task.id}) via provider '${providerId}'`);

    try {
      const provider = this.registry.getProvider(providerId);

      // Load system/prompt content
      const renderedPrompt = this.promptManager.loadPrompt(task.promptTemplate, task.variables);

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'user', content: renderedPrompt },
      ];

      const response = await provider.chat(messages, {
        model: task.model,
        ...task.options,
      });

      const executionTimeMs = Date.now() - startTime;

      return {
        taskId: task.id,
        taskName: task.name,
        toolName: task.toolName,
        providerId,
        modelUsed: response.modelUsed,
        success: true,
        response,
        executionTimeMs,
      };
    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;
      logger.error(`[TaskRouter] Task '${task.name}' failed: ${error.message}`);

      return {
        taskId: task.id,
        taskName: task.name,
        toolName: task.toolName,
        providerId,
        modelUsed: task.model || 'unknown',
        success: false,
        error: error.message || 'Task execution error',
        executionTimeMs,
      };
    }
  }

  public async executeParallel(tasks: TaskDefinition[]): Promise<TaskResult[]> {
    logger.info(`[TaskRouter] Launching parallel execution for ${tasks.length} tasks`);
    const results: TaskResult[] = [];

    // Chunk tasks based on MAX_PARALLEL_TASKS
    const chunkSize = config.orchestrator.maxParallelTasks;
    for (let i = 0; i < tasks.length; i += chunkSize) {
      const chunk = tasks.slice(i, i + chunkSize);
      const chunkPromises = chunk.map((task) => this.executeTask(task));

      const settled = await Promise.allSettled(chunkPromises);
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          results.push(item.value);
        } else {
          logger.error(`[TaskRouter] Parallel execution promise rejected: ${item.reason}`);
        }
      }
    }

    logger.info(`[TaskRouter] Completed parallel execution of ${tasks.length} tasks`);
    return results;
  }
}
