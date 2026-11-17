import { describe, expect, it } from 'vitest';
import { detectFile, detectFromHead, extensionNote } from '../../src/lib/detect';
import { ascii, concat } from './helpers/bytes';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const PDF = ascii('%PDF-1.7\n');
const WAV = concat(ascii('RIFF'), Uint8Array.of(36, 0, 0, 0), ascii('WAVEfmt '));

const make = (bytes: Uint8Array | string, name: string) =>
  new File([(typeof bytes === 'string' ? ascii(bytes) : bytes) as Uint8Array<ArrayBuffer>], name);

describe('Formaterkennung', () => {
  it('benennt das Format am Inhalt', () => {
    expect(detectFromHead(PNG)).toMatchObject({ kind: 'image', formatLabel: 'PNG' });
    expect(detectFromHead(JPEG)).toMatchObject({ kind: 'image', formatLabel: 'JPEG' });
    expect(detectFromHead(PDF)).toMatchObject({ kind: 'pdf', formatLabel: 'PDF' });
    expect(detectFromHead(WAV)).toMatchObject({ kind: 'audio', formatLabel: 'WAV' });
    expect(detectFromHead(ascii('hallo'))).toMatchObject({ kind: null, formatLabel: null });
  });

  it('erkennt Dateien trotz falscher oder fehlender Endung und Markdown nur mit Endung', async () => {
    expect(await detectFile(make(PNG, 'foto.jpg'))).toMatchObject({ kind: 'image', formatLabel: 'PNG' });
    expect(await detectFile(make(PDF, 'bericht'))).toMatchObject({ kind: 'pdf' });
    expect(await detectFile(make('# Titel', 'notiz.md'))).toMatchObject({ kind: 'markdown', formatLabel: 'Markdown' });
    expect((await detectFile(make('# Titel', 'notiz.txt'))).kind).toBeNull();
    expect((await detectFile(make('', 'leer.png'))).kind).toBeNull();
  });
});

describe('Endungshinweis', () => {
  it('warnt bei abweichender Endung, nicht bei passender oder fehlender', async () => {
    const png = detectFromHead(PNG);
    expect(extensionNote('foto.jpg', png)).toContain('Erkannt wurde PNG');
    expect(extensionNote('foto.PNG', png)).toBeNull();
    expect(extensionNote('foto', png)).toBeNull();
    expect(extensionNote('foto.', png)).toBeNull();
    expect(extensionNote('foto.jpg', detectFromHead(JPEG))).toBeNull();
    expect(extensionNote('lied.opus', { kind: 'audio', formatLabel: 'OGG', extensions: ['ogg', 'oga', 'opus'] })).toBeNull();
    expect(extensionNote('x.png', detectFromHead(ascii('hallo')))).toBeNull();
  });
});
