// ZIP builder using fflate library

import * as fflate from 'fflate';

export class ZipBuilder {
  private zip = new fflate.Zip();
  private fileNameCounter = 0;

  addFile(name: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.zip.add(new fflate.ZlibData(data), name, () => {});
    this.fileNameCounter++;
  }

  addFileSync(name: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.zip.push(name, data);
    this.fileNameCounter++;
  }

  async generate(): Promise<Blob> {
    // Return the final zip when all files are added
    // This will be called when users want to download
    return new Promise((resolve, reject) => {
      try {
        fflate.zipGive(this.zip.files, (err: Error | null, result: Uint8Array) => {
          if (err) {
            reject(err);
          } else {
            const blob = new Blob([result], { type: 'application/zip' });
            resolve(blob);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // Generate and create download link
  async generateDownloadUrl(): Promise<string> {
    const blob = await this.generate();
    return URL.createObjectURL(blob);
  }

  clear(): void {
    this.zip = new fflate.Zip();
    this.fileNameCounter = 0;
  }
}
