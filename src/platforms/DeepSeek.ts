/**
 * DeepSeekExtractor — fetches a chat.deepseek.com conversation through the
 * site's internal web API and normalises its multi-fragment turns into the
 * shared conversation schema.
 *
 * Implementation pattern sourced from the reference normalisers:
 *  - buildDeepSeekActiveBranch + history fetch   → deepseek-api.js
 *  - normalizeDeepSeekConversation + helpers     → deepseek-normalize.js
 */

import { BaseExtractor } from './BaseExtractor';
import {
  Platform,
  Message,
  ContentBlockType,
  TextContentBlock,
  DeepSeekUserFileAttachment,
  DeepSeekExternalImageAttachment,
} from '../core/types';

/* ──────────────── internal types — DeepSeek / chat.deepseek.com payloads ─ */

interface DeepSeekFileFragment {
  id?:            string | number | null;
  file_name?:     string | null;
  file_size?:     number | string | null;
  signed_path?:   string | null;
  is_image?:      boolean;
  width?:         number | string | null;
  height?:        number | string | null;
}

interface DeepSeekFragment {
  type?:          string;
  content?:       string;
  elapsed_secs?:  number | string;
  files?:         DeepSeekFileFragment[];
}

interface DeepSeekRawMessage {
  message_id?:    string | number | null;
  parent_id?:     string | number | null;
  role?:          string;
  model?:         string | null;
  inserted_at?:   number | string | null;
  fragments?:     DeepSeekFragment[];
}

interface DeepSeekSession {
  id?:                  string;
  title?:               string;
  current_message_id?:  string | number | null;
  version?:             number | null;
}

interface DeepSeekBizData {
  chat_session?:   DeepSeekSession | null;
  chat_messages?:  DeepSeekRawMessage[];
}

interface DeepSeekHistoryPayload {
  code?:  number;
  msg?:   string;
  data?:  {
    biz_code?:  number;
    biz_msg?:   string;
    biz_data?:  DeepSeekBizData;
  };
}

interface DeepSeekSessionListPayload {
  code?:  number;
  data?:  {
    biz_code?:  number;
    biz_data?:  { chat_sessions?: DeepSeekSessionSummary[] };
  };
}

interface DeepSeekSessionSummary {
  id?:         string;
  title?:      string;
  updated_at?: number | string;
}

/** Normalised turn handed to the normaliser (one per role-bearing message). */
interface DeepSeekTurn {
  id:         string;
  parentId:   string | null;
  role:       'user' | 'assistant';
  model:      string | null;
  insertedAt: number | null;
  fragments:  DeepSeekFragment[];
}

/** Omission metadata applied when only part of a conversation is exported. */
interface DeepSeekOmission {
  beforeIds?:      Set<string>;
  omittedAtStart?: boolean;
  omittedAtEnd?:   boolean;
}

/* ──────────────── constants ─────────────────────────────────────────────── */

const DEEPSEEK_ORIGIN       = 'https://chat.deepseek.com';
const DEEPSEEK_HISTORY_API  = '/api/v0/chat/history_messages';
const DEEPSEEK_SESSION_API  = '/api/v0/chat_session/fetch_page';
const DEEPSEEK_PAGE_PATTERN = /^https:\/\/chat\.deepseek\.com\//i;

/* ──────────────── branch walker (from deepseek-api.js reference) ───────── */

/** Walk leaf→root via parent_id chains from the session's current_message_id. */
function buildDeepSeekActiveBranch(
  chatMessages: DeepSeekRawMessage[],
  currentMessageId: string | number | null | undefined,
): DeepSeekRawMessage[] {
  const items = Array.isArray(chatMessages) ? chatMessages : [];
  const byId  = new Map<string, DeepSeekRawMessage>(
    items
      .filter(item => item?.message_id != null)
      .map(item => [String(item.message_id), item]),
  );

  const path: DeepSeekRawMessage[] = [];
  const seen = new Set<string>();
  let current = byId.get(String(currentMessageId ?? ''));

  while (current?.message_id != null) {
    const id = String(current.message_id);
    if (seen.has(id)) break;
    seen.add(id);
    path.push(current);
    if (current.parent_id == null) break;
    current = byId.get(String(current.parent_id));
  }

  return path.reverse();
}

/** Map a raw branch to normalised turns, dropping non-conversation roles. */
function turnsFromBranch(branch: DeepSeekRawMessage[]): DeepSeekTurn[] {
  const turns: DeepSeekTurn[] = [];

  for (const item of branch) {
    const rawRole = String(item.role || '').toUpperCase();
    const role    = rawRole === 'USER' ? 'user' : rawRole === 'ASSISTANT' ? 'assistant' : 'unknown';
    if (role === 'unknown') continue;

    const inserted = Number(item.inserted_at);
    turns.push({
      id:         String(item.message_id),
      parentId:   item.parent_id == null ? null : String(item.parent_id),
      role,
      model:      item.model || null,
      insertedAt: Number.isFinite(inserted) ? inserted : null,
      fragments:  Array.isArray(item.fragments) ? item.fragments : [],
    });
  }

  return turns;
}

/** Pull the conversation id out of a chat.deepseek.com URL (/a/chat/s/<id>). */
function conversationIdFromUrl(url: string): string {
  const match = String(url || '').match(/\/a\/chat\/s\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Strip the trailing "| DeepSeek" suffix from a page title. */
function stripDeepSeekTitle(title: string): string {
  return String(title || '').replace(/\s*[|–-]\s*DeepSeek.*$/i, '');
}

/* ──────────────── page credential reader (localStorage userToken) ──────── */

/**
 * Read the page's bearer token from localStorage ("userToken" is wrapped in a
 * value object) plus the page title, for use as a title fallback.
 */
async function readPageCredentials(tabId: number): Promise<{ token: string; pageTitle: string }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => {
      let token = '';
      try {
        const stored = JSON.parse(localStorage.getItem('userToken') || 'null');
        token = typeof stored?.value === 'string' ? stored.value : '';
      } catch { token = ''; }
      return { token, pageTitle: document.title || '' };
    },
  }) as Array<{ result: { token: string; pageTitle: string } }>;

  return results?.[0]?.result ?? { token: '', pageTitle: '' };
}

/* ──────────────── normalize helpers (from deepseek-normalize.js) ───────── */

/** Convert epoch-seconds into an ISO-8601 UTC string (null when invalid). */
function secondsToIso(value: number | string | null | undefined): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/** Rewrite an uploaded image's filename as a .webp preview name. */
function previewName(name: string | null | undefined): string {
  const value = String(name || 'image').trim() || 'image';
  return /\.[^.]+$/.test(value) ? value.replace(/\.[^.]+$/, '.webp') : value + '.webp';
}

/** Escape a markdown image label. */
function markdownLabel(value: string | null | undefined, fallback = 'Image'): string {
  return String(value || fallback)
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Replace inline ![alt](https?://…) images with ![alt](attachment://id) refs
 * and collect the corresponding remote-image attachment records.
 */
function externalImageAttachments(
  text: string,
  seed: string,
): { text: string; attachments: DeepSeekExternalImageAttachment[] } {
  const attachments: DeepSeekExternalImageAttachment[] = [];
  let index = 0;
  const transformed = String(text || '').replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_full, alt: string, remoteUrl: string) => {
      index++;
      const id = `deepseek-remote-image:${seed}:${index}`;
      attachments.push({
        source:       'deepseek-remote-image',
        id,
        remoteUrl,
        sourceUrl:    remoteUrl,
        originalName: null,
        title:        alt || 'Image',
        mimeType:     'application/octet-stream',
        isImage:      true,
      });
      return `![${markdownLabel(alt)}](attachment://${encodeURIComponent(id)})`;
    },
  );
  return { text: transformed, attachments };
}

/** Map a FILE fragment's files[] into DeepSeek user-file attachment records. */
function fileAttachments(fragment: DeepSeekFragment | null | undefined): DeepSeekUserFileAttachment[] {
  return (fragment?.files || [])
    .filter(file => file?.id && file?.signed_path)
    .map(file => {
      const isImage = file.is_image === true;
      const size    = Number(file.file_size);
      const width   = Number(file.width);
      const height  = Number(file.height);
      return {
        source:               'deepseek-user-file' as const,
        id:                   String(file.id),
        signedPath:           String(file.signed_path),
        providerOriginalName: file.file_name || null,
        originalName:         isImage ? previewName(file.file_name) : (file.file_name || null),
        title:                file.file_name || null,
        mimeType:             isImage ? 'image/webp' : 'application/octet-stream',
        size:                 Number.isFinite(size) ? size : null,
        width:                Number.isFinite(width) ? width : null,
        height:               Number.isFinite(height) ? height : null,
        isImage,
      };
    });
}

/** Render a THINK fragment as a "#### Thinking (Xs)" markdown section. */
function thinkingMarkdown(fragment: DeepSeekFragment | null | undefined): string {
  const text = String(fragment?.content || '').trim();
  if (!text) return '';
  const elapsed = Number(fragment?.elapsed_secs);
  const suffix  = Number.isFinite(elapsed) ? ` (${elapsed.toFixed(1).replace(/\.0$/, '')} s)` : '';
  return `#### Thinking${suffix}\n\n${text}`;
}

/** Assemble a shared-schema Message from one normalised turn. */
function baseMessage(
  turn: DeepSeekTurn,
  id: string,
  sourceRole: string,
  content: TextContentBlock[],
  attachments: Message['attachments'],
): Message {
  return {
    id,
    parentId:    turn.parentId == null ? null : String(turn.parentId),
    role:        turn.role === 'user' ? 'user' : 'assistant',
    sourceRole,
    createdAt:   secondsToIso(turn.insertedAt),
    model:       turn.role === 'assistant' ? (turn.model || null) : null,
    content,
    attachments,
  };
}

/* ──────────────── DeepSeekExtractor class ──────────────────────────────── */

export class DeepSeekExtractor extends BaseExtractor {
  constructor() {
    super(Platform.DeepSeek);
  }

  async isValidPage(tabId: number): Promise<boolean> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url) return false;
      return DEEPSEEK_PAGE_PATTERN.test(tab.url);
    } catch { return false; }
  }

  // ── extractConversation: token + history API + branch walk ──────────

  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    const valid = await this.isValidPage(tabId);
    if (!valid) throw new Error('Not a valid DeepSeek conversation page');

    const tab = await chrome.tabs.get(tabId);
    const conversationId = conversationIdFromUrl(tab?.url || '');
    if (!conversationId) throw new Error('No active DeepSeek conversation found');

    return this.collectConversation(tabId, conversationId);
  }

  // ── getConversation: API-only (headless, reuses an open tab's session) ─

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const tab = await this.findDeepSeekTab();
    if (tab?.id == null) throw new Error('No open DeepSeek tab to authenticate with');

    return this.collectConversation(tab.id, conversationId);
  }

  // ── listConversations: pagination over /api/v0/chat_session/fetch_page ─

  async listConversations(page: number = 0, pageSize: number = 20): Promise<Record<string, unknown>[]> {
    const tab = await this.findDeepSeekTab();
    if (tab?.id == null) throw new Error('No open DeepSeek tab to authenticate with');

    const { token } = await readPageCredentials(tab.id);
    if (!token) throw new Error('DeepSeek user token is missing');

    // DeepSeek's session list is served newest-first from a single page; request
    // the newest pageSize * (page + 1) rows and slice out the requested window.
    const count = pageSize * (page + 1);
    const res   = await fetch(
      `${DEEPSEEK_ORIGIN}${DEEPSEEK_SESSION_API}?count=${encodeURIComponent(count)}`,
      {
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!res.ok) throw new Error(`DeepSeek session list GET: ${res.status}`);

    const payload  = (await res.json()) as DeepSeekSessionListPayload;
    if (payload?.code !== 0) throw new Error(`DeepSeek session list API: ${payload?.code ?? 'unknown error'}`);

    const sessions = payload?.data?.biz_data?.chat_sessions || [];
    return sessions.slice(page * pageSize, page * pageSize + pageSize).map(session => ({
      id:        session.id || null,
      title:     typeof session.title === 'string' ? session.title : '',
      createdAt: session.updated_at
                 ? new Date(Number(session.updated_at) * 1000).toISOString()
                 : null,
    }));
  }

  // ── private helpers ─────────────────────────────────────────────────

  /** Read the token, fetch history, walk the active branch and normalise. */
  private async collectConversation(tabId: number, conversationId: string): Promise<Record<string, unknown>> {
    const { token, pageTitle } = await readPageCredentials(tabId);
    if (!token) throw new Error('DeepSeek user token is missing');

    const biz     = await this.fetchHistory(conversationId, token);
    const session = biz.chat_session || null;
    if (!session || session.current_message_id == null) {
      throw new Error('No active DeepSeek conversation found');
    }

    const branch = buildDeepSeekActiveBranch(biz.chat_messages || [], session.current_message_id);
    const turns  = turnsFromBranch(branch);
    if (!turns.length) throw new Error('No active DeepSeek conversation found');

    const title = session.title || stripDeepSeekTitle(pageTitle);
    return this.normalizeConversation(conversationId, title, turns);
  }

  /** Fetch and validate the raw history payload for one conversation. */
  private async fetchHistory(conversationId: string, token: string): Promise<DeepSeekBizData> {
    const res = await fetch(
      `${DEEPSEEK_ORIGIN}${DEEPSEEK_HISTORY_API}?chat_session_id=${encodeURIComponent(conversationId)}`,
      {
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!res.ok) throw new Error(`DeepSeek history GET: ${res.status}`);

    const payload = (await res.json()) as DeepSeekHistoryPayload;
    if (payload?.code !== 0) {
      throw new Error(`DeepSeek history API: ${payload?.msg || payload?.code || 'unknown error'}`);
    }

    const envelope = payload?.data;
    if (envelope?.biz_code !== 0) {
      throw new Error(`DeepSeek history business API: ${envelope?.biz_msg || envelope?.biz_code || 'unknown error'}`);
    }

    return envelope?.biz_data || {};
  }

  /** Locate an open chat.deepseek.com tab to source the session token from. */
  private async findDeepSeekTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: `${DEEPSEEK_ORIGIN}/*` });
    return tabs.find(tab => tab.id != null) || null;
  }

  // ── Normalisation ──────────────────────────────────────────────────

  private normalizeConversation(
    conversationId: string | null,
    title: string,
    branch: DeepSeekTurn[],
    omission: DeepSeekOmission = {},
  ): Record<string, unknown> {
    const messages: Message[] = [];

    for (const turn of branch || []) {
      const turnId  = String(turn.id);
      const isUser  = turn.role === 'user';

      const requestContent:   TextContentBlock[] = [];
      const requestAttachments:  Message['attachments'] = [];
      const thinkingContent:  TextContentBlock[] = [];
      const thinkingAttachments: Message['attachments'] = [];
      const responseContent:  TextContentBlock[] = [];
      const responseAttachments: Message['attachments'] = [];
      const fileAttachmentsForTurn: Message['attachments'] = [];
      let requestSeed  = 0;
      let thinkingSeed = 0;
      let responseSeed = 0;

      for (const fragment of turn?.fragments || []) {
        const type = String(fragment?.type || '').toUpperCase();

        if (type === 'FILE') {
          fileAttachmentsForTurn.push(...fileAttachments(fragment));
          continue;
        }

        if (type === 'THINK') {
          const markdown = thinkingMarkdown(fragment);
          if (!markdown) continue;
          thinkingSeed++;
          const parsed = externalImageAttachments(markdown, `${turnId}:think:${thinkingSeed}`);
          thinkingContent.push({ type: ContentBlockType.Text, text: parsed.text, format: 'markdown' as const });
          thinkingAttachments.push(...parsed.attachments);
          continue;
        }

        if (type !== 'REQUEST' && type !== 'RESPONSE') continue;
        const raw = typeof fragment?.content === 'string' ? fragment.content : '';
        if (!raw.trim()) continue;

        if (type === 'REQUEST') {
          requestSeed++;
          const parsed = externalImageAttachments(raw, `${turnId}:request:${requestSeed}`);
          requestContent.push({ type: ContentBlockType.Text, text: parsed.text, format: 'markdown' as const });
          requestAttachments.push(...parsed.attachments);
        } else {
          responseSeed++;
          const parsed = externalImageAttachments(raw, `${turnId}:response:${responseSeed}`);
          responseContent.push({ type: ContentBlockType.Text, text: parsed.text, format: 'markdown' as const });
          responseAttachments.push(...parsed.attachments);
        }
      }

      const turnMessages: Message[] = [];

      if (isUser) {
        const attachments = [...fileAttachmentsForTurn, ...requestAttachments];
        if (requestContent.length || attachments.length) {
          turnMessages.push(baseMessage(turn, turnId, turn.role || 'user', requestContent, attachments));
        }
      } else {
        if (thinkingContent.length) {
          turnMessages.push(baseMessage(turn, `${turnId}:think`, 'assistant-thinking', thinkingContent, thinkingAttachments));
        }

        const finalAttachments = [...fileAttachmentsForTurn, ...responseAttachments];
        if (responseContent.length || finalAttachments.length) {
          turnMessages.push(baseMessage(turn, turnId, turn.role || 'assistant', responseContent, finalAttachments));
        }

        // Preserve a thinking-only assistant turn even if it unexpectedly carries
        // FILE fragments but no final RESPONSE.
        if (!responseContent.length && fileAttachmentsForTurn.length && turnMessages.length) {
          turnMessages[0].attachments.push(...fileAttachmentsForTurn);
        }
      }

      if (!turnMessages.length) continue;
      if (omission.beforeIds?.has(turnId)) turnMessages[0].omittedBefore = true;
      messages.push(...turnMessages);
    }

    if (omission.omittedAtStart && messages.length) messages[0].omittedBefore = true;
    if (omission.omittedAtEnd && messages.length) messages[messages.length - 1].omittedAfter = true;

    return {
      platform:        Platform.DeepSeek,
      conversationId:  conversationId || null,
      conversationUrl: conversationId
                       ? `${DEEPSEEK_ORIGIN}/a/chat/s/${encodeURIComponent(conversationId)}`
                       : null,
      title:           typeof title === 'string' ? title : '',
      model:           null,
      messages,
    };
  }
}
