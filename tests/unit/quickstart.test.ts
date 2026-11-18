import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  classifyFiles,
  detectFileKind,
  detectKindFromHead,
  groupFiles,
  toolsForKind,
} from '../../src/lib/quickstart';
import { ascii, concat } from './helpers/bytes';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const PDF = ascii('%PDF-1.7\n');
const WAV = concat(ascii('RIFF'), Uint8Array.of(36, 0, 0, 0), ascii('WAVEfmt '));

function file(bytes: Uint8Array | string, name: string): File {
  const data = typeof bytes === 'string' ? ascii(bytes) : bytes;
  return new File([data as Uint8Array<ArrayBuffer>], name);
}

describe('Typerkennung', () => {
  it('erkennt Markdown nur mit passender Endung und gültigem Text, nach vorhandenen Signaturen', async () => {
    expect(await detectFileKind(new File(['\ufeff# Grüße'], 'NOTIZ.MARKDOWN'))).toBe('markdown');
    expect(await detectFileKind(file('# Hallo', 'notiz.md'))).toBe('markdown');
    expect(await detectFileKind(file('   ', 'leer.md'))).toBeNull();
    expect(await detectFileKind(file(Uint8Array.of(0xff), 'kaputt.md'))).toBeNull();
    expect(await detectFileKind(file(PNG, 'foto.md'))).toBe('image');
  });
  it('erkennt Bild, PDF und Audio an der Signatur', () => {
    expect(detectKindFromHead(PNG)).toBe('image');
    expect(detectKindFromHead(JPEG)).toBe('image');
    expect(detectKindFromHead(PDF)).toBe('pdf');
    expect(detectKindFromHead(WAV)).toBe('audio');
  });

  it('lässt Endung und MIME-Typ außer Acht', async () => {
    expect(await detectFileKind(file(PNG, 'foto.pdf'))).toBe('image');
    expect(await detectFileKind(file(PDF, 'ton.mp3'))).toBe('pdf');
    expect(await detectFileKind(file(WAV, 'bild.png'))).toBe('audio');
  });

  it('meldet Unbekanntes und leere Dateien als null', async () => {
    expect(detectKindFromHead(ascii('Hallo Welt'))).toBeNull();
    expect(await detectFileKind(file('Hallo Welt', 'notiz.txt'))).toBeNull();
    expect(await detectFileKind(file(new Uint8Array(0), 'leer.png'))).toBeNull();
  });
});

describe('Aktionen je Typ', () => {
  const ids = (kind: Parameters<typeof toolsForKind>[0]) => toolsForKind(kind).map((tool) => tool.id);
  it('bietet für PDF kein Teilen in der Schnellwahl an, weil es Einstellungen braucht', () => {
    expect(ids('pdf')).not.toContain('pdf-teilen');
  });

  it('bietet für Markdown ausschließlich das eigene PDF-Werkzeug', () => {
    expect(ids('markdown')).toEqual(['markdown-pdf']);
    expect(ids('pdf')).toEqual(['pdf-komprimieren', 'pdf-drehen', 'pdf-zusammenfuehren']);
  });

  it('bietet Bild zu PDF nie als Aktion für eine einzelne Datei an', () => {
    for (const kind of ['image', 'pdf', 'audio', 'markdown'] as const) expect(ids(kind)).not.toContain('image-pdf');
  });

  it('bietet für Bilder Konvertieren, Komprimieren und Skalieren', () => {
    expect(ids('image')).toEqual(['bilder-konvertieren', 'bilder-komprimieren', 'bilder-skalieren']);
    expect(toolsForKind('image').map(actionLabel)).toEqual(['Konvertieren', 'Komprimieren', 'Skalieren']);
  });

  it('bietet für PDF Komprimieren, Drehen und Zusammenführen und für Audio nur Konvertieren', () => {
    expect(ids('pdf')).toEqual(['pdf-komprimieren', 'pdf-drehen', 'pdf-zusammenfuehren']);
    expect(toolsForKind('pdf').map(actionLabel)).toEqual(['Komprimieren', 'Drehen', 'Zusammenführen']);
    expect(ids('audio')).toEqual(['audio-konvertieren']);
    expect(toolsForKind('audio').map(actionLabel)).toEqual(['Konvertieren']);
  });
});

describe('Gruppierung', () => {
  const png = file(PNG, 'a.png');
  const jpg = file(JPEG, 'b.jpg');
  const pdf = file(PDF, 'c.pdf');
  const txt = file('Hallo', 'd.txt');

  it('fasst Dateien eines Typs zusammen', () => {
    const { groups, unknown } = groupFiles([
      { file: png, kind: 'image' },
      { file: jpg, kind: 'image' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('image');
    expect(groups[0]!.files).toEqual([png, jpg]);
    expect(unknown).toEqual([]);
  });

  it('trennt gemischte Typen in feste Reihenfolge und sammelt Unbekanntes', () => {
    const { groups, unknown } = groupFiles([
      { file: pdf, kind: 'pdf' },
      { file: txt, kind: null },
      { file: png, kind: 'image' },
    ]);
    expect(groups.map((group) => group.kind)).toEqual(['image', 'pdf']);
    expect(unknown).toEqual([txt]);
  });

  it('liefert ohne erkannte Datei keine Gruppe', () => {
    expect(groupFiles([{ file: txt, kind: null }])).toEqual({ groups: [], unknown: [txt] });
  });

  it('classifyFiles liest die Signaturen der Dateien', async () => {
    const result = await classifyFiles([png, txt, pdf]);
    expect(result.groups.map((group) => group.kind)).toEqual(['image', 'pdf']);
    expect(result.unknown).toEqual([txt]);
  });
});
