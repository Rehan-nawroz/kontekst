import type { ContentBlock, Message } from '../core/types';

/** Options controlling role labels and the optional source-link header. */
export interface RenderOptions {
  /** Label printed for user messages (default "User"). */
  userLabel?: string;
  /** Label printed for assistant messages (default "Assistant"). */
  assistantLabel?: string;
  /** When set, a **Source:** link header is emitted before the first message. */
  sourceUrl?: string | null;
}

export class MarkdownRenderer {
  render(messages: Message[], options: RenderOptions = {}): string {
    let markdown = '';

    // Optional source-link header (popup's "Include original chat link").
    if (options.sourceUrl) {
      markdown += `**Source:** [${options.sourceUrl}](${options.sourceUrl})\n\n---\n\n`;
    }

    messages.forEach(message => {
      const role = this.formatRole(message.role, options);
      const content = this.processContent(message.content);
      markdown += `${role}:\n\n${content}\n\n---\n\n`;
    });

    return markdown.trim();
  }

  private formatRole(role: string, options: RenderOptions): string {
    switch (role) {
      case 'user':
        return `**${this.label(options.userLabel, 'User')}**`;
      case 'assistant':
        return `**${this.label(options.assistantLabel, 'Assistant')}**`;
      case 'system':
        return '**System**';
      default:
        return role;
    }
  }

  /** Trimmed label, falling back when empty/whitespace. */
  private label(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
  }

  private processContent(content: ContentBlock[]): string {
    // Process markdown-specific transformations here
    return content.map(block => block.text).join('');
  }
}
