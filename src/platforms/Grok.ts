import { BaseExtractor } from './BaseExtractor';
import { Platform, Message, ContentBlockType } from '../core/types';

/* ──────────────── internal types — Grok / X backend payloads ───────── */

interface GrokResponseItem {
  responseId:          string;
  parentResponseId?:   string | null;
  sender?:             string | null;
  createTime?:         number | string;
  message?:            string | null;
  cardAttachmentsJson?: Array<string | Record<string, unknown>>;
  fileAttachments?:    string[];
  isControl?:          boolean;
  outputChunks?:       GrokChunk[];
  model?:              string | null;
}

interface GrokConversationMetadata {
  id:                string;
  title?:             string;
  ownerName?:         string;
  lastUpdatedTime?:   number | string;
  [key: string]:     unknown;
}

interface GrokChunk {
  text?:              { text: string; channel?: string };
  render_file?:       { id: string };
  render_start?:      { id: string };
}

/* ──────────────── constants — forwarded from reference files ───────── */

const PAGE_ABORT_CONTROLLERS_KEY = '__grokExportAbortControllers';
const GROK_HISTORY_CACHE_KEY     = '__grokExportGrokHistoryItems';

/* ──────────────── branch walker (from grok-api.js reference) ───────── */

/** Walk leaf→root via parentResponseId chains; score by mounted overlap + time. */
function buildActiveBranch(
  responses: GrokResponseItem[],
  mountedIds: string[] = []
): GrokResponseItem[] {
  const items     = Array.isArray(responses) ? responses : [];
  if (!items.length) return [];

  const byId    = new Map<string, GrokResponseItem>();
  const parentIds = new Set<string>();
  for (const item of items) {
    if (!item?.responseId) continue;
    byId.set(String(item.responseId), item);
    if (item.parentResponseId) parentIds.add(String(item.parentResponseId));
  }

  const mounted = new Set(mountedIds.map(String));
  const leaves     = items.filter(i => i?.responseId && !parentIds.has(String(i.responseId)));
  const candidates = leaves.length ? leaves : items.filter(i => i?.responseId);

  const pathFor  = (leaf: GrokResponseItem): GrokResponseItem[] => {
    const path: GrokResponseItem[] = [];
    const seen      = new Set<string>();
    let curr: GrokResponseItem | undefined = leaf;
    while (curr?.responseId && !seen.has(String(curr.responseId))) {
      const rid  = String(curr.responseId);
      seen.add(rid);
      path.push(curr);
      curr = curr.parentResponseId ? byId.get(String(curr.parentResponseId)) : undefined;
    }
    return path.reverse();
  };

  let bestPath: GrokResponseItem[]   = [];
  let bestOverlap: number             = -1;
  let bestTime: number                = -Infinity;
  let bestIndex: number               = -1;

  for (const leaf of candidates) {
    const path     = pathFor(leaf);
    const overlap: number = path.reduce((c, el) => c + (mounted.has(String(el.responseId)) ? 1 : 0), 0);
    const parsed = Date.parse(String(leaf.createTime || ''));
    const time   = Number.isFinite(parsed) ? parsed : -Infinity;
    const index  = items.indexOf(leaf);
    if (overlap > bestOverlap
     || (overlap === bestOverlap && time > bestTime)
     || (overlap === bestOverlap && time === bestTime && index > bestIndex)) {
      bestPath   = path;
      bestOverlap = overlap;
      bestTime   = time;
      bestIndex  = index;
    }
  }
  return bestPath;
}

/** Derive a role string from Grok sender values. */
function roleFromSender(sender: string | null | undefined): string {
  const value = String(sender || '').toLowerCase();
  if (/human|user/.test(value)) return 'user';
  if (/assistant|model/.test(value)) return 'assistant';
  return 'unknown';
}

/* ──────────────── history hook — WS capture (from grok-history-hook.js) ─ */

function injectHistoryHook(tabId: number): Promise<void> {
  return chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => {
      const cacheKey   = '__grokExportGrokHistoryItems';
      const wrappedKey = '__grokExportGrokWebSocketWrapped';

      if ((globalThis as any)[wrappedKey]) return;
      (globalThis as any)[wrappedKey] = true;

      const cache: Map<string, { outputChunks: unknown[]; role: string | null; status: string | null }> =
        ((globalThis as any)[cacheKey] instanceof Map)
          ? ((globalThis as any)[cacheKey] as Map<string, any>)
          : new Map();

      function remember(item: Record<string, unknown>): void {
        const ev  = item?.event;
        if (ev?.type !== 'conversation.history.item') return;
        const entry   = ev.item;
        const id      = entry?.id;
        if (!id) return;
        const chunks = entry?.x_grok?.output_chunks;
        if (!Array.isArray(chunks) || !chunks.length) return;
        cache.set(String(id), { outputChunks: chunks, role: entry.role || null, status: entry.status || null });
      }

      const NativeWS  = (globalThis as any).WebSocket;
      if (typeof NativeWS !== 'function') return;

      class CachedWS extends NativeWS {
        constructor(...args: unknown[]) {
          super(...(args as Parameters<typeof WebSocket>));
          this.addEventListener('message', (evt: MessageEvent) => {
            if (typeof evt.data !== 'string') return;
            try { remember(JSON.parse(evt.data)); } catch {}
          });
        }
      }
      (globalThis as any).WebSocket = CachedWS;
    },
  });
}

/* ──────────────── attachment helpers (from grok-normalize.js reference) ─ */

function cardFromRaw(raw: string | Record<string, unknown>): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch {} }
  return null;
}

function cardId(c: Record<string, unknown>): string {
  return c?.id || c?.image_chunk?.imageUuid || '';
}

function urlFileName(url: string, fallback = ''): string | null {
  if (!url) return fallback;
  try { const p = new URL(url).pathname.split('/').filter(Boolean); return p.length ? decodeURIComponent(p[p.length - 1]) : fallback; } catch (_) { return fallback; }
}

function userAssetAttachment(assetId: string): Record<string, unknown> {
  return { source: 'grok-user-asset', id: assetId, assetId, originalName: null, title: null, mimeType: 'application/octet-stream', isImage: false };
}

function byAttachmentRef(cards: Record<string, unknown>[], id: string): string {
  const card = cards.find(c => String(cardId(c) || c.card_id || '') === id);
  if (!card?.label) return `[View ${String(id).slice(0, 8)}…]`;
  return `![${card.label.replace(/\\|[\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ').trim()}](attachment://${id})`;
}

function replaceGrokPlaceholders(text: string, cards: Record<string, unknown>[]): string {
  // Split into two replaces so each has a capturing group for attributes.
  const cardRef = (_match: string, attrs: string): string => {
    const m = attrs.match(/(?:card_id|data-id)\s*=\s*["']([^"']+)["']/i);
    return m ? byAttachmentRef(cards, m[1]) : '';
  };
  return text
    .replace(/<grok:render\b([^>]*)>[\s\S]*?<\/grok:render>/gi, cardRef)
    .replace(/<grok-card\s(?:id|data-id)\s*=\s*["']([^"']+)"\s*>[\s\S]*?<\/grok-card>/gi, (_m: string, id: string) => byAttachmentRef(cards, id));
}

function protectNestedFences(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^```\s*(?:markdown|md)\s*$/i.test(lines[i])) {
      let nestedOpen = -1;
      let nestedClose = -1;
      let outerClose  = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (nestedOpen < 0) {
          if (/^```[^`\s]/.test(lines[j])) {
            nestedOpen = j;
          } else if (/^```\s*$/.test(lines[j])) {
            // This closes the wrapping fence at position i — skip
            break;
          }
        } else if (nestedClose < 0) {
          if (/^```\s*$/.test(lines[j])) {
            nestedClose = j;
          }
        } else if (outerClose === -1 && /^```\s*$/.test(lines[j])) {
          outerClose = j;
          break;
        }
      }
      // Nested fence found: wrap outer block with quadruple backticks.
      if (nestedOpen >= 0 && nestedClose >= 0 && outerClose >= 0) {
        lines[i]       = '````';
        lines[outerClose] = '````';
        i = outerClose;   // skip past the wrapped block
      }
    }
  }
  return lines.join('\n');
}

function cleanMarkdown(text: string): string {
  const stripped = text.replace(/<grok(?:-render|-card)\b[^>]*>[\s\S]*?<\/grok(?:-render|-card)>/gi, '');
  return protectNestedFences(stripped.replace(/\n{3,}/g, '\n\n').trim());
}

/* ──────────────── GrokExtractor class ───────────────────────────── */

export class GrokExtractor extends BaseExtractor {
  constructor() {
    super(Platform.Grok);
  }

  async isValidPage(tabId: number): Promise<boolean> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url) return false;
      return /^https:\/\/(www\.)?grok\.com\//.test(tab.url);
    } catch { return false; }
  }

  // ── extractConversation: DOM + API + WS flow ───────────────────────

  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    const valid = await this.isValidPage(tabId);
    if (!valid) throw new Error('Not a valid Grok conversation page');

    // 1. Visible response IDs from DOM.
    const domIds = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => [...document.querySelectorAll('[id^="response-"]')]
        .map((el: Element) => String(el.id || '').replace(/^response-/, ''))
        .filter(Boolean),
    }) as Array<{ result: string[] }>;
    const mountedIds = domIds?.[0]?.result || [];

    // 2. Discover conversationId from DOM or Performance API.
    const idResult = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        // Try URL path first.
        const m = location.pathname.match(/\/(?:c|chat|conversation)\/([0-9a-f-]{36})(?:\/|$)/i);
        if (m) return m[1];
        // Fallback: enumerate performance resource entries for conversation UUIDs.
        const resources = (performance as Performance).getEntriesByType('resource').map(e => e.name);
        for (let i = resources.length - 1; i >= 0; i--) {
          const m2 = resources[i].match(/\/rest\/app-chat\/conversations_v2\/([0-9a-f-]{36})/i);
          if (m2) return m2[1];
        }
        return '';
      },
    }) as Array<{ result: string }>;

    const conversationId = String(idResult?.[0]?.result || '').trim();
    if (!conversationId) throw new Error('No active Grok conversation found');

    // 3. Inject WebSocket hook (captures conversation.history.item frames).
    await injectHistoryHook(tabId);

    // 4. Parallel fetch: metadata + responses.
    const [metaRes, respRes] = await Promise.all([
      fetch(`/rest/app-chat/conversations_v2/${encodeURIComponent(conversationId)}?includeWorkspaces=true&includeTaskResult=true`, { credentials: 'include' }),
      fetch(`/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/responses?includeThreads=false`, { credentials: 'include' }),
    ]);

    let metadata: GrokConversationMetadata | null = null;
    if (metaRes.ok) {
      const metaJson = await metaRes.json();
      metadata = (metaJson as Record<string, unknown>)?.conversation as GrokConversationMetadata || null;
    }

    if (!respRes.ok) throw new Error(`Grok responses fetch: ${respRes.status}`);
    const respJson          = await respRes.json();
    const allResponses      = Array.isArray(((respJson as Record<string, unknown>)?.responses))
                              ? ((respJson as Record<string, unknown>)?.responses as GrokResponseItem[])
                              : [];

    const branch = buildActiveBranch(allResponses, mountedIds);
    return this.normalizeConversation(conversationId, metadata, branch);
  }

  // ── getConversation: API-only (headless) ───────────────────────────

  async getConversation(convoId: string): Promise<Record<string, unknown>> {
    const meta = await fetch(`/rest/app-chat/conversations_v2/${encodeURIComponent(convoId)}?includeWorkspaces=true&includeTaskResult=true`, { credentials: 'include' });
    if (!meta.ok) throw new Error(`Grok metadata: ${meta.status}`);
    const metaJson  = (await meta.json()) as Record<string, unknown>;
    const metadata  = (metaJson?.conversation as GrokConversationMetadata) || null;

    const resp   = await fetch(`/rest/app-chat/conversations/${encodeURIComponent(convoId)}/responses?includeThreads=false`, { credentials: 'include' });
    if (!resp.ok) throw new Error(`Grok responses: ${resp.status}`);
    const respJson  = (await resp.json()) as Record<string, unknown>;
    const branches  = Array.isArray(respJson?.responses)
                      ? (respJson?.responses as GrokResponseItem[]) : [];

    return this.normalizeConversation(convoId, metadata, branches);
  }

  // ── listConversations: pagination over /rest/app-chat/conversations_v2 ─

  async listConversations(page: number = 0, pageSize: number = 20): Promise<Record<string, unknown>[]> {
    const res   = await fetch(`/rest/app-chat/conversations_v2?offset=${page * pageSize}&limit=${pageSize}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Grok list: ${res.status}`);
    const data  = (await res.json()) as Record<string, unknown>;
    const convs = Array.isArray(data?.conversations) ? (data.conversations as GrokConversationMetadata[]) : [];
    return convs.map(c => ({
      id:        c.id       || null,
      title:     typeof c.title   === 'string' ? c.title   : '',
      createdAt: c.lastUpdatedTime
                ? new Date(Number(c.lastUpdatedTime) * 1000).toISOString()
                : null,
    }));
  }

  // ── Normalisation ──────────────────────────────────────────────────

  private normalizeConversation(
    conversationId: string,
    metadata: GrokConversationMetadata | null,
    branch: GrokResponseItem[]
  ): Record<string, unknown> {
    const messages: Message[] = [];
    let sawOmitted = false;

    // Determine which response IDs from the response list are mounted.
    const mountedAll = new Set(
      (branch.filter(t => t?.responseId).map(t => String(t.responseId)))
    );

    for (const turn of branch) {
      const sender   = String(turn.sender || '').toLowerCase();
      const role     = /human|user/.test(sender) ? 'user' : /assistant|model/.test(sender) ? 'assistant' : 'unknown';
      const id       = String(turn.responseId || '');

      // 1. Card attachments (generated_image_card, rendered_file_card, etc.)
      const cards: Record<string, unknown>[] = Array.isArray(turn.cardAttachmentsJson)
        ? turn.cardAttachmentsJson.map(cardFromRaw).filter(Boolean as any)
        : [];
      const coverIds  = new Set(cards.map(c => String(cardId(c))));

      // 2. File attachments — exclude those already represented by cards.
      const fileAtt: Record<string, unknown>[] = (turn.fileAttachments || [])
        .filter(f => !coverIds.has(f))
        .map(userAssetAttachment);

      // 3. Reconstruct text from outputChunks or fallback message field.
      let text = '';

      if (role === 'assistant' && Array.isArray(turn.outputChunks) && turn.outputChunks.length > 0) {
        let sawRespText    = false;
        const parts: string[] = [];

        for (const chunk of turn.outputChunks) {
          // Text content from the assistant response channel.
          const t = chunk?.text;
          if (t?.text != null && (!t.channel || t.channel === 'CHANNEL_ASSISTANT_RESPONSE')) {
            sawRespText     = true;
            parts.push(t.text);
            continue;
          }
          // Card / file attachment references embedded in output chunks.
          const cardIdStr    = chunk?.render_file?.id ?? chunk?.render_start?.id;
          if (cardIdStr) {
            const ref = byAttachmentRef(cards, String(cardIdStr));
            if (ref) parts.push(ref);
          }
        }

        if (sawRespText) {
          text = protectNestedFences(parts.join('').replace(/\n{3,}/g, '\n\n').trim());
        }
      }

      // Fallback: raw message field + placeholder replacement.
      const fallback  = typeof turn.message === 'string' ? turn.message : '';
      if (!text && fallback) {
        try        { text = replaceGrokPlaceholders(fallback, cards); } catch (_)   { text = fallback; }
        text = cleanMarkdown(text);
      }

      // Skip empty turns.
      if (!text?.trim() && !fileAtt.length) continue;

      // Timestamp conversion.
      let createdAt: string | null = null;
      if (typeof turn.createTime === 'string') {
        const parsed = Date.parse(turn.createTime);
        if (Number.isFinite(parsed)) createdAt = new Date(parsed).toISOString();
      } else if (typeof turn.createTime === 'number') {
        createdAt = new Date(turn.createTime * 1000).toISOString();
      }

      // Mark first message if it precedes all mounted IDs.
      sawOmitted = !mountedAll.has(id) && !messages.length;

      messages.push({
        id,
        parentId:    turn.parentResponseId || null,
        role:        role as 'user' | 'assistant',
        sourceRole:  role,
        createdAt,
        model:       role === 'assistant' ? (turn.model ?? null) : null,
        ...(sawOmitted && !messages.length ? { omittedBefore: true } : {}),
        content:     text ? [{ type: ContentBlockType.Text, text, format: 'markdown' as const }] : [],
        attachments: fileAtt,
      });

      sawOmitted = false;
    }

    return {
      platform:        Platform.Grok,
      conversationId,
      conversationUrl: `https://grok.com/c/${conversationId}`,
      title:           typeof metadata?.title === 'string' ? metadata.title : '',
      model:           null,
      messages,
    };
  }

  // ── Keep the class name for the WS hook closure ────────────────────
  private static get HISTORY_CACHE_KEY(): string { return GROK_HISTORY_CACHE_KEY; }
}
