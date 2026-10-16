// ZIP builder using the fflate library.
//
// Files are buffered in memory and packed on demand via fflate's one-shot
// `zipSync`, which keeps the public API (addFile / addFileSync / generate /
// clear) stable while relying only on exports present in fflate >= 0.8.

import * as fflate from 'fflate';

export class ZipBuilder {
  private files = new Map<string, Uint8Array>();
  private fileNameCounter = 0;

  /** Queue a file for inclusion in the archive. */
  addFile(name: string, content: string | Uint8Array): void {
    this.addFileSync(name, content);
  }

  /** Queue a file for inclusion in the archive (kept for API parity). */
  addFileSync(name: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? fflate.strToU8(content) : content;
    this.files.set(name, data);
    this.fileNameCounter++;
  }

  /** Pack every queued file into a ZIP blob. */
  async generate(): Promise<Blob> {
    const entries: fflate.Zippable = {};
    for (const [name, data] of this.files) entries[name] = data;
    const zipped = fflate.zipSync(entries);
    return new Blob([zipped], { type: 'application/zip' });
  }

  /** Pack the archive and expose it as an object URL. */
  async generateDownloadUrl(): Promise<string> {
    const blob = await this.generate();
    return URL.createObjectURL(blob);
  }

  /** Reset the builder so it can be reused for another archive. */
  clear(): void {
    this.files.clear();
    this.fileNameCounter = 0;
  }
}
