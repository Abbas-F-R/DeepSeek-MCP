import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger.js';

export class PromptManager {
  private static instance: PromptManager;
  private promptsDir: string;
  private cache: Map<string, string> = new Map();

  private constructor() {
    this.promptsDir = path.resolve(process.cwd(), 'prompts');
  }

  public static getInstance(): PromptManager {
    if (!PromptManager.instance) {
      PromptManager.instance = new PromptManager();
    }
    return PromptManager.instance;
  }

  public loadPrompt(promptName: string, variables: Record<string, string> = {}): string {
    const fileName = promptName.endsWith('.md') ? promptName : `${promptName}.md`;
    const filePath = path.join(this.promptsDir, fileName);

    let template = this.cache.get(fileName);

    if (!template) {
      if (!fs.existsSync(filePath)) {
        logger.error(`[PromptManager] Prompt file not found: ${filePath}`);
        throw new Error(`Prompt template '${fileName}' not found in ${this.promptsDir}`);
      }
      template = fs.readFileSync(filePath, 'utf-8');
      this.cache.set(fileName, template);
      logger.info(`[PromptManager] Loaded prompt template '${fileName}' into cache`);
    }

    // Replace variables in template e.g. {{variable}}
    let rendered = template;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      rendered = rendered.replace(placeholder, value ?? '');
    }

    // Clean up any remaining unreplaced placeholders
    rendered = rendered.replace(/\{\{\s*\w+\s*\}\}/g, '');

    return rendered;
  }

  public clearCache(): void {
    this.cache.clear();
    logger.info('[PromptManager] Cache cleared.');
  }
}
