import { Finding, MergedReport, SeverityLevel, TaskResult } from '../types/index.js';
import { logger } from '../logging/logger.js';

export class ResultMerger {
  public static merge(results: TaskResult[]): MergedReport {
    logger.info(`[ResultMerger] Merging results from ${results.length} tasks`);

    let totalExecutionTimeMs = 0;
    let totalTokensUsed = 0;
    let successfulTasks = 0;
    let failedTasks = 0;

    const rawTaskOutputs: Array<{
      taskName: string;
      toolName: string;
      content: string;
      reasoningContent?: string;
      executionTimeMs: number;
    }> = [];

    const findings: Finding[] = [];

    for (const result of results) {
      totalExecutionTimeMs += result.executionTimeMs;

      if (result.success && result.response) {
        successfulTasks++;
        if (result.response.usage) {
          totalTokensUsed += result.response.usage.totalTokens;
        }

        rawTaskOutputs.push({
          taskName: result.taskName,
          toolName: result.toolName,
          content: result.response.content,
          reasoningContent: result.response.reasoningContent,
          executionTimeMs: result.executionTimeMs,
        });

        // Extract findings from content
        const extracted = this.extractFindingsFromText(result.response.content, result.toolName);
        findings.push(...extracted);
      } else {
        failedTasks++;
        rawTaskOutputs.push({
          taskName: result.taskName,
          toolName: result.toolName,
          content: `❌ Task Failed: ${result.error || 'Unknown error'}`,
          executionTimeMs: result.executionTimeMs,
        });
      }
    }

    // Deduplicate findings by title & description similarity
    const uniqueFindings = this.deduplicateFindings(findings);

    // Count findings by severity
    const countBySeverity: Record<SeverityLevel, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
    };

    for (const finding of uniqueFindings) {
      countBySeverity[finding.severity] = (countBySeverity[finding.severity] || 0) + 1;
    }

    // Generate Markdown report
    const markdownReport = this.generateMarkdownReport(
      results.length,
      successfulTasks,
      failedTasks,
      totalExecutionTimeMs,
      totalTokensUsed,
      countBySeverity,
      uniqueFindings,
      rawTaskOutputs
    );

    return {
      summary: {
        totalTasks: results.length,
        successfulTasks,
        failedTasks,
        totalExecutionTimeMs,
        totalTokensUsed,
        findingsCountBySeverity: countBySeverity,
      },
      findings: uniqueFindings,
      rawTaskOutputs,
      markdownReport,
    };
  }

  private static extractFindingsFromText(text: string, sourceTool: string): Finding[] {
    const findings: Finding[] = [];
    const lines = text.split('\n');

    let currentFinding: Partial<Finding> | null = null;

    for (const line of lines) {
      const severityMatch = line.match(/\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]/i);
      if (severityMatch) {
        if (currentFinding && currentFinding.title) {
          findings.push(this.normalizeFinding(currentFinding, sourceTool));
        }

        const severity = severityMatch[1].toUpperCase() as SeverityLevel;
        const title = line.replace(/\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]/gi, '').replace(/^[#*\s\-:]+/, '').trim();

        currentFinding = {
          category: sourceTool,
          severity,
          title: title || 'Identified Issue',
          description: '',
        };
      } else if (currentFinding) {
        currentFinding.description = (currentFinding.description || '') + '\n' + line;
      }
    }

    if (currentFinding && currentFinding.title) {
      findings.push(this.normalizeFinding(currentFinding, sourceTool));
    }

    return findings;
  }

  private static normalizeFinding(partial: Partial<Finding>, sourceTool: string): Finding {
    return {
      id: `finding-${Math.random().toString(36).substring(2, 9)}`,
      category: partial.category || sourceTool,
      severity: partial.severity || 'MEDIUM',
      title: partial.title || 'General Finding',
      description: (partial.description || '').trim(),
      sourceTool,
    };
  }

  private static deduplicateFindings(findings: Finding[]): Finding[] {
    const seen = new Set<string>();
    const result: Finding[] = [];

    for (const f of findings) {
      const key = `${f.severity}-${f.title.toLowerCase().substring(0, 40)}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(f);
      }
    }

    // Sort by severity priority: CRITICAL -> HIGH -> MEDIUM -> LOW -> INFO
    const priorityOrder: Record<SeverityLevel, number> = {
      CRITICAL: 1,
      HIGH: 2,
      MEDIUM: 3,
      LOW: 4,
      INFO: 5,
    };

    return result.sort((a, b) => priorityOrder[a.severity] - priorityOrder[b.severity]);
  }

  private static generateMarkdownReport(
    totalTasks: number,
    successfulTasks: number,
    failedTasks: number,
    executionTimeMs: number,
    tokensUsed: number,
    severityCounts: Record<SeverityLevel, number>,
    findings: Finding[],
    rawOutputs: Array<{ taskName: string; toolName: string; content: string; reasoningContent?: string; executionTimeMs: number }>
  ): string {
    let md = `# 🤖 AI Orchestrator Unified Analysis Report\n\n`;

    md += `## 📊 Executive Summary\n`;
    md += `- **Tasks Executed**: ${totalTasks} (${successfulTasks} Succeeded, ${failedTasks} Failed)\n`;
    md += `- **Total Execution Time**: ${(executionTimeMs / 1000).toFixed(2)} seconds\n`;
    if (tokensUsed > 0) {
      md += `- **Tokens Consumed**: ${tokensUsed.toLocaleString()}\n`;
    }
    md += `- **Findings Summary**: 🔴 ${severityCounts.CRITICAL} Critical | 🟠 ${severityCounts.HIGH} High | 🟡 ${severityCounts.MEDIUM} Medium | 🔵 ${severityCounts.LOW} Low | ℹ️ ${severityCounts.INFO} Info\n\n`;

    if (findings.length > 0) {
      md += `## ⚠️ Identified Key Findings & Issues\n\n`;
      for (const f of findings) {
        const badge = f.severity === 'CRITICAL' ? '🔴 CRITICAL' : f.severity === 'HIGH' ? '🟠 HIGH' : f.severity === 'MEDIUM' ? '🟡 MEDIUM' : '🔵 LOW';
        md += `### ${badge}: ${f.title}\n`;
        md += `**Category**: \`${f.category}\` | **Tool**: \`${f.sourceTool}\`  \n\n`;
        if (f.description) {
          md += `${f.description}\n\n`;
        }
      }
    }

    md += `## 📝 Detailed Task Outputs\n\n`;
    for (const output of rawOutputs) {
      md += `### Task: ${output.taskName} (${output.toolName})\n`;
      md += `*Execution time: ${(output.executionTimeMs / 1000).toFixed(2)}s*\n\n`;
      
      if (output.reasoningContent) {
        md += `<details>\n<summary>🧠 DeepSeek Reasoning Process</summary>\n\n${output.reasoningContent}\n\n</details>\n\n`;
      }
      
      md += `${output.content}\n\n---\n\n`;
    }

    return md;
  }
}
