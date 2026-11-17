import { describe, expect, it } from 'vitest';
import { checkMarkdownFile, markdownMessage } from '../../src/lib/markdown';
import { ApiError } from '../../src/lib/api/client';

describe('Markdown-Vorprüfung ohne Upload', () => {
  it('akzeptiert UTF-8, BOM, Umlaute, Tabs und Zeilenumbrüche', async () => {
    expect(await checkMarkdownFile(new File(['\ufeff# Grüße\r\n\tText'], 'NOTIZ.MD'))).toEqual({ ok: true });
  });
  it('weist falsche Endungen, leeren Text, ungültiges UTF-8 und Steuerzeichen zurück', async () => {
    for (const file of [new File(['Hallo'], 'a.txt'), new File(['\ufeff \t\r\n'], 'a.md'),
      new File([Uint8Array.of(0xc3, 0x28)], 'a.md'), new File(['Text\0'], 'a.md'), new File(['Text\u0085'], 'a.md')]) {
      expect(await checkMarkdownFile(file)).toEqual({ ok: false, code: 'unsupported-type' });
    }
  });
  it('prüft die gesamte Quelle und die Bytegrenze vor dem Lesen', async () => {
    expect(await checkMarkdownFile(new File(['x'.repeat(2097152)], 'a.md'))).toEqual({ ok: true });
    expect(await checkMarkdownFile(new File(['x'.repeat(2097152), '\0'], 'a.md'))).toEqual({ ok: false, code: 'file-too-large' });
    expect(await checkMarkdownFile(new File(['x'.repeat(65536), '\0'], 'a.md'))).toEqual({ ok: false, code: 'unsupported-type' });
    expect(await checkMarkdownFile(new File(['12345'], 'a.md'), 4)).toEqual({ ok: false, code: 'file-too-large' });
  });
  it('erklärt Eingabe-, Ausgabe-, Seiten- und Verfügbarkeitsfehler', () => {
    expect(markdownMessage(new ApiError('unsupported-type'))).toMatch(/UTF-8/);
    expect(markdownMessage(new ApiError('file-too-large'))).toMatch(/Eingabe/);
    expect(markdownMessage(new ApiError('result-too-large'))).toMatch(/PDF/);
    expect(markdownMessage(new ApiError('dimensions-too-large'))).toMatch(/Seiten/);
    expect(markdownMessage(new ApiError('service-unavailable'))).toMatch(/verfügbar/);
  });
});
