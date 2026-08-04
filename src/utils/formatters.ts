/**
 * Utility functions for text formatting and processing
 */

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Approximate estimation: ~4 characters per token
  return Math.ceil(text.length / 4);
}

export function cleanMarkdown(markdown: string): string {
  if (!markdown) return '';
  return markdown.trim();
}

export function truncateText(text: string, maxLength: number = 2000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n...[Truncated, total ${text.length} chars]`;
}
