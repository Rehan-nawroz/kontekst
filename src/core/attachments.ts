/**
 * Attachment helpers shared by the content scripts (which download the bytes
 * on the platform origin) and the background service worker (which packs them
 * into the export ZIP).
 *
 * Design rules:
 *  - A failed attachment download must NEVER fail the whole export — it is
 *    skipped and reported so the popup can tell the user what was missed.
 *  - Attachment names are sanitised for the filesystem and de-duplicated so
 *    two images called "image.png" from different messages both survive.
 */

import type { ExtractedAttachment } from './types';

// ────────────────────────────── Naming ───────────────────────────────────────

/** Strip characters that are invalid in file names on any of the big OSes. */
export function sanitizeAttachmentName(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'attachment';
}

/** Common MIME → extension fallback used when the source gives no filename. */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
};

/** Guess a file extension from a MIME type; null when unknown. */
export function extensionForMime(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[base] ?? null;
}

/**
 * Finalise an attachment filename: sanitise it and, when it has no extension
 * and the MIME type is known, append one.
 */
export function finalizeAttachmentName(
  filename: string | null | undefined,
  mimeType: string | null | undefined,
): string {
  let name = sanitizeAttachmentName(filename ?? '');
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    const ext = extensionForMime(mimeType);
    if (ext) name = `${name}.${ext}`;
  }
  return name;
}

/**
 * Make a filename unique within a set by appending " (2)", " (3)", … before
 * the extension. The taken name is registered and the result returned.
 */
export function uniqueAttachmentName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 2;
  let candidate = `${stem} (${counter})${ext}`;
  while (taken.has(candidate)) {
    counter++;
    candidate = `${stem} (${counter})${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

// ────────────────────────── Base64 (browser side) ────────────────────────────

/**
 * Encode a Blob as plain base64 (no data: prefix). Chunked so large files
 * don't blow the argument limit of String.fromCharCode. Runs in the content
 * script, so FileReader/btoa are available.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // 32 KiB
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

// ─────────────────────────── Download helpers ────────────────────────────────

export interface DownloadResult {
  attachment: ExtractedAttachment | null;
  /** Human-readable reason, set only when attachment is null. */
  error?: string;
}

/**
 * Download one attachment best-effort. Never throws: returns
 * { attachment: null, error } on any failure so callers can batch-download a
 * whole conversation without one dead link aborting the rest.
 *
 * `filename` may be null — the final name falls back to the URL basename and
 * then to the MIME type.
 */
export async function downloadAttachment(
  url: string,
  options: {
    filename?: string | null;
    mimeType?: string | null;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Referrer to send (e.g. "https://grok.com/") — Grok's asset CDN checks it. */
    referrer?: string;
    /** Defaults to 'include'; signed CDN URLs need 'omit' (DeepSeek, Grok files). */
    credentials?: RequestCredentials;
  } = {},
): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: options.credentials ?? 'include',
      headers: options.headers,
      referrer: options.referrer,
      signal: options.signal,
    });
  } catch (err) {
    return { attachment: null, error: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { attachment: null, error: `HTTP ${response.status}` };
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (err) {
    return { attachment: null, error: `body read failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Prefer the server's idea of the name; fall back to the URL basename.
  let name = options.filename ?? null;
  if (!name) {
    try {
      const segments = new URL(response.url || url).pathname.split('/').filter(Boolean);
      name = segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
    } catch {
      name = '';
    }
  }

  const mimeType = options.mimeType || blob.type || response.headers.get('content-type') || null;
  const dataBase64 = await blobToBase64(blob);

  return {
    attachment: {
      filename: finalizeAttachmentName(name, mimeType),
      mimeType,
      dataBase64,
    },
  };
}
