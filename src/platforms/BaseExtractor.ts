// Abstract base class for all platform extractors

import { Platform } from '../core/types';

export abstract class BaseExtractor {
  protected platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  // Extract conversation data from the current tab/page
  abstract extractConversation(tabId: number): Promise<Record<string, unknown>>;

  // Get the list of available conversations for this platform
  abstract listConversations(page?: number, pageSize?: number): Promise<Record<string, unknown>[]>;

  // Get a single conversation by ID
  abstract getConversation(conversationId: string): Promise<Record<string, unknown>>;

  // Validate if the current page is a supported conversation page
  abstract isValidPage(tabId: number): Promise<boolean>;

  // Get platform name for display purposes
  getPlatformName(): string {
    return this.platform.charAt(0).toUpperCase() + this.platform.slice(1);
  }

  // Common utility methods that can be overridden by subclasses
  protected buildAuthHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }
}
