import OpenAI from "openai";
import {
  AIProvider,
  ChatOptions,
  HealthCheckResult,
  ProviderResponse,
} from "../../types/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../logging/logger.js";
import { withRetry } from "../../utils/retry.js";

interface DeepSeekExtraParams {
  reasoning_effort?: string;
  extra_body?: { thinking: { type: "enabled" | "disabled" } };
}

export class DeepSeekProvider implements AIProvider {
  public readonly id = "deepseek";
  public readonly name = "DeepSeek AI";
  private client!: OpenAI;

  constructor() {
    this.initClient();
  }

  private initClient(): void {
    this.client = new OpenAI({
      apiKey:
        config.deepseek.apiKey || process.env.DEEPSEEK_API_KEY || "missing-key",
      baseURL: config.deepseek.baseUrl,
    });
  }

  public async health(): Promise<HealthCheckResult> {
    const apiKey = config.deepseek.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey || apiKey === "your_deepseek_api_key_here") {
      return {
        status: "down",
        providerId: this.id,
        message: "DeepSeek API Key is missing or invalid in configuration.",
      };
    }

    try {
      this.initClient();
      const models = await this.client.models.list();
      if (models && models.data && models.data.length > 0) {
        return {
          status: "ok",
          providerId: this.id,
          message: "Connected to DeepSeek API successfully.",
        };
      }
      return {
        status: "degraded",
        providerId: this.id,
        message: "Connected to DeepSeek API but model list was empty.",
      };
    } catch (error: any) {
      logger.error(`[DeepSeekProvider] Health check failed: ${error.message}`);
      return {
        status: "down",
        providerId: this.id,
        message: `Health check error: ${error.message || "Connection failed"}`,
      };
    }
  }

  public async models(): Promise<string[]> {
    return Array.from(
      new Set([
        config.deepseek.defaultModel,
        config.deepseek.defaultChatModel,
        config.deepseek.defaultReasonerModel,
        "deepseek-v4-flash",
        "deepseek-v4-pro",
      ]),
    );
  }

  public async chat(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: ChatOptions = {},
  ): Promise<ProviderResponse> {
    const startTime = Date.now();
    const model = options.model || config.deepseek.defaultModel;
    const timeoutMs = options.timeoutMs || config.orchestrator.defaultTimeoutMs;

    this.initClient();

    const formattedMessages = [...messages];
    if (options.systemPrompt && !messages.some((m) => m.role === "system")) {
      formattedMessages.unshift({
        role: "system",
        content: options.systemPrompt,
      });
    }

    const reasoningEffort =
      options.reasoningEffort ?? config.deepseek.defaultReasoningEffort;

    logger.info(
      `[DeepSeekProvider] Starting chat request with model '${model}' (${formattedMessages.length} messages)`,
    );

    return await withRetry(
      async () => {
        const payload: any = {
          model,
          messages: formattedMessages,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens,
          top_p: options.topP,
        };

        if (options.tools && options.tools.length > 0) {
          payload.tools = options.tools;
        }

        if (model.includes("reasoner")) {
          payload.reasoning_effort = reasoningEffort;
          payload.extra_body = { thinking: { type: "enabled" } };
        }

        const response = await this.client.chat.completions.create(
          payload as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming &
            DeepSeekExtraParams,
        );

        const executionTimeMs = Date.now() - startTime;
        const choice = response.choices[0];
        const content = choice?.message?.content || "";

        const messageObj = choice?.message as any;
        const reasoningContent = messageObj?.reasoning_content || undefined;
        const toolCalls = messageObj?.tool_calls || undefined;

        const usage = response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined;

        logger.info(
          `[DeepSeekProvider] Chat completed in ${executionTimeMs}ms (Model: ${model}, Tokens: ${usage?.totalTokens || "N/A"})`,
        );

        return {
          content,
          reasoningContent,
          toolCalls,
          usage,
          modelUsed: model,
          executionTimeMs,
        };
      },
      {
        maxRetries: config.orchestrator.maxRetries,
        timeoutMs,
      },
      `DeepSeek API Chat (${model})`,
    );
  }

  public async stream(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    onChunk: (chunk: string, reasoningChunk?: string) => void,
    options: ChatOptions = {},
  ): Promise<ProviderResponse> {
    const startTime = Date.now();
    const model = options.model || config.deepseek.defaultModel;

    this.initClient();

    const formattedMessages = [...messages];
    if (options.systemPrompt && !messages.some((m) => m.role === "system")) {
      formattedMessages.unshift({
        role: "system",
        content: options.systemPrompt,
      });
    }

    const reasoningEffort =
      options.reasoningEffort ?? config.deepseek.defaultReasoningEffort;

    logger.info(
      `[DeepSeekProvider] Starting stream request with model '${model}'`,
    );

    const payload: any = {
      model,
      messages: formattedMessages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stream: true,
    };

    if (model.includes("reasoner")) {
      payload.reasoning_effort = reasoningEffort;
      payload.extra_body = { thinking: { type: "enabled" } };
    }

    const streamResponse = await this.client.chat.completions.create(
      payload as OpenAI.Chat.ChatCompletionCreateParamsStreaming &
        DeepSeekExtraParams,
    );

    let fullContent = "";
    let fullReasoning = "";

    for await (const chunk of streamResponse) {
      const delta = chunk.choices[0]?.delta as any;
      const contentChunk = delta?.content || "";
      const reasoningChunk = delta?.reasoning_content || "";

      fullContent += contentChunk;
      fullReasoning += reasoningChunk;

      if (contentChunk || reasoningChunk) {
        onChunk(contentChunk, reasoningChunk || undefined);
      }
    }

    const executionTimeMs = Date.now() - startTime;

    return {
      content: fullContent,
      reasoningContent: fullReasoning || undefined,
      modelUsed: model,
      executionTimeMs,
    };
  }
}
