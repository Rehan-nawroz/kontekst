import { BaseExtractor } from './BaseExtractor';
import { Platform, Conversation } from '../core/types';
import { HttpClient } from '../core/HttpClient';

export class GrokExtractor extends BaseExtractor {
  private httpClient: HttpClient;
  private readonly baseApiUrl = 'https://grok.com/api';

  constructor() {
    super('grok');
    this.httpClient = new HttpClient();
  }

  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    const isValid = await this.isValidPage(tabId);
    if (!isValid) {
      throw new Error('Not a valid Grok conversation page');
    }

    return {};
  }

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    // Grok API endpoint structure
    const url = `${this.baseApiUrl}/conversations/${conversationId}`;
    throw new Error('Not implemented');
  }

  async listConversations(page = 0, pageSize = 20): Promise<Record<string, unknown>[]> {
    throw new Error('Not implemented');
  }

  isValidPage(tabId: number): Promise<boolean> {
    return chrome.tabs.get(tabId).then(tab => {
      return tab.url?.startsWith('https://grok.com/') || false;
    });
  }
}
