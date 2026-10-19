import { createElement } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ExportOptions } from '../core/types';

interface MessageData {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Footer hint shown while idle — matches the design's footer text. */
const HINT = 'Open a supported chat on ChatGPT, Claude, Grok, or DeepSeek and refresh the page.';

type StatusKind = 'idle' | 'busy' | 'error' | 'success';

/** Map the active tab's URL to a supported platform, or null when unsupported. */
function detectPlatform(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  switch (host) {
    case 'chatgpt.com':
      return 'chatgpt';
    case 'claude.ai':
      return 'claude';
    case 'grok.com':
      return 'grok';
    case 'chat.deepseek.com':
      return 'deepseek';
    default:
      return null;
  }
}

/** Content script not injected yet (tab loaded before install) → show hint. */
function isMissingContentScript(message: string): boolean {
  return /receiving end does not exist|could not establish connection|connection closed/i.test(message);
}

export function App() {
  const [platform, setPlatform] = useState<string | null>(null);
  const [exportName, setExportName] = useState('');
  const [userLabel, setUserLabel] = useState('User');
  const [assistantLabel, setAssistantLabel] = useState('Assistant');
  const [formatMarkdown, setFormatMarkdown] = useState(true);
  const [formatHtml, setFormatHtml] = useState(true);
  const [includeChatLink, setIncludeChatLink] = useState(false);
  const [saveAttachments, setSaveAttachments] = useState(false);
  const [attachmentsInFolder, setAttachmentsInFolder] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [statusKind, setStatusKind] = useState<StatusKind>('idle');
  const [isExporting, setIsExporting] = useState(false);

  // Auto-detect the platform from the active tab — there is no platform dropdown.
  useEffect(() => {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setPlatform(detectPlatform(tab?.url)))
      .catch(() => setPlatform(null));
  }, []);

  const handleExport = useCallback(async () => {
    if (!formatMarkdown && !formatHtml) {
      setStatus('Select at least one format.');
      setStatusKind('error');
      return;
    }

    setIsExporting(true);
    setStatus('Extracting...');
    setStatusKind('busy');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found.');

      if (!detectPlatform(tab.url)) {
        setStatus(HINT);
        setStatusKind('error');
        return;
      }

      // Manifest-declared content scripts are already injected on supported
      // hosts; the extractor answers with { success, data } (or { error }).
      // includeAttachments tells it to also download the chat's files/images.
      const result = (await chrome.tabs.sendMessage(tab.id, {
        type: 'kontext:extract',
        includeAttachments: saveAttachments,
      })) as MessageData;

      if (!result?.success) throw new Error(result?.error || 'Extraction failed.');

      setStatus('Exporting...');
      setStatusKind('busy');

      const options: ExportOptions = {
        exportName: exportName.trim(),
        userLabel: userLabel.trim() || 'User',
        assistantLabel: assistantLabel.trim() || 'Assistant',
        formats: { markdown: formatMarkdown, html: formatHtml },
        includeChatLink,
        saveAttachments,
        attachmentsInFolder: saveAttachments && attachmentsInFolder,
        sourceUrl: includeChatLink ? tab.url ?? null : null,
      };

      // Forward data + options to the background and wait for the reply so
      // success is only shown once the download actually started.
      const exportReply = (await chrome.runtime.sendMessage({
        type: 'kontext:trigger-export',
        data: result.data,
        options,
      })) as { ok?: boolean; error?: string; attachmentCount?: number } | undefined;

      if (!exportReply?.ok) throw new Error(exportReply?.error ?? 'Export failed.');

      const saved = exportReply.attachmentCount ?? 0;
      setStatus(saved > 0 ? `Exported! (${saved} attachment${saved === 1 ? '' : 's'})` : 'Exported!');
      setStatusKind('success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'An error occurred.';
      if (isMissingContentScript(message)) {
        setStatus(HINT);
        setStatusKind('error');
      } else {
        setStatus(message);
        setStatusKind('error');
      }
    } finally {
      setIsExporting(false);
    }
  }, [formatMarkdown, formatHtml, includeChatLink, saveAttachments, attachmentsInFolder, exportName, userLabel, assistantLabel]);

  const supported = platform !== null;
  const footerText = statusKind === 'idle' ? HINT : status;

  return (
    <div class="kontext-app">
      <header class="app-header">
        <h1 class="wordmark">
          <span class="wordmark-white">KON</span>
          <span class="wordmark-accent">TEKST</span>
        </h1>
      </header>

      <main class="app-content">
        <input
          class="text-input"
          type="text"
          placeholder="Export name"
          value={exportName}
          onInput={(e) => setExportName(e.currentTarget.value)}
          disabled={isExporting}
        />

        <div class="field-row">
          <div class="field-group">
            <label for="user-label">User</label>
            <input
              id="user-label"
              class="text-input"
              type="text"
              placeholder="User"
              value={userLabel}
              onInput={(e) => setUserLabel(e.currentTarget.value)}
              disabled={isExporting}
            />
          </div>
          <div class="field-group">
            <label for="assistant-label">Assistant</label>
            <input
              id="assistant-label"
              class="text-input"
              type="text"
              placeholder="Assistant"
              value={assistantLabel}
              onInput={(e) => setAssistantLabel(e.currentTarget.value)}
              disabled={isExporting}
            />
          </div>
        </div>

        <section class="formats">
          <div class="section-label">Formats</div>
          <div class="checkbox-grid">
            <label class="check">
              <input
                type="checkbox"
                checked={formatMarkdown}
                onChange={(e) => setFormatMarkdown(e.currentTarget.checked)}
                disabled={isExporting}
              />
              <span>Markdown</span>
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={formatHtml}
                onChange={(e) => setFormatHtml(e.currentTarget.checked)}
                disabled={isExporting}
              />
              <span>HTML</span>
            </label>
            <label class="check check-full">
              <input
                type="checkbox"
                checked={includeChatLink}
                onChange={(e) => setIncludeChatLink(e.currentTarget.checked)}
                disabled={isExporting}
              />
              <span>Include original chat link</span>
            </label>
            <label class="check check-full">
              <input
                type="checkbox"
                checked={saveAttachments}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setSaveAttachments(checked);
                  if (!checked) setAttachmentsInFolder(false);
                }}
                disabled={isExporting}
              />
              <span>Save attachments</span>
            </label>
            <label class={`check check-full${saveAttachments ? '' : ' check-disabled'}`}>
              <input
                type="checkbox"
                checked={attachmentsInFolder}
                onChange={(e) => setAttachmentsInFolder(e.currentTarget.checked)}
                disabled={isExporting || !saveAttachments}
              />
              <span>Attachments in a separate folder</span>
            </label>
          </div>
        </section>

        <button class="export-btn" onClick={handleExport} disabled={isExporting || !supported}>
          {isExporting ? 'Exporting...' : 'Export'}
        </button>

        <p class={`footer-hint footer-${statusKind}`}>{footerText}</p>
      </main>
    </div>
  );
}
