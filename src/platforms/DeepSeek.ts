import { BaseExtractor } from './BaseExtractor';
import { Platform, Conversation } from '../core/types';

export class DeepSeekExtractor extends BaseExtractor {
  private readonly baseApiUrl = 'https://chat.deepseek.com/api';

  constructor() {
    super('deepseek');
  }

  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    const isValid = await this.isValidPage(tabId);
    if (!isValid) {
      throw new Error('Not a valid DeepSeek conversation page');
    }

    return {};
  }

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    // DeepSeek API endpoint structure
    const url = `${this.baseApiUrl}/chat/${conversationId}`;
    throw new Error('Not implemented');
  }

  async listConversations(page = 0, pageSize = 20): Promise<Record<string, unknown>[]> {
    throw new Error('Not implemented');
  }

  isValidPage(tabId: number): Promise<boolean> {
    return chrome.tabs.get(tabId).then(tab => {
      return tab.url?.startsWith('https://chat.deepseek.com/') || false;
    });
  }
}
