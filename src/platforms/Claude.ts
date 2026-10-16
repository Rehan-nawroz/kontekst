/**
 * ClaudeExtractor — fetches a claude.ai conversation through the site's
 * internal backend API, captures custom SVG widgets rendered inside MCP
 * iframes, and normalises the active message branch into the shared schema.
 *
 * Implementation pattern sourced from the reference normalisers:
 *  - getClaudeConversationInPage + organization discovery → claude-api.js
 *  - normalizeClaudeConversation + attachment helpers     → claude-normalize.js
 *  - custom visual capture (visualize:show_widget)        → claude-visual-capture.js
 */

import { BaseExtractor } from './BaseExtractor';
import { Platform, ContentBlockType } from '../core/types';
import type {
  Message,
  ClaudeRemoteImageAttachment,
  ClaudeLocalResourceAttachment,
  CloudflareClaudeAttachment,
} from '../core/types';

/* ──────────────── internal types — Claude backend payloads ─────────────── */

interface ClaudeChatMessage {
  uuid: string;
  parent_message_uuid?: string | null;
  sender?: string;
  model?: string | null;
  created_at?: number | string | null;
  content?: ClaudeContentBlock[];
}

/** Raw shape returned by /api/organizations/<org>/chat_conversations/<id>. */
interface ClaudeConversationPayload {
  uuid?: string;
  name?: string;
  model?: string | null;
  chat_messages?: ClaudeChatMessage[];
  current_leaf_message_uuid?: string | null;
  /** Injected by the visual-capture pass (see claude-visual-capture.js). */
  __customVisuals?: ClaudeCapturedVisual[];
  /** Injected when the conversation is fetched with an organization scope. */
  __organizationId?: string;
  [key: string]: unknown;
}

/** One custom SVG widget recovered from an MCP iframe. */
interface ClaudeCapturedVisual {
  rowIndex: number;
  visualIndex?: number;
  svg: string;
  width: number | null;
  height: number | null;
}

/** A transcript row that is expected to render at least one custom visual. */
interface ClaudeVisualTarget {
  rowIndex: number;
  count: number;
}

/** Omission metadata applied when only part of a conversation is exported. */
interface ClaudeOmission {
  beforeIds?: Set<string>;
  omittedAtStart?: boolean;
  omittedAtEnd?: boolean;
}

/** Page-world state shared between the visual-capture script injections. */
interface ClaudeVisualPageState {
  token: string;
  targets: ClaudeVisualTarget[];
  visuals: Map<string, ClaudeCapturedVisual>;
  scrollPositions: Array<{ element: Element; left: number; top: number }>;
  windowPosition: { left: number; top: number };
  handler: ((event: MessageEvent) => void) | null;
}

/** Custom visual attachment carrying its inline SVG payload. */
interface ClaudeCustomVisualAttachment extends CloudflareClaudeAttachment {
  /** Non-enumerable SVG source, consumed by the attachment downloader. */
  __inlineSvg?: string;
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
  content?: ClaudeContentItem[];
  name?: string;
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
  images?: ClaudeGalleryImage[];
}

interface ClaudeGalleryImage {
  url?: string;
  title?: string;
  id?: string;
  page_url?: string;
}

/** Item shape returned by the recents list endpoint (chat_conversations_v2). */
interface ClaudeConversationSummary {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

interface ClaudeConversationListPayload {
  data?: ClaudeConversationSummary[];
  has_more?: boolean;
}

/* ──────────────── constants — forwarded from reference files ───────────── */

const CLAUDE_CONVERSATION_QUERY =
  '?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=strong';

const CLAUDE_VISUAL_CAPTURE_KEY = '__chatgptExportClaudeVisualCaptureV3';
const CLAUDE_SHOW_WIDGET_TOOL = 'visualize:show_widget';
const CLAUDE_VISUAL_MESSAGE_TYPE = 'chatgpt-export-claude-visual-v3';
const CLAUDE_MCP_HOST_PATTERN = /(?:^|\.)claudemcpcontent\.com$/i;
const CLAUDE_MCP_APP_PATH = '/mcp_apps';
/** Sentinel parent id Claude uses for the first message in a conversation. */
const CLAUDE_ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

/* ──────────────── generic helpers ──────────────────────────────────────── */

/** Narrow an unknown JSON value to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Resolve after the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(() => resolve(), ms));
}

/* ──────────────── branch walking (from claude-normalize.js) ────────────── */

/** Walk chat_messages from current_leaf_message_uuid back to the root. */
function activeBranchMessages(data: ClaudeConversationPayload): ClaudeChatMessage[] {
  const byId = new Map((data.chat_messages || []).map(message => [message.uuid, message]));
  const messages: ClaudeChatMessage[] = [];
  const seen = new Set<string>();
  let id = data.current_leaf_message_uuid || '';

  while (id && !seen.has(id)) {
    seen.add(id);
    const message = byId.get(id);
    if (!message) break;
    messages.push(message);

    const parent = message.parent_message_uuid;
    if (!parent || parent === CLAUDE_ROOT_PARENT) break;
    id = parent;
  }

  return messages.reverse();
}

/** Map each active-branch message id to its chronological index. */
function activeBranchIndexByMessageId(data: ClaudeConversationPayload): Map<string, number> {
  const ids = activeBranchMessages(data).map(message => message.uuid);
  return new Map(ids.map((messageId, index) => [messageId, index]));
}

/* ──────────────── attachment helpers (from claude-normalize.js) ────────── */

/** Build a remote image attachment record from an image_gallery entry. */
function remoteImageAttachment(image: ClaudeGalleryImage): ClaudeRemoteImageAttachment | null {
  const remoteUrl = typeof image?.url === 'string' ? image.url.trim() : '';
  if (!remoteUrl) return null;

  let pathName = '';
  try {
    pathName = new URL(remoteUrl).pathname.split('/').filter(Boolean).at(-1) || '';
  } catch { pathName = ''; }

  const title = String(image?.title || 'Image')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Image';

  let decodedPathName = pathName;
  try {
    decodedPathName = decodeURIComponent(pathName);
  } catch { /* keep the raw path when it is not valid percent-encoding */ }

  const originalName = decodedPathName && /\.[A-Za-z0-9]{1,10}$/.test(decodedPathName)
    ? decodedPathName
    : title;

  const ext = (pathName.match(/\.([A-Za-z0-9]{2,5})(?:$|[?#])/i)?.[1] || '').toLowerCase();
  const mimeType: ClaudeRemoteImageAttachment['mimeType'] = ext === 'png'
    ? 'image/png'
    : ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'gif'
          ? 'image/gif'
          : 'application/octet-stream';

  return {
    source: 'claude-remote-image',
    id: image?.id || remoteUrl,
    remoteUrl,
    sourceUrl: typeof image?.page_url === 'string' ? image.page_url.trim() || null : null,
    originalName,
    title,
    mimeType,
    isImage: true,
  };
}

/** Collect text parts and attachments for one Claude message. */
function extractClaudeContent(
  message: ClaudeChatMessage,
  data: ClaudeConversationPayload,
): { textParts: string[]; attachments: Message['attachments'] } {
  const textParts: string[] = [];
  const attachments: Message['attachments'] = [];

  for (const block of message.content || []) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim()) textParts.push(block.text);
      continue;
    }

    if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;

    for (const item of block.content) {
      if (item.type === 'local_resource' && item.file_path) {
        const pathName = item.file_path.split('/').filter(Boolean).at(-1) || null;
        const itemName = typeof item.name === 'string' ? item.name.trim() : '';
        const originalName = itemName && /\.[A-Za-z0-9]{1,10}$/.test(itemName)
          ? itemName
          : pathName || itemName || null;

        attachments.push({
          source: 'claude-local-resource',
          id: item.uuid || item.file_path,
          filePath: item.file_path,
          originalName,
          mimeType: item.mime_type || 'application/octet-stream',
          conversationId: typeof data?.uuid === 'string' ? data.uuid : null,
        });
        continue;
      }

      if (item.type === 'image_gallery' && Array.isArray(item.images)) {
        for (const image of item.images) {
          const attachment = remoteImageAttachment(image);
          if (attachment) attachments.push(attachment);
        }
      }
    }
  }

  return { textParts, attachments };
}

/** Attach the custom SVG visuals that belong to one assistant message. */
function customVisualAttachments(
  data: ClaudeConversationPayload,
  messageId: string,
  activeIndexById: Map<string, number>,
): ClaudeCustomVisualAttachment[] {
  const rowIndex = activeIndexById.get(messageId);
  if (typeof rowIndex !== 'number' || !Number.isInteger(rowIndex)) return [];

  return (data.__customVisuals || [])
    .filter(item => item?.rowIndex === rowIndex && typeof item.svg === 'string' && item.svg)
    .map((item, index) => {
      const attachment: ClaudeCustomVisualAttachment = {
        source: 'claude-custom-visual',
        id: `claude-visual:${messageId}:${index}`,
        originalName: `claude-visual-${rowIndex + 1}-${index + 1}.svg`,
        mimeType: 'image/svg+xml',
        width: item.width ?? null,
        height: item.height ?? null,
        isImage: true,
      };
      Object.defineProperty(attachment, '__inlineSvg', {
        value: item.svg,
        enumerable: false,
      });
      return attachment;
    });
}

/* ──────────────── visual targets (from claude-visual-capture.js) ───────── */

/** Find the active-branch rows that are expected to render custom visuals. */
function claudeCustomVisualTargets(data: ClaudeConversationPayload): ClaudeVisualTarget[] {
  const targets: ClaudeVisualTarget[] = [];

  activeBranchMessages(data).forEach((message, rowIndex) => {
    const blocks: ClaudeContentBlock[] = Array.isArray(message?.content) ? message.content : [];

    const toolUses = blocks.filter(block =>
      block.type === 'tool_use' &&
      block.name === CLAUDE_SHOW_WIDGET_TOOL &&
      block.is_mcp_app !== false
    ).length;
    const toolResults = blocks.filter(block =>
      block.type === 'tool_result' && block.name === CLAUDE_SHOW_WIDGET_TOOL
    ).length;

    const count = toolUses || toolResults;
    if (count > 0) targets.push({ rowIndex, count });
  });

  return targets;
}

/** Merge previously captured visuals with a freshly captured batch. */
function mergeVisuals(
  existing: ClaudeCapturedVisual[],
  captured: ClaudeCapturedVisual[],
): ClaudeCapturedVisual[] {
  if (!captured.length) return existing;

  const byKey = new Map<string, ClaudeCapturedVisual>();
  const remember = (visual: ClaudeCapturedVisual): void => {
    if (typeof visual?.svg !== 'string' || !visual.svg) return;
    const visualIndex = typeof visual.visualIndex === 'number' ? visual.visualIndex : 0;
    byKey.set(`${visual.rowIndex}:${visualIndex}`, { ...visual, visualIndex });
  };

  for (const visual of existing || []) remember(visual);
  for (const visual of captured) remember(visual);

  return [...byKey.values()]
    .sort((a, b) => a.rowIndex - b.rowIndex || (a.visualIndex ?? 0) - (b.visualIndex ?? 0));
}

/* ──────────────── conversation fetch (from claude-api.js) ──────────────── */

/**
 * Fetch the raw conversation payload from inside the page, discovering the
 * organization id first so the org-scoped conversation endpoint can be used.
 */
async function fetchClaudeConversationInPage(tabId: number): Promise<ClaudeConversationPayload> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (): Promise<ClaudeConversationPayload> => {
      const match = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
      if (!match) throw new Error('No active Claude conversation found');
      const conversationId = match[1];

      const candidates: string[] = [];
      const marker = `/chat_conversations/${conversationId}`;

      // Prefer the organization id already visible in a performance entry.
      const resources = performance.getEntriesByType('resource').map(entry => entry.name);
      for (let i = resources.length - 1; i >= 0; i--) {
        try {
          const url = new URL(resources[i], location.href);
          if (!url.pathname.includes(marker)) continue;
          const parts = url.pathname.split('/');
          const orgIndex = parts.indexOf('organizations');
          if (orgIndex >= 0 && parts[orgIndex + 1]) {
            candidates.push(decodeURIComponent(parts[orgIndex + 1]));
            break;
          }
        } catch { /* ignore malformed resource entries */ }
      }

      // Fall back to the organizations endpoint.
      try {
        const orgResponse = await fetch('/api/organizations', { credentials: 'include' });
        if (orgResponse.ok) {
          const orgData: unknown = await orgResponse.json();
          const organizations: Array<Record<string, unknown>> = Array.isArray(orgData)
            ? orgData as Array<Record<string, unknown>>
            : (isRecord(orgData) && Array.isArray(orgData.organizations)
                ? orgData.organizations as Array<Record<string, unknown>>
                : []);
          for (const item of organizations) {
            const id = item?.uuid || item?.id || item?.organization_id;
            if (id) candidates.push(String(id));
          }
        }
      } catch { /* organization discovery is best-effort */ }

      const query =
        '?tree=True&rendering_mode=messages&render_all_tools=true' +
        '&include_inline_comparison=true&consistency=strong';

      for (const organizationId of [...new Set(candidates)]) {
        const response = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}` +
          `/chat_conversations/${encodeURIComponent(conversationId)}${query}`,
          { credentials: 'include' },
        );
        if (!response.ok) continue;
        const data = await response.json() as Record<string, unknown>;
        return { ...data, __organizationId: organizationId };
      }

      throw new Error('No active Claude conversation found');
    },
  });

  const data = results[0]?.result;
  if (!data || !Array.isArray(data.chat_messages) || !data.current_leaf_message_uuid) {
    throw new Error('No active Claude conversation found');
  }
  return data;
}

/* ──────────────── custom visual capture (from claude-visual-capture.js) ── */

/**
 * Capture every custom SVG widget rendered inside a claude.ai MCP iframe.
 * Each injected function is self-contained: it may only use its arguments and
 * page globals, never the module scope.
 */
async function captureClaudeCustomVisuals(
  tabId: number,
  targets: ClaudeVisualTarget[],
): Promise<ClaudeCapturedVisual[]> {
  if (!targets.length) return [];
  const token = crypto.randomUUID();

  /** Ask every MCP frame to serialise its largest SVG and post it upward. */
  const captureRound = async (): Promise<void> => {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [token],
      func: (captureToken: string) => {
        if (
          !/(?:^|\.)claudemcpcontent\.com$/i.test(location.hostname) ||
          location.pathname !== '/mcp_apps'
        ) return null;

        const candidates = [...document.querySelectorAll('svg')]
          .map(svg => ({ svg, rect: svg.getBoundingClientRect() }))
          .filter(item => item.rect.width > 100 && item.rect.height > 50)
          .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
        const source = candidates[0];
        if (!source) return null;

        const clone = source.svg.cloneNode(true) as SVGSVGElement;
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

        const properties = [
          'color',
          'fill',
          'fill-opacity',
          'stroke',
          'stroke-opacity',
          'stroke-width',
          'stroke-linecap',
          'stroke-linejoin',
          'stroke-dasharray',
          'opacity',
          'font-family',
          'font-size',
          'font-weight',
          'font-style',
          'letter-spacing',
          'text-anchor',
          'dominant-baseline',
          'visibility',
          'display',
          'paint-order',
          'vector-effect',
          'marker-start',
          'marker-mid',
          'marker-end',
        ];

        // Inline every computed presentation property so the SVG stands alone.
        const originals = [source.svg, ...source.svg.querySelectorAll<SVGElement>('*')];
        const clones = [clone, ...clone.querySelectorAll<SVGElement>('*')];
        originals.forEach((element, index) => {
          const target = clones[index];
          if (!target) return;
          const style = getComputedStyle(element);
          for (const property of properties) {
            const value = style.getPropertyValue(property);
            if (value) target.style.setProperty(property, value);
          }
        });

        for (const script of clone.querySelectorAll('script')) script.remove();
        for (const foreignObject of clone.querySelectorAll('foreignObject')) foreignObject.remove();

        // Strip event handlers and javascript: URLs.
        for (const element of [clone, ...clone.querySelectorAll('*')]) {
          for (const attr of [...element.attributes]) {
            if (/^on/i.test(attr.name)) {
              element.removeAttribute(attr.name);
              continue;
            }
            if (
              /^(?:href|xlink:href)$/i.test(attr.name) &&
              /^\s*javascript:/i.test(attr.value)
            ) {
              element.removeAttribute(attr.name);
            }
          }
        }

        const viewBox = clone.viewBox?.baseVal;
        if (viewBox?.width > 0 && viewBox?.height > 0) {
          clone.setAttribute('width', String(viewBox.width));
          clone.setAttribute('height', String(viewBox.height));
        } else {
          clone.setAttribute('width', String(Math.round(source.rect.width)));
          clone.setAttribute('height', String(Math.round(source.rect.height)));
        }

        window.parent.postMessage({
          type: 'chatgpt-export-claude-visual-v3',
          token: captureToken,
          svg: new XMLSerializer().serializeToString(clone),
          width: source.rect.width,
          height: source.rect.height,
        }, '*');
        return true;
      },
    });
  };

  /** Rows that still expect more visuals than have been captured. */
  const missingRows = async (): Promise<number[]> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [CLAUDE_VISUAL_CAPTURE_KEY, token],
      func: (registryKey: string, captureToken: string): number[] => {
        const state = (globalThis as Record<string, unknown>)[registryKey] as
          ClaudeVisualPageState | undefined;
        if (!state || state.token !== captureToken) return [];

        return [...new Set(
          state.targets
            .filter(target => {
              let count = 0;
              for (const visual of state.visuals.values()) {
                if (visual.rowIndex === target.rowIndex) count++;
              }
              return count < target.count;
            })
            .map(target => target.rowIndex),
        )];
      },
    });
    return results[0]?.result ?? [];
  };

  /** Scroll a not-yet-mounted transcript row into view. */
  const bringRowIntoView = async (rowIndex: number, settleMs: number): Promise<boolean> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [CLAUDE_VISUAL_CAPTURE_KEY, token, rowIndex, settleMs],
      func: async (
        registryKey: string,
        captureToken: string,
        targetRowIndex: number,
        delayMs: number,
      ): Promise<boolean> => {
        const state = (globalThis as Record<string, unknown>)[registryKey] as
          ClaudeVisualPageState | undefined;
        if (!state || state.token !== captureToken) return false;

        const selector = `[data-testid="transcript-row"][data-index="${targetRowIndex}"]`;
        const mountedRows = (): Array<{ row: Element; index: number }> =>
          [...document.querySelectorAll('[data-testid="transcript-row"][data-index]')]
            .map(row => ({ row, index: Number(row.getAttribute('data-index')) }))
            .filter(item => Number.isInteger(item.index))
            .sort((a, b) => a.index - b.index);

        const scrollingAncestor = (element: Element | null): Element | null => {
          for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (
              /(?:auto|scroll)/.test(style.overflowY) &&
              parent.scrollHeight > parent.clientHeight + 1
            ) return parent;
          }
          return document.scrollingElement;
        };

        const waitFrame = (): Promise<void> =>
          new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        for (let attempt = 0; attempt < 100; attempt++) {
          const row = document.querySelector(selector);
          if (row) {
            row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
            await waitFrame();
            await new Promise<void>(resolve => setTimeout(() => resolve(), delayMs));
            return true;
          }

          const rows = mountedRows();
          if (!rows.length) return false;

          const first = rows[0];
          const last = rows[rows.length - 1];
          let direction: number;
          let anchor: { row: Element; index: number };
          if (targetRowIndex < first.index) {
            direction = -1;
            anchor = first;
          } else if (targetRowIndex > last.index) {
            direction = 1;
            anchor = last;
          } else {
            anchor = rows.reduce((best, item) =>
              Math.abs(item.index - targetRowIndex) < Math.abs(best.index - targetRowIndex) ? item : best
            , rows[0]);
            direction = targetRowIndex < anchor.index ? -1 : 1;
          }

          const scroller = scrollingAncestor(anchor.row);
          if (!scroller) return false;

          const viewport = scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight;
          const step = Math.max(450, Math.round(viewport * 1.6));
          const before = scroller.scrollTop;
          scroller.scrollTop = before + direction * step;

          if (scroller.scrollTop === before) {
            anchor.row.scrollIntoView({
              block: direction < 0 ? 'start' : 'end',
              inline: 'nearest',
              behavior: 'auto',
            });
          }

          await waitFrame();
          await new Promise<void>(resolve => setTimeout(() => resolve(), 90));
        }

        return false;
      },
    });
    return results[0]?.result === true;
  };

  /** Restore scroll positions, detach the listener and return the visuals. */
  const finishCapture = async (): Promise<ClaudeCapturedVisual[]> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [CLAUDE_VISUAL_CAPTURE_KEY, token],
      func: (registryKey: string, captureToken: string): ClaudeCapturedVisual[] => {
        const state = (globalThis as Record<string, unknown>)[registryKey] as
          ClaudeVisualPageState | undefined;
        if (!state || state.token !== captureToken) return [];

        for (const item of [...state.scrollPositions].reverse()) {
          try {
            item.element.scrollLeft = item.left;
            item.element.scrollTop = item.top;
          } catch { /* the element may have been unmounted */ }
        }
        try {
          window.scrollTo(state.windowPosition.left, state.windowPosition.top);
        } catch { /* scrolling may be blocked */ }

        const visuals = [...state.visuals.values()]
          .sort((a, b) => a.rowIndex - b.rowIndex || (a.visualIndex ?? 0) - (b.visualIndex ?? 0));

        if (state.handler) window.removeEventListener('message', state.handler);
        delete (globalThis as Record<string, unknown>)[registryKey];
        return visuals;
      },
    });
    return results[0]?.result ?? [];
  };

  try {
    const setupResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [CLAUDE_VISUAL_CAPTURE_KEY, token, targets],
      func: (
        registryKey: string,
        captureToken: string,
        visualTargets: ClaudeVisualTarget[],
      ): { expectedCount: number } => {
        const old = (globalThis as Record<string, unknown>)[registryKey] as
          ClaudeVisualPageState | undefined;
        if (old?.handler) window.removeEventListener('message', old.handler);

        const isMcpFrame = (frame: HTMLIFrameElement): boolean => {
          try {
            const url = new URL(frame.src, location.href);
            return (
              /(?:^|\.)claudemcpcontent\.com$/i.test(url.hostname) &&
              url.pathname === '/mcp_apps'
            );
          } catch { return false; }
        };

        // Remember every scrollable ancestor so it can be restored afterwards.
        const scrollPositions: Array<{ element: Element; left: number; top: number }> = [];
        const seen = new Set<Element>();
        const mounted = [...document.querySelectorAll('[data-testid="transcript-row"][data-index]')];
        for (const row of mounted) {
          for (let parent = row.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (
              /(?:auto|scroll)/.test(style.overflowY) &&
              parent.scrollHeight > parent.clientHeight + 1 &&
              !seen.has(parent)
            ) {
              seen.add(parent);
              scrollPositions.push({
                element: parent,
                left: parent.scrollLeft,
                top: parent.scrollTop,
              });
            }
          }
        }

        const scrollingElement = document.scrollingElement;
        if (scrollingElement && !seen.has(scrollingElement)) {
          scrollPositions.push({
            element: scrollingElement,
            left: scrollingElement.scrollLeft,
            top: scrollingElement.scrollTop,
          });
        }

        const state: ClaudeVisualPageState = {
          token: captureToken,
          targets: visualTargets,
          visuals: new Map<string, ClaudeCapturedVisual>(),
          scrollPositions,
          windowPosition: { left: window.scrollX, top: window.scrollY },
          handler: null,
        };

        const handler = (event: MessageEvent): void => {
          const data = event?.data as Record<string, unknown> | null | undefined;
          if (
            !data ||
            data.type !== 'chatgpt-export-claude-visual-v3' ||
            data.token !== captureToken ||
            !data.svg
          ) return;

          const frames = [...document.querySelectorAll('iframe')].filter(isMcpFrame);
          const frame = frames.find(candidate => candidate.contentWindow === event.source);
          const row = frame?.closest?.('[data-testid="transcript-row"][data-index]');
          const rowIndex = Number(row?.getAttribute('data-index'));
          if (!Number.isInteger(rowIndex)) return;
          if (!state.targets.some(target => target.rowIndex === rowIndex)) return;

          const siblings = [...(row?.querySelectorAll('iframe') || [])].filter(isMcpFrame);
          const visualIndex = Math.max(0, siblings.indexOf(frame as HTMLIFrameElement));
          state.visuals.set(`${rowIndex}:${visualIndex}`, {
            rowIndex,
            visualIndex,
            svg: String(data.svg),
            width: Number(data.width) || null,
            height: Number(data.height) || null,
          });
        };

        state.handler = handler;
        (globalThis as Record<string, unknown>)[registryKey] = state;
        window.addEventListener('message', handler);

        return { expectedCount: visualTargets.reduce((sum, target) => sum + target.count, 0) };
      },
    });

    const setup = setupResults[0]?.result;
    if (!setup?.expectedCount) return await finishCapture();

    // Capture whatever Claude currently has rendered before moving the transcript.
    await captureRound();
    await sleep(120);

    for (const rowIndex of await missingRows()) {
      for (const settleMs of [800, 1400]) {
        if (!(await bringRowIntoView(rowIndex, settleMs))) break;
        await captureRound();
        await sleep(150);
        if (!(await missingRows()).includes(rowIndex)) break;
      }
    }

    return await finishCapture();
  } catch (error) {
    console.warn('kontekst: Claude visual capture failed', error);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [CLAUDE_VISUAL_CAPTURE_KEY],
        func: (registryKey: string) => {
          const state = (globalThis as Record<string, unknown>)[registryKey] as
            ClaudeVisualPageState | undefined;
          for (const item of [...(state?.scrollPositions || [])].reverse()) {
            try {
              item.element.scrollLeft = item.left;
              item.element.scrollTop = item.top;
            } catch { /* the element may have been unmounted */ }
          }
          if (state?.handler) window.removeEventListener('message', state.handler);
          delete (globalThis as Record<string, unknown>)[registryKey];
        },
      });
    } catch { /* cleanup is best-effort */ }
    return [];
  }
}

/* ──────────────── ClaudeExtractor class ───────────────────────────────── */

export class ClaudeExtractor extends BaseExtractor {
  constructor() {
    super(Platform.Claude);
  }

  /** Check that the current tab is a Claude chat page. */
  async isValidPage(tabId: number): Promise<boolean> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url) return false;
      return /^https:\/\/(www\.)?claude\.ai\//i.test(tab.url);
    } catch { return false; }
  }

  // ── extractConversation: page fetch + visual capture + branch walk ──

  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    const valid = await this.isValidPage(tabId);
    if (!valid) throw new Error('Not a valid Claude conversation page');

    // 1. Fetch the conversation payload from inside the page (org-aware).
    const data = await fetchClaudeConversationInPage(tabId);

    // 2. Capture the custom SVG widgets rendered inside MCP iframes.
    const captured = await captureClaudeCustomVisuals(tabId, claudeCustomVisualTargets(data));
    const visuals = mergeVisuals(data.__customVisuals || [], captured);
    const payload: ClaudeConversationPayload = visuals.length
      ? { ...data, __customVisuals: visuals }
      : data;

    // 3. Walk the active branch and normalise to the shared schema.
    return this.normalizeConversation(payload, activeBranchMessages(payload));
  }

  // ── getConversation: API-only (headless) ─────────────────────────────

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const organizationId = await this.findOrganizationId();
    const res = await fetch(
      `/api/organizations/${encodeURIComponent(organizationId)}` +
      `/chat_conversations/${encodeURIComponent(conversationId)}${CLAUDE_CONVERSATION_QUERY}`,
      { credentials: 'include' },
    );
    if (!res.ok) throw new Error(`Claude conversation fetch: ${res.status}`);

    const data = (await res.json()) as ClaudeConversationPayload;
    return this.normalizeConversation(data, activeBranchMessages(data));
  }

  // ── listConversations: pagination over chat_conversations_v2 ─────────

  async listConversations(page: number = 0, pageSize: number = 20): Promise<Record<string, unknown>[]> {
    const organizationId = await this.findOrganizationId();
    const res = await fetch(
      `/api/organizations/${encodeURIComponent(organizationId)}` +
      `/chat_conversations_v2?limit=${pageSize}&offset=${page * pageSize}&consistency=eventual`,
      { credentials: 'include' },
    );
    if (!res.ok) throw new Error(`Claude conversation list: ${res.status}`);

    const payload = (await res.json()) as ClaudeConversationListPayload;
    const items = Array.isArray(payload?.data) ? payload.data : [];
    return items.map(item => ({
      id: item.uuid || null,
      title: typeof item.name === 'string' ? item.name : '',
      createdAt: typeof item.created_at === 'string' ? item.created_at : null,
    }));
  }

  // ── private helpers ──────────────────────────────────────────────────

  /** Resolve the organization id that scopes every Claude conversation call. */
  private async findOrganizationId(): Promise<string> {
    const res = await fetch('/api/organizations', { credentials: 'include' });
    if (!res.ok) throw new Error(`Claude organizations fetch: ${res.status}`);

    const payload: unknown = await res.json();
    const organizations: Array<Record<string, unknown>> = Array.isArray(payload)
      ? payload as Array<Record<string, unknown>>
      : (isRecord(payload) && Array.isArray(payload.organizations)
          ? payload.organizations as Array<Record<string, unknown>>
          : []);

    for (const organization of organizations) {
      const id = organization.uuid || organization.id || organization.organization_id;
      if (id) return String(id);
    }

    throw new Error('Claude organization id was not found');
  }

  // ── Normalisation ────────────────────────────────────────────────────

  private normalizeConversation(
    data: ClaudeConversationPayload,
    branch: ClaudeChatMessage[],
    omission: ClaudeOmission = {},
  ): Record<string, unknown> {
    const messages: Message[] = [];
    const activeIndexById = activeBranchIndexByMessageId(data);

    for (const message of branch) {
      const { textParts, attachments } = extractClaudeContent(message, data);
      attachments.push(...customVisualAttachments(data, message.uuid, activeIndexById));
      if (!textParts.length && !attachments.length) continue;

      const role: 'user' | 'assistant' = message.sender === 'human' ? 'user' : 'assistant';
      const createdAt = typeof message.created_at === 'string'
        ? message.created_at
        : (typeof message.created_at === 'number'
            ? new Date(message.created_at * 1000).toISOString()
            : null);

      messages.push({
        id: message.uuid,
        parentId: message.parent_message_uuid || null,
        role,
        sourceRole: message.sender || role,
        createdAt,
        model: role === 'assistant' ? (message.model || data.model || null) : null,
        ...(omission.beforeIds?.has(message.uuid) ? { omittedBefore: true } : {}),
        content: textParts.map(text => ({
          type: ContentBlockType.Text,
          text,
          format: 'markdown' as const,
        })),
        attachments,
      });
    }

    if (omission.omittedAtStart && messages.length) messages[0].omittedBefore = true;
    if (omission.omittedAtEnd && messages.length) messages[messages.length - 1].omittedAfter = true;

    return {
      platform: Platform.Claude,
      conversationId: data.uuid || null,
      conversationUrl: data.uuid ? `https://claude.ai/chat/${data.uuid}` : null,
      title: typeof data.name === 'string' ? data.name : '',
      model: data.model || null,
      messages,
    };
  }
}
