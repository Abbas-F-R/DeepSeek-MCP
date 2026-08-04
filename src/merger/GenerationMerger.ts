import { GeneratedFile, GenerationResult, TaskResult } from '../types/index.js';
import { logger } from '../logging/logger.js';

export class GenerationMerger {
  public static merge(result: TaskResult): string {
    if (!result.success || !result.response) {
      return `# 🛠️ Code Generation Failed\n\n**Task**: ${result.taskName}\n\n❌ Error: ${result.error || 'Unknown error'}\n`;
    }

    const parsed = this.parse(result.response.content);
    return this.render(result, parsed);
  }

  private static parse(rawContent: string): GenerationResult {
    const fenced = rawContent.match(/```json\s*([\s\S]*?)```/i);
    const candidates = [fenced ? fenced[1] : null, rawContent];

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const obj = JSON.parse(candidate.trim());
        return this.normalize(obj);
      } catch {
        // try next candidate
      }
    }

    logger.error('[GenerationMerger] Failed to parse generation output as JSON; falling back to raw wrap.');
    return {
      summary: 'DeepSeek did not return valid structured JSON. Raw output has been wrapped as a single unparsed file for manual review.',
      files: [
        {
          path: 'GENERATION_OUTPUT_UNPARSED.md',
          action: 'create',
          language: 'markdown',
          content: rawContent,
        },
      ],
      parseWarning: 'Output could not be parsed as the expected JSON contract.',
    };
  }

  private static normalize(obj: any): GenerationResult {
    const rawFiles = Array.isArray(obj?.files) ? obj.files : [];
    const files: GeneratedFile[] = rawFiles
      .filter((f: any) => f && typeof f.path === 'string' && typeof f.content === 'string')
      .map((f: any) => ({
        path: f.path,
        action: f.action === 'modify' ? 'modify' : 'create',
        language: typeof f.language === 'string' ? f.language : 'text',
        content: f.content,
      }));

    return {
      summary: typeof obj?.summary === 'string' ? obj.summary : 'No summary provided.',
      architecture: typeof obj?.architecture === 'string' ? obj.architecture : undefined,
      files,
      followUps: Array.isArray(obj?.followUps) ? obj.followUps.filter((s: any) => typeof s === 'string') : undefined,
    };
  }

  private static render(result: TaskResult, generation: GenerationResult): string {
    let md = `# 🛠️ Code Generation Result\n\n`;
    md += `**Task**: ${result.taskName} | **Model**: ${result.modelUsed} | **Time**: ${(result.executionTimeMs / 1000).toFixed(2)}s`;
    if (result.response?.usage) {
      md += ` | **Tokens**: ${result.response.usage.totalTokens.toLocaleString()}`;
    }
    md += `\n\n`;

    if (generation.parseWarning) {
      md += `> ⚠️ **Warning**: ${generation.parseWarning}\n\n`;
    }

    md += `## Summary\n${generation.summary}\n\n`;
    if (generation.architecture) {
      md += `**Architecture**: ${generation.architecture}\n\n`;
    }

    if (generation.files.length > 0) {
      md += `## Files (${generation.files.length})\n\n`;
      md += `| Path | Action | Lines |\n|---|---|---|\n`;
      for (const f of generation.files) {
        const lineCount = f.content.split('\n').length;
        md += `| \`${f.path}\` | ${f.action} | ${lineCount} |\n`;
      }
      md += `\n`;
    } else {
      md += `## Files\n_No files were generated._\n\n`;
    }

    if (generation.followUps && generation.followUps.length > 0) {
      md += `## Follow-ups\n`;
      for (const step of generation.followUps) {
        md += `- ${step}\n`;
      }
      md += `\n`;
    }

    md += `## Structured Output (machine-readable)\n\`\`\`json\n${JSON.stringify(generation, null, 2)}\n\`\`\`\n\n`;

    if (generation.files.length > 0) {
      md += `## File Contents\n\n`;
      for (const f of generation.files) {
        md += `<details>\n<summary>${f.action === 'modify' ? '✏️' : '🆕'} <code>${f.path}</code></summary>\n\n`;
        md += `\`\`\`${f.language || ''}\n${f.content}\n\`\`\`\n\n`;
        md += `</details>\n\n`;
      }
    }

    return md;
  }
}
