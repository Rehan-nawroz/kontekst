import { BaseExtractor } from './BaseExtractor';
import { Platform, Message, Conversation, ContentBlockType } from '../core/types';
import { HttpClient } from '../core/HttpClient';

// ──────────────── internal types — Claude backend payloads ───────────────

interface ClaudeChatMessage {
  uuid: string;
  parent_message_uuid?: string | null;
  sender?: string;
  model?: string;
  created_at?: number | string;
  content: Array<ClaudeContentBlock>;
}

interface ClaudeConversationPayload {
  uuid: string;
  name?: string;
  chat_messages?: ClaudeChatMessage[];
  current_leaf_message_uuid?: string;
  model?: string;
  role?: string;
}

type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

interface ClaudeToolUseBlock {
  type: 'tool_use';
  name: string;
  is_mcp_app?: boolean;
}

interface ClaudeToolResultBlock {
  type: 'tool_result';
  content: Array<ClaudeContentItem>;
}

type ClaudeContentItem =
  | ClaudeLocalResource
  | ClaudeImageGallery;

interface ClaudeLocalResource {
  type: 'local_resource';
  file_path: string;
  name?: string;
  uuid?: string;
  mime_type?: string;
}

interface ClaudeImageGallery {
  type: 'image_gallery';
  images: Array<{ url?: string; title?: string; id?: string; page_url?: string }>;
}

// ──────────────── WebSocket event capture (from reference) ────────────────

const WS_CAPTURE_KEY = '__kontekptExportClaudeWebSocketCaptureV3';
const CAPTURE_TIMEOUT_MS = 60_000;

/**
 * Inject code into the page to intercept all new WebSocket constructors,
 * capturing every frame's data and forwarding it via chrome.runtime.postMessage.
 * Pattern sourced from the reference API capture logic.
 */
function injectWebSocketCapture(tabId: number): Promise<void> {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [WS_CAPTURE_KEY, CAPTURE_TIMEOUT_MS],
    func: (registryKey: string, timeoutMs: number) => {
      if ((globalThis as Record<string, unknown>)[registryKey]) return;

      const capturedState: {
        convCount: number;
        msgsPerConv: Map<string, ClaudeChatMessage[]>;
      } = {
        convCount: 0,
        msgsPerConv: new Map(),
      };

      // Snapshot existing connections.
      function captureExistingWebSocket(url: string): void {
        try {
          const ws = new (window as unknown as Record<string, unknown> & { WebSocket: typeof WebSocket }).WebSocket(url) as WebSocket;
          ws.addEventListener('message', (event: MessageEvent) => {
            processFrame(event.data);
          });
        } catch {}
      }

      function processFrame(rawData: string): void {
        if (typeof rawData !== 'string') return;
        try {
          const data = JSON.parse(rawData);
          const updatePayload = transformUpdateToConversationState(data);
          const convId = typeof updatePayload.uuid === 'string' ? updatePayload.uuid : '';
          if (!convId) return;

          const msgs = updatePayload.chat_messages || [];
          for (const msg of msgs) {
            if (!(msg && typeof msg === 'object')) continue;
            const messageId = (msg.uuid as string);
            if (messageId && messageIds.add(messageId)) {
              capturedState.convCount++;
              capturedState.msgsPerConv.set(convId, [...msgs]);
              window.parent.postMessage({ type: registryKey + ':update', state: JSON.stringify(capturedState), payload: JSON.stringify(updatePayload) }, '*');
            }
          }

          if (typeof updatePayload.current_leaf_message_uuid === 'string') {
            capturedState.convCount++;
            capturedState.msgsPerConv.set(convId, [...msgs]);
            window.parent.postMessage({ type: registryKey + ':update', state: JSON.stringify(capturedState), payload: JSON.stringify(updatePayload) }, '*');
          }

          // Capture metadata changes on conversation object itself.
          if ('uuid' in data && !('chat_messages' in data)) {
            const convUpdate = convertRawUpdateToObject(data);
            capturedState.convCount++;
            window.parent.postMessage({ type: registryKey + ':update', state: JSON.stringify(capturedState), payload: JSON.stringify(convUpdate) }, '*');
          }
        } catch {}
      }

      const messageIds = new Set<string>();

      function convertRawUpdateToObject(rawUpdate: Record<string, unknown>): { uuid?: string; name?: string; [k: string]: unknown } {
        const result: { uuid?: string; name?: string; [k: string]: unknown } = {};
        if ('uuid' in rawUpdate) result.uuid = String(rawUpdate['uuid']);
        if ('name' in rawUpdate) result.name = String(rawUpdate['name']);
        for (const key of Object.keys(rawUpdate)) {
          if (!result.hasOwnProperty(key)) {
            const val = rawUpdate[key];
            if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') result[key] = val;
          }
        }
        return result;
      }

      function transformUpdateToConversationState(rawUpdate: Record<string, unknown>): Partial<ClaudeConversationPayload> {
        const conv: Partial<ClaudeConversationPayload> = convertRawUpdateToObject(rawUpdate);
        if (!rawUpdate['chat_messages']) return conv as ClaudeConversationPayload;
        conv.chat_messages = (rawUpdate['chat_messages'] as Array<Record<string, unknown>>).map((m) => {
          const msg: Partial<ClaudeChatMessage> = {};
          ['uuid', 'parent_message_uuid', 'role', 'sender', 'model'].forEach(k => { if (k in m && typeof (m as any)[k] === 'string') msg[k] = (m as Record<string, unknown>)[k]; });
          if ('created_at' in m) { const v = (m as Record<string, unknown>)['created_at']; if (v != null) { const n = Number(v); msg.created_at = Number.isFinite(n) ? n : v; } }
          const contentBlocks: ClaudeContentBlock[] = [];
          for (const block of (m.content || []) as Array<Record<string, unknown>> | undefined || []) {
            if (!block.type) continue;
            if ((block.type as string) === 'tool_use' && typeof (block.name as string) === 'string') { contentBlocks.push({ type: 'tool_use', name: block.name }); }
            else if (block.type === 'text') contentBlocks.push(block);
          }
          msg.content = contentBlocks;
          return msg as ClaudeChatMessage;
        });
        conv.chat_messages = (conv.chat_messages || []).filter(Boolean);
        return conv as ClaudeConversationPayload;
      }

      // Hook WebSocket constructor.
      const OriginalWebSocket = window.WebSocket;
      (window as unknown as Record<string, unknown>).WebSocket = class extends OriginalWebSocket {
        constructor(url: string | URL, ...args: unknown[]) {
          super(url, ...(args as [string, object?]));
          if (typeof url === 'string') captureExistingWebSocket(url);
          this.addEventListener('message', (e) => processFrame((e as MessageEvent).data));
        }
      };

      // Intercept fetch for `/v2/conversations` responses.
      const originalFetch = window.fetch;
      (window as unknown as Record<string, unknown>).fetch = function (url: string | RequestInfo | URL, init?: RequestInit): Promise<Response> {
        return originalFetch(url, init).then(async response => {
          try {
            if (response.url && response.url.includes('/v2/conversations')) {
              const text = await response.text();
              let parsed: unknown;
              try { parsed = JSON.parse(text); } catch { parsed = null; }
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) transformUpdateToConversationState(parsed as Record<string, unknown>);
            }
          } catch {}
          return response;
        }).catch(err => Promise.reject(err));
      };
    },
  });
}

/**
 * Capture all custom SVG widgets from claudeMCP iframe elements across every frame.
 * Pattern sourced from the reference visual-capture logic (visualize:show_widget tool).
 */
function injectVisualWidgetCapture(tabId: number): Promise<Array<unknown>> {
  const token = crypto.randomUUID();
  const CAPTURE_KEY_V3 = '__chatgptExportClaudeVisualCaptureV3';
  const SHOW_WIDGET_TOOL = 'visualize:show_widget';

  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    args: [token, CAPTURE_KEY_V3, SHOW_WIDGET_TOOL],
    func: (captureToken: string, captureKeyV3: string, visualToolName: string) => {
      // 1. Detect MCP iframe hostnames.
      const mcpIframes = [...document.querySelectorAll('iframe')];
      if (!mcpIframes.length) return [];
      let mcpFound = false;
      for (const frame of mcpIframes) {
        try {
          const src = String(frame.getAttribute('src') || '');
          if (/^(?:^|\.)claudemcpcontent\.com$/i.test(new URL(src).hostname)) { mcpFound = true; break; }
        } catch {}
      }
      if (!mcpFound) return [];

      // 2. Set up message listener to collect SVG results back.
      const capturedSVGs: Array<{ rowIndex: number; svg: string; width: number; height: number }> = [];
      let done = false;

      function handleMessage(event: MessageEvent): void {
        if (event.data?.type !== 'chatgpt-export-claude-visual' || String(event.data.token) !== captureToken) return;
        const svg = typeof event.data.svg === 'string' ? event.data.svg : '';
        if (!svg) return;
        capturedSVGs.push({ rowIndex: Number(event.data.rowIndex) || 0, svg, width: Number(event.data.width) || 0, height: Number(event.data.height) || 0 });

        const state = (globalThis as Record<string, unknown>)[captureKeyV3] ||= { handler: handleMessage, scrollPositions: [] };
        const elementsWithPositions = (state.scrollPositions || []) as Array<{ element: Element; left: number; top: number }>;
        try { window.scrollTo(0, 60000); } catch {}

        let lastTop = -9_0000;
        captureAllVisualsOnPageForExport(function (svgResult: Record<string, unknown> | undefined) {
          if (!svgResult) return;
          const svgContent = typeof svgResult.svg === 'string' ? svgResult.svg : '';
          capturedSVGs.push({ rowIndex: Number(svgResult.rowIndex) || 0, svg: svgContent, width: Number(svgResult.width || 0), height: Number(svgResult.height || 0) });

          if ((function () { const el = elementsWithPositions?.at(-1); return (event as any).view === el?.element.ownerDocument.defaultView; })()) lastTop = -9_0000;
          else {
            try { event.target.ownerDocument.defaultView?.scrollTo(0, Number(lastTop) + 60000); } catch {}
            try { event.currentTarget.ownerDocument.defaultView?.scrollTo(0, Number(lastTop) + 60000); } catch {}
            lastTop = Math.floor(Number(lastTop) + 60000);
          }
        });

        if (capturedSVGs.length > 0 || elementsWithPositions.length > 100) { done = true; if ((state as any).handler) window.removeEventListener('message', (state as any).handler); delete globalThis[captureKeyV3]; }
      }

      window.addEventListener('message', handleMessage);
      setTimeout(() => { done = true; if ((globalThis as Record<string, unknown>)[captureKeyV3]) window.removeEventListener('message', ((globalThis as Record<string, unknown>)[captureKeyV3] as any).handler); delete globalThis[captureKeyV3]; }, 70_000);

      // 3. For each message that contains the show_widget tool_use or tool_result:
      const byId = new Map((window.ClaudeConversationData?.chat_messages || []).map((m) => [m.uuid, m]));
      const messages: Array<{ uuid: string; content: Array<Record<string, unknown>> }> = [];
      const seen = new Set<string>();
      let id = window.ClaudeConversationData?.current_leaf_message_uuid || (window as Record<string, unknown>).__claudeLeafMessageUUID;
      while (id && !seen.has(id)) {
        seen.add(id);
        const message = byId.get(id) ?? (window as Record<string, unknown>)[id];
        if (!message) break;
        messages.push(message);
        if (typeof (message.parent_message_uuid) !== 'string' || !message.parent_message_uuid || String(message.parent_message_uuid) === '00000000-0000-4000-8000-000000000000') break;
        id = message.parent_message_uuid || '';
      }
      messages.reverse();

      const targets = messages.map((message, rowIndex) => {
        const blocks: ClaudeContentBlock[] | undefined = message.content?.filter((b): b is ClaudeContentBlock => typeof b === 'object');
        if (!blocks) return null;
        const toolUses = (blocks as ClaudeToolUseBlock[]).filter(b => (typeof b.name === 'string' && b.name === visualToolName && (b.is_mcp_app !== false))).length;
        const results = blocks.filter((b): b is ClaudeToolResultBlock => (b.type === 'tool_result' && (b as unknown as Record<string, unknown>).name === visualToolName)).length;
        const count = toolUses || results;
        return count > 0 ? { rowIndex, count } : null;
      }).filter(Boolean) as Array<{ rowIndex: number; count: number }>;

      async function captureRound(): Promise<void> {
        if (!targets.length) return;
        for (const target of targets.slice(0, 5)) try {
          await window.scrollTo({ top: document.body.scrollHeight * (target(rowIndex / (targets?.length || 1)), behavior: 'smooth' });
          await new Promise(r => setTimeout(r, 2_000));
        } catch {}

        for (const frame of mcpIframes) try {
          const rect = frame.getBoundingClientRect();
          if (!(rect.width > 0 && rect.height > 50)) continue;
          const windowRef = frame.contentWindow || frame.contentDocument?.defaultView;
          await new Promise<void>(resolve => {
            setTimeout(resolve, 1_000);
            try { (windowRef as any)?.scrollTo(0, Math.max(windowRef?.innerHeight || 0, document.body.scrollHeight)); } catch {}
            if (!mcpFound) return setTimeout(() => resolve(), 1_500);
          });

          for (const visualTarget of targets) try {
            const results = await captureVisualForMessage(target(rowIndex), target.contentWindow || frame.contentDocument?.defaultView, message.rowIndex ?? visualTarget.rowIndex);
            if (!results) return;
            for (const svg of results) {
              await new Promise(r => setTimeout(r, 1_000));
              windowRef?.postMessage({ type: 'chatgpt-export-claude-visual', rowIndex: Number(target(rowIndex)) || visualTarget.rowIndex, svg, width: Math.round((svg as Element)?.getBoundingClientRect().width) || 500, height: Math.round((svg as Element)?.getBoundingClientRect().height) || 500 }, '*');
            }
          }
        } catch {}
      }

      captureRound();

      // --- nested helpers (for iframe frame world serialization) ---

      function captureAllVisualsOnPageForExport(onCaptured: (result: Record<string, unknown> | string) => void): void { ... };
      async function captureVisualForMessage(msgEl: Element, ifrmWin: Window | null, messageRowIndex: number): Promise<void> { ... }

      return []; // outer wrapper will use collected SVGs via window messaging.
    },
  });
}

// ──────────── branch walking (Claude) ───────────────────

/**
 * Walk chat_messages from current_leaf_message_uuid back to root,
 * building a Map of messageId → chronological index.
 */
function activeBranchIndexByMessageId(data: ClaudeConversationPayload): Map<string, number> {
  const byId = new Map((data.chat_messages || []).map(m => [m.uuid, m]));
  const ids: string[] = [];
  const seen = new Set<string>();
  let id = data.current_leaf_message_uuid || '';

  while (id && !seen.has(id)) {
    seen.add(id);
    const message = byId.get(id);
    if (!message) break;
    ids.push(id);
    const parent = message.parent_message_uuid;
    if (!parent || parent === '00000000-0000-4000-8000-000000000000') break;
    id = parent;
  }

  ids.reverse();
  return new Map(ids.map((messageId, index) => [messageId, index]));
}

// ──────────── normalisation (Claude) ─────────────

/** Build ContentBlock[] and Claude-compatible attachments for one message. */
function extractClaudeContent(message: ClaudeChatMessage): {
  textParts: string[];
  attachments: Array<Record<string, unknown>>;
} {
  const textParts: string[] = [];
  const attachments: Array<Record<string, unknown>> = [];

  for (const block of message.content || []) {
    // Text blocks.
    if ((block as ClaudeTextBlock).type === 'text') {
      const txt = (block as ClaudeTextBlock).text;
      if (typeof txt === 'string' && txt.trim()) textParts.push(txt);
      continue;
    }

    // Tool result blocks → attachments.
    if (!(block as ClaudeToolResultBlock).type) continue;
    const toolResult = block as ClaudeToolResultBlock;
    if (!Array.isArray(toolResult.content)) continue;

    for (const item of toolResult.content) {
      if ((item as ClaudeLocalResource).type === 'local_resource' && typeof (item as ClaudeLocalResource).file_path === 'string') {
        const localRes = item as ClaudeLocalResource;
        const pathName = localRes.file_path.split('/').filter(Boolean).at(-1) || null;
        const itemName = typeof localRes.name === 'string' ? localRes.name.trim() : '';
        const originalName = itemName && /\.[A-Za-z0-9]{1,10}$/.test(itemName)
          ? itemName : pathName || itemName || null;
        attachments.push({ source: 'claude-local-resource', id: item.uuid || item.file_path || '', filePath: localRes.file_path, originalName, mimeType: item.mime_type || 'application/octet-stream' });
        continue;
      }

      if ((item as ClaudeImageGallery).type === 'image_gallery' && (item as ClaudeImageGallery).images?.length) {
        const gallery = item as ClaudeImageGallery;
        for (const img of gallery.images) {
          const url = typeof img.url === 'string' ? img.url.trim() : '';
          if (!url) continue;
          let pathName = '';
          try { pathName = new URL(url).pathname.split('/').filter(Boolean).at(-1) || ''; } catch {}
          const title = String(img.title || '').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Image';
          attachments.push({ source: 'claude-remote-image', id: img.id || url, remoteUrl: url, sourceUrl: img.page_url || null, originalName: title, title, mimeType: 'image/png' as const, isImage: true });
        }
      }
    }
  }

  return { textParts, attachments };
}

// ──────────── ClaudeExtractor class ─────────────

export class ClaudeExtractor extends BaseExtractor {
  private httpClient = new HttpClient();

  constructor() {
    super(Platform.Claude);
  }

  /** Check that the current tab is a Claude chat page. */
  async isValidPage(tabId: number): Promise<boolean> {
    try {
      const tabUrl = (await chrome.tabs.get(tabId)).url;
      if (!tabUrl) return false;
      // Claude conversation tabs host claude.ai or cdn.clau de/anycast.
      return /^https:\/\/(www\.)?claude\.ai\/(chat|backend-api)/i.test(tabUrl);
    } catch {
      return false;
    }
  }

  /** Extract the full conversation for a tab — captures WebSocket frames + SVG widgets. */
  async extractConversation(
    tabs: number | number[],
    selectedMessages?: Set<string>,
  ): Promise<Record<string, unknown>> {
    const tabIds = Array.isArray(tabs) ? tabs : [tabs];

    // Determine the first valid Claude tab to use as reference.
    let activeTabId: number;
    for (const tid of tabIds) {
      if (await this.isValidPage(tid)) { activeTabId = tid; break; }
    }
    if (!activeTabId) throw new Error('Not a valid Claude conversation page');

    // 1. Inject WebSocket capture → captures live frame payloads.
    await injectWebSocketCapture(activeTabId);

    // Wait for messages from injected script (captures ongoing WS frames).
    const captured = await waitForCapturedState(WS_CAPTURE_KEY, CAPTURE_TIMEOUT_MS);

    // 2. Fetch the full conversation via API (the primary data source).
    const apiPayload = await this.fetchConversationAPI(activeTabId) as ClaudeConversationPayload;

    // If the API payload is empty, fall back to captured in-page state.
    if (!apiPayload?.chat_messages?.length && Object.keys(captured).length > 0) {
      return captured as Record<string, unknown>;
    }

    // 3. Capture custom SVG widgets (visualize:show_widget via MCP iframe).
    await injectVisualWidgetCapture(activeTabId);
    const visualSVGs = await waitForCapturedVisuals();

    // 4. Walk the active branch and normalise to shared schema.
    return this.normalizeClaudeConversation(apiPayload, tabIds[selectedMessages ? Array.from(tabIds).indexOf(selectedMessages[0]) ?? 0] ?? activeTabId);
  }

  /** List conversations from Claude's backend API. */
  async listConversations(_page: number = 0, _pageSize: number = 20): Promise<Record<string, unknown>[]> {
    const sessionCookie = await this.getClaudeSessionToken();
    const apiUrl = `/backend-api/v2/conversations?offset=0&limit=${_pageSize}`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        cookie: sessionCookie!,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${(await this.getClaudeAccessToken()) || ''}`,
      },
    });

    if (!response.ok) throw new Error(`Failed to list conversations (${response.status})`);
    const data = await response.json();
    return (data.objects || []).map((c: Record<string, unknown>) => ({
      id: (c.id as string) || null,
      title: (c.name as string) || null,
      createdAt: c.created_at ? new Date(Number(c.created_at) * 1000).toISOString() : null,
    }));
  }

  /** Get a single conversation by UUID. */
  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`/backend-api/v2/conversations/${conversationId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) throw new Error(`Failed to get conversation (${response.status})`);
    const data = await response.json();
    return this.normalizeClaudeConversation(data as ClaudeConversationPayload);
  }

  // ── private helpers ───────────────────────────────────

  /** Fetch the Claude backend API conversation payload using an active session. */
  private async fetchConversationAPI(tabId: number): Promise<unknown> {
    const apiUrl = '/backend-api/v2/conversations?offset=0&limit=1';
    // Use httpClient for token caching — same pattern as reference (5-min TTL).
    return this.httpClient.fetchJSON(apiUrl);
  }

  private async normalizeClaudeConversation(data: ClaudeConversationPayload, tabId?: number): Promise<Record<string, unknown>> {
    const messages: Message[] = [];
    const activeIndexById = activeBranchIndexByMessageId(data);

    for (let i = 0; i < data.chat_messages.length; i++) {
      const message = data.chat_messages[i];
      const { textParts, attachments } = extractClaudeContent(message);
      if (!textParts?.length && !attachments?.length) continue;

      const role = message.sender === 'human' ? 'user' : 'assistant';
      const branchIndex = activeIndexById.get(message.uuid) ?? i;
      messages.push({
        id: message.uuid,
        parentId: message.parent_message_uuid || null,
        role,
        sourceRole: message.sender || role,
        createdAt: typeof message.created_at === 'string' ? message.created_at : new Date((Number(message.created_at) || 0) * 1000).toISOString(),
        model: role === 'assistant' ? (message.model || data.model || null) : null,
        content: textParts.map(text => ({ type: ContentBlockType.Text, text, format: 'markdown' as const })),
        attachments,
        ...(branchIndex === 0 ? { omittedBefore: true } : {}),
      });
    }

    return {
      platform: Platform.Claude,
      conversationId: data.uuid || null,
      conversationUrl: `https://claude.ai/chat/${data.uuid}`,
      title: typeof data.name === 'string' ? data.name : '',
      model: data.model || null,
      messages,
    };
  }

  /** Retrieve the Claude session cookie (required for /backend_api/ calls). */
  private async getClaudeSessionToken(): Promise<string | null> {
    const cookies = await chrome.cookies.get({ url: 'https://claude.ai', name: 'anthropic_token' }); // anthropic_token
    return cookies?.value || null;
  }

  /** Retrieve the Claude access token (Identity or cookie). */
  private async getClaudeAccessToken(): Promise<string | null> {
    const token = await this.httpClient.getCachedToken('claude'); // cached in HttpClient
    if (token) return token;

    try {
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      const session = await sessionRes.json() as { accessToken: string } | null;
      return session?.accessToken || null;
    } catch {
      return null;
    }
  }
}

/** Wait for captured WebSocket state messages from the injected script. */
function waitForCapturedState(registryKey: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const result: Record<string, unknown> = {};
    let done = false;

    function handleMessage(event: MessageEvent): void {
      if (done) return;
      if (event.data?.type === registryKey + ':update') {
        try {
          const state = JSON.parse(String(event.data.state || ''));
          Object.assign(result, event.data.payload);
        } catch {}
      }
    }

    window.addEventListener('message', handleMessage);
    setTimeout(() => {
      done = true;
      window.removeEventListener('message', handleMessage);
      resolve(result);
    }, timeoutMs);
  });
}

/** Wait for captured SVG widget payloads. */
function waitForCapturedVisuals(): Promise<Array<unknown>> {
  return new Promise(resolve => {
    const results: Array<Record<string, unknown>> = [];
    let done = false;

    function handleMessage(event: MessageEvent): void {
      if (done) return;
      if (event.data?.type === 'chatgpt-export-claude-visual') {
        results.push({ svg: event.data.svg || null, width: event.data.width || 0, height: event.data.height || 0 });
      } else {
        resolve([]);
      }
    }

    window.addEventListener('message', handleMessage);
    setTimeout(() => {
      done = true;
      window.removeEventListener('message', handleMessage);
      resolve(results);
    }, CAPTURE_TIMEOUT_MS + 10_000);
  });
}
