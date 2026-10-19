import type { Message } from '../core/types';

/** Options controlling role labels and the optional source-link header. */
export interface RenderOptions {
  /** Label printed for user messages (default "User"). */
  userLabel?: string;
  /** Label printed for assistant messages (default "Assistant"). */
  assistantLabel?: string;
  /** When set, a linked source header is emitted before the first message. */
  sourceUrl?: string | null;
}

export class HtmlRenderer {
  render(messages: Message[], options: RenderOptions = {}): string {
    let html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Chat Export</title>\n<style>\n  body { font-family: system-ui, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }\n  .message { margin-bottom: 20px; padding: 15px; border-radius: 8px; }\n  .user { background-color: #f0f0f0; }\n  .assistant { background-color: #e0f7fa; }\n  .system { background-color: #fff3e0; }\n  .source { margin-bottom: 20px; font-size: 14px; }\n  .source a { color: #0284c7; }\n</style>\n</head>\n<body>\n`;

    // Optional source-link header (popup's "Include original chat link").
    if (options.sourceUrl) {
      const url = this.escapeHtml(options.sourceUrl);
      html += `  <div class="source"><a href="${url}">Original conversation</a></div>\n`;
    }

    messages.forEach(message => {
      html += `  <div class="message ${this.escapeHtml(message.role)}">\n`;
      html += `    <strong>${this.escapeHtml(this.formatHeader(message.role, options))}</strong>\n`;
      html += message.content.map(block => block.text).join('');
      html += `  </div>\n`;
    });

    html += '</body>\n</html>';
    return html;
  }

  private formatHeader(role: string, options: RenderOptions): string {
    switch (role) {
      case 'user':
        return this.label(options.userLabel, 'User');
      case 'assistant':
        return this.label(options.assistantLabel, 'Assistant');
      case 'system':
        return 'System';
      default:
        return role;
    }
  }

  /** Trimmed label, falling back when empty/whitespace. */
  private label(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
  }

  /** Escape user-controlled text (labels, URLs) for HTML output. */
  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
