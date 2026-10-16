import type { Message } from '../core/types';

export class HtmlRenderer {
  render(messages: Message[], attachments?: Message['attachments']): string {
    let html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat Export</title>
<style>
  body { font-family: system-ui, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
  .message { margin-bottom: 20px; padding: 15px; border-radius: 8px; }
  .user { background-color: #f0f0f0; }
  .assistant { background-color: #e0f7fa; }
  .system { background-color: #fff3e0; }
</style>
</head>\n<body>\n`;

    messages.forEach(message => {
      html += `  <div class="message ${message.role}">\n`;
      html += `    <strong>${this.formatHeader(message.role)}</strong>\n`;
      html += message.content.map(block => block.text).join('');
      html += `  </div>\n`;
    });

    html += '</body>\n</html>';
    return html;
  }

  private formatHeader(role: string): string {
    const headers = {
      user: 'You',
      assistant: 'Assistant',
      system: 'System',
    };
    return headers[role as keyof typeof headers] || role;
  }
}
