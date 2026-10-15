import { BaseExtractor } from './BaseExtractor';
import { Platform, Conversation } from '../core/types';

export class ClaudeExtractor extends BaseExtractor {
  private readonly baseApiUrl = 'https://claude.ai/api';

  constructor() {
    super('claude');
  }

  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    const isValid = await this.isValidPage(tabId);
    if (!isValid) {
      throw new Error('Not a valid Claude conversation page');
    }

    return {};
  }

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const url = `${this.baseApiUrl}/conversation/${conversationId}`;
    // TODO: fetch conversation data using httpClient
    throw new Error('Not implemented');
  }

  async listConversations(page = 0, pageSize = 20): Promise<Record<string, unknown>[]> {
    throw new Error('Not implemented');
  }

  isValidPage(tabId: number): Promise<boolean> {
    return chrome.tabs.get(tabId).then(tab => {
      return tab.url?.startsWith('https://claude.ai/') || false;
    });
  }
}
