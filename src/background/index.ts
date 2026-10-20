// Service worker: orchestrate extraction, ZIP archiving, and downloads
import { ZipBuilder } from '../core/ZipBuilder';
import { MarkdownRenderer } from '../renderers/Markdown';
import { HtmlRenderer } from '../renderers/Html';
import { uniqueAttachmentName } from '../core/attachments';
import { ContentBlockType } from '../core/types';
import type { ExtractedAttachment, ExportOptions, Message } from '../core/types';

/** Base64 → bytes, worker-safe (no atob dependency beyond the SW global). */
function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null; // corrupt payload — skip rather than fail the export.
  }
}

// ─────────────────────────── Toolbar icon action ──────────────────────────────
//
// Decision (action-handler conflict): the toolbar icon opens the POPUP.
// manifest.json declares action.default_popup => src/popup/index.html, and Chrome
// never fires chrome.action.onClicked while a default_popup is set. The previous
// onClicked listener here was therefore unreachable code, so it has been removed
// rather than left alongside the popup.
//
// Consequence to be aware of: the popup performs injection + extraction itself and
// then sends { type: 'kontekst:trigger-export' } to this service worker. The
// chrome.runtime.onMessage listener below handles that message and forwards the
// extracted data to exportConversation, which builds the Markdown + HTML files,
// packs them into a ZIP, and starts the download.

// Called by the popup after it extracts the conversation from the content script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'kontekst:trigger-export') return;

  // The popup already waited for kontekst:extract and has the data; re-forward
  // whatever the popup passes so exportConversation stays reusable.
  const data = (message.data ?? {}) as Record<string, unknown>;
  const options = (message.options ?? {}) as ExportOptions;
  exportConversation(data, options).then(
    ({ attachmentCount }) => sendResponse({ ok: true, attachmentCount }),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true; // async response.
});

// Export the extracted conversation data honouring the popup's chosen options.
// Returns the number of attachments written into the ZIP (0 when none).
async function exportConversation(
  data: Record<string, unknown>,
  options: ExportOptions = {},
): Promise<{ attachmentCount: number }> {
  const messages = (data.messages || []) as Array<{
    role: string;
    content: string;
    attachments?: ExtractedAttachment[];
  }>;

  // Which files to include — the popup defaults both formats to true.
  const formats = options.formats ?? {};
  const wantMarkdown = formats.markdown !== false;
  const wantHtml = formats.html !== false;
  if (!wantMarkdown && !wantHtml) {
    throw new Error('Select at least one format.');
  }

  // Role labels + the optional original-chat link ("Include original chat link").
  const renderOptions = {
    userLabel: options.userLabel,
    assistantLabel: options.assistantLabel,
    sourceUrl: options.includeChatLink ? options.sourceUrl ?? null : null,
  };

  if (messages.length === 0) {
    // Throw so the popup surfaces a real error instead of a false "Exported!".
    // Include the content script's DOM diagnostics so a failed export explains
    // which selectors were found (and in which frame), not just "no messages".
    const diagnostics = data.diagnostics;
    const detail = diagnostics ? ` [DOM: ${JSON.stringify(diagnostics)}]` : '';
    throw new Error(`No messages found in this conversation.${detail}`);
  }

  const zipBuilder = new ZipBuilder();

  // Normalise the extraction output into the shared conversation schema.
  const normalizedMessages: Message[] = messages.map((m, index) => ({
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    role: m.role === 'user' ? 'user' : 'assistant',
    sourceRole: m.role,
    createdAt: null,
    model: null,
    content: [{ type: ContentBlockType.Text, text: m.content, format: 'markdown' }],
    attachments: [],
  }));

  // Add only the formats the user ticked (at least one — validated above).
  // The `taken` set seeds with these names so an attachment called
  // "conversation.md" can never clobber a rendered file at the ZIP root.
  const takenNames = new Set<string>();
  if (wantMarkdown) {
    const mdRenderer = new MarkdownRenderer();
    zipBuilder.addFileSync('conversation.md', mdRenderer.render(normalizedMessages, renderOptions));
    takenNames.add('conversation.md');
  }
  if (wantHtml) {
    const htmlRenderer = new HtmlRenderer();
    zipBuilder.addFileSync('conversation.html', htmlRenderer.render(normalizedMessages, renderOptions));
    takenNames.add('conversation.html');
  }

  // "Save attachments": pack every downloaded attachment into the archive.
  // "Attachments in a separate folder" nests them under attachments/ instead
  // of the ZIP root. Names are de-duplicated across the whole archive so two
  // uploads both called "image.png" survive as image.png + image (2).png.
  let attachmentCount = 0;
  if (options.saveAttachments) {
    const prefix = options.attachmentsInFolder ? 'attachments/' : '';
    for (const msg of messages) {
      for (const attachment of msg.attachments ?? []) {
        const bytes = base64ToBytes(attachment.dataBase64);
        if (!bytes || bytes.length === 0) continue; // corrupt/empty — skip.
        const unique = uniqueAttachmentName(attachment.filename, takenNames);
        zipBuilder.addFileSync(prefix + unique, bytes);
        attachmentCount++;
      }
    }
  }

  // Generate the ZIP and start the download.
  //
  // MV3 service workers have NO DOM, so URL.createObjectURL is undefined here
  // (calling it throws "URL.createObjectURL is not a function"). Instead encode
  // the archive as a base64 data: URL — blob.arrayBuffer() and btoa are both
  // worker-safe, and chrome.downloads.download accepts data: URLs. This also
  // avoids any object-URL lifetime race with the popup closing.
  const blob = await zipBuilder.generate();
  const dataUrl = await blobToDataUrl(blob);

  chrome.downloads.download({
    url: dataUrl,
    filename: `${resolveZipName(data, options)}.zip`,
    saveAs: true,
  });

  // Mention attachments in the notification, including any that failed to
  // download (content scripts report those in data.attachmentErrors).
  const skipped = Array.isArray(data.attachmentErrors) ? data.attachmentErrors.length : 0;
  const attachmentNote = attachmentCount
    ? `, ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}${skipped ? ` (${skipped} failed)` : ''}`
    : skipped
      ? ` (${skipped} attachment${skipped === 1 ? '' : 's'} failed to download)`
      : '';

  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'KONTEKST',
    message: `${messages.length} messages exported successfully${attachmentNote}!`,
  });

  return { attachmentCount };
}

/** Encode a Blob as a base64 data: URL without needing a DOM (worker-safe). */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // 32 KiB — keeps fromCharCode under the stack limit.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return `data:application/zip;base64,${btoa(binary)}`;
}

/** Strip characters invalid in file names, plus any trailing .zip / dots / spaces. */
function sanitizeZipName(raw: string): string {
  return raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/(\.zip)+$/i, '')
    .replace(/[. ]+$/g, '')
    .trim();
}

/**
 * ZIP base name: the popup's export name → the conversation title → a
 * timestamped default. The caller appends ".zip".
 */
function resolveZipName(data: Record<string, unknown>, options: ExportOptions): string {
  const fromOption = sanitizeZipName(options.exportName ?? '');
  if (fromOption) return fromOption;
  const title = typeof data.title === 'string' ? sanitizeZipName(data.title) : '';
  if (title) return title;
  return `kontekst-export-${Date.now()}`;
}

console.log('KONTEKST background service worker loaded');
