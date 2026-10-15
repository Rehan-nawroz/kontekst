// Core type definitions for the kontekst browser extension

export interface Conversation {
  id: string;
  title: string;
  platform: Platform;
  messages: Message[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'unknown';
  content: string;
  createdAt?: Date;
  platformId?: string;
  metadata?: Record<string, unknown>;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
  data?: Blob;
}

export type Platform = 'chatgpt' | 'claude' | 'grok' | 'deepseek';

export interface ExportOptions {
  format: 'markdown' | 'html';
  includeAttachments: boolean;
  platform: Platform;
  conversationId: string;
}

export interface ExtractionResult {
  data: Record<string, unknown>;
  status: 'success' | 'failed';
  error?: string;
}
