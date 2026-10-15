import { BaseExtractor } from './BaseExtractor';
import { Platform, Conversation } from '../core/types';
import { HttpClient } from '../core/HttpClient';

export class ChatGPTExtractor extends BaseExtractor {
  private httpClient: HttpClient;
  private readonly baseApiUrl = 'https://chatgpt.com/backend-api';

  constructor() {
    super('chatgpt');
    this.httpClient = new HttpClient();
  }

  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    const isValid = await this.isValidPage(tabId);
    if (!isValid) {
      throw new Error('Not a valid ChatGPT conversation page');
    }

    // Extract auth token from current session
    const authToken = await this.getAuthSession();
    this.httpClient.buildAuthHeaders(authToken);

    return {};
  }

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const url = `${this.baseApiUrl}/conversation/${conversationId}`;
    // TODO: fetch conversation data using httpClient
    throw new Error('Not implemented');
  }

  async listConversations(page = 0, pageSize = 20): Promise<Record<string, unknown>[]> {
    // Fetch paginated conversations
    // Implementation based on ChatGPT's listing API
    throw new Error('Not implemented');
  }

  isValidPage(tabId: number): Promise<boolean> {
    // Check if the tab is visiting a ChatGPT conversation page
    return chrome.tabs.get(tabId).then(tab => {
      return tab.url?.startsWith('https://chatgpt.com/c/') || false;
    });
  }

  private async getAuthSession(): Promise<string> {
    // Fetch auth session from ChatGPT's authentication endpoint
    throw new Error('Not implemented');
  }
}
