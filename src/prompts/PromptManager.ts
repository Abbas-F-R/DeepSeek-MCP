import fs from 'fs';
import path from 'path';
import { logger } from '../logging/logger.js';
import { PACKAGE_ROOT } from '../config/index.js';

export class PromptManager {
  private static instance: PromptManager;
  private promptsDir: string;
  private cache: Map<string, string> = new Map();

  private constructor() {
    const pkgPrompts = path.resolve(PACKAGE_ROOT, 'prompts');
    const cwdPrompts = path.resolve(process.cwd(), 'prompts');

    if (fs.existsSync(pkgPrompts)) {
      this.promptsDir = pkgPrompts;
    } else if (fs.existsSync(cwdPrompts)) {
      this.promptsDir = cwdPrompts;
    } else {
      this.promptsDir = pkgPrompts;
    }
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
      if (fs.existsSync(filePath)) {
        template = fs.readFileSync(filePath, 'utf-8');
        this.cache.set(fileName, template);
        logger.info(`[PromptManager] Loaded prompt template '${fileName}' into cache`);
      } else {
        logger.warn(`[PromptManager] Prompt file not found: ${filePath}. Using inline default template.`);
        template = `Task Prompt:\n{{spec}}\n{{content}}\n{{context}}`;
      }
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

