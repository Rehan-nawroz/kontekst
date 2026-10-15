import { Message, Attachment } from '../core/types';

export class MarkdownRenderer {
  render(messages: Message[], attachments?: Attachment[]): string {
    let markdown = '';

    // Add title header if needed
    messages.forEach(message => {
      const role = this.formatRole(message.role);
      const content = this.processContent(message.content);
      markdown += `${role}:\n\n${content}\n\n---\n\n`;
    });

    return markdown.trim();
  }

  private formatRole(role: string): string {
    switch (role) {
      case 'user':
        return '**You**';
      case 'assistant':
        return '**Assistant**';
      case 'system':
        return '**System**';
      default:
        return role;
    }
  }

  private processContent(content: string): string {
    // Process markdown-specific transformations here
    return content;
  }
}
