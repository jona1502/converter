import { ApiError, apiMessage } from './api/client';
import { formatBytes } from './format';

export const MARKDOWN_ACCEPT = '.md,.markdown,text/markdown';
export const MARKDOWN_LIMITS = { maxFileBytes: 2097152, maxOutputBytes: 20971520, maxPages: 300 };

/** Vollständige, begrenzte Textprüfung im Browser; lädt keine Datei hoch. Der Server prüft erneut. */
export async function checkMarkdownFile(file: File, maxBytes = MARKDOWN_LIMITS.maxFileBytes): Promise<{ ok: true } | { ok: false; code: string }> {
  if (file.size > maxBytes) return { ok: false, code: 'file-too-large' };
  if (!/\.(md|markdown)$/i.test(file.name) || file.size === 0) return { ok: false, code: 'unsupported-type' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return { ok: false, code: 'unsupported-type' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'unsupported-type' };
  }
}

export function markdownMessage(error: unknown, limits = MARKDOWN_LIMITS): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unsupported-type': case 'decode-failed': return 'Bitte wählen Sie eine nicht leere .md- oder .markdown-Datei in UTF-8 (optional mit BOM), ohne Binärdaten oder Steuerzeichen.';
      case 'file-too-large': return `Die Eingabe ist zu groß. Erlaubt sind höchstens ${formatBytes(limits.maxFileBytes)}.`;
      case 'result-too-large': return `Die erzeugte PDF überschreitet die erlaubten ${formatBytes(limits.maxOutputBytes)}.`;
      case 'dimensions-too-large': return `Die PDF überschreitet die erlaubten ${limits.maxPages} Seiten.`;
      case 'service-unavailable': return 'Markdown zu PDF ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.';
      case 'encode-failed': return 'Aus dieser Markdown-Datei konnte keine PDF erstellt werden.';
    }
  }
  return apiMessage(error);
}
