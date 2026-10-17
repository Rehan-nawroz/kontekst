import { createElement } from 'preact';
import { useCallback, useState } from 'preact/hooks';

interface MessageData {
  success: boolean;
  data?: Record<string, unknown>;
}

const PLATFORMS = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'claude', label: 'Claude' },
] as const;

export function App() {
  const [selectedPlatform, setSelectedPlatform] = useState<string>('chatgpt');
  const [status, setStatus] = useState<string>('Ready');
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setStatus('Initializing...');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) throw new Error('No active tab found.');

      const isValidPage = tab.url?.startsWith(
        selectedPlatform === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/'
      );

      if (!isValidPage) {
        throw new Error(`Please open a ${selectedPlatform} conversation page.`);
      }

      setStatus('Extracting...');

      // The manifest-declared content scripts are already injected into the
      // matching pages (chatgpt.com, claude.ai) via content_scripts. Send the
      // extract request directly; the content script's onMessage handler answers
      // with { success, data }.
      const result = (await chrome.tabs.sendMessage(tab.id, {
        type: 'kontext:extract',
      })) as MessageData;

      if (!result?.success) throw new Error('Extraction failed.');

      setStatus('Exporting...');

      // Forward the extracted data to the background so it can build the ZIP.
      // Wait for the background's reply so the popup only shows success when the
      // download was actually started (and shows the error if it failed).
      const exportReply = (await chrome.runtime.sendMessage({
        type: 'kontext:trigger-export',
        data: result.data,
      })) as { ok?: boolean; error?: string } | undefined;

      if (!exportReply?.ok) {
        throw new Error(exportReply?.error ?? 'Export failed.');
      }

      setStatus(`Exported ${selectedPlatform} conversation!`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'An error occurred.');
    } finally {
      setIsExporting(false);
    }
  }, [selectedPlatform]);

  return (
    <div class="kontext-app">
      <header class="app-header">
        <h1>Kontext</h1>
        <p>AI Chat Exporter</p>
      </header>

      <main class="app-content">
        <div class="field-group">
          <label for="platform">Platform</label>
          <select
            id="platform"
            value={selectedPlatform}
            onChange={(e) => setSelectedPlatform(e.currentTarget.value)}
            disabled={isExporting}
          >
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <button class="export-btn" onClick={handleExport} disabled={isExporting}>
          {isExporting ? 'Exporting...' : 'Export Conversation'}
        </button>

        <p class={`status status-${isExporting ? 'loading' : 'idle'}`}>{status}</p>
      </main>
    </div>
  );
}
