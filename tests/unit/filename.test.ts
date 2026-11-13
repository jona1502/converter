import { describe, expect, it } from 'vitest';
import { buildFileName, buildOutputFileName, makeUniqueFileNames } from '../../src/lib/image/filename';

describe('buildOutputFileName', () => {
  it('ersetzt die Endung durch die des Zielformats', () => {
    expect(buildOutputFileName('Urlaub.PNG', 'webp', 'konvertiert')).toBe('Urlaub-konvertiert.webp');
    expect(buildOutputFileName('foto.jpeg', 'jpeg', 'klein')).toBe('foto-klein.jpg');
    expect(buildOutputFileName('archiv.tar.png', 'png', 'x')).toBe('archiv.tar-x.png');
    expect(buildOutputFileName('ohne-endung', 'png', 'x')).toBe('ohne-endung-x.png');
  });

  it('ersetzt Pfadtrenner und unzulässige Zeichen, entfernt Steuerzeichen', () => {
    expect(buildOutputFileName('../../etc/passwd.png', 'png', 'x')).toBe('_.._etc_passwd-x.png');
    expect(buildOutputFileName('C:\\Users\\a.jpg', 'jpeg', 'x')).toBe('C__Users_a-x.jpg');
    expect(buildOutputFileName('a\u0000b\u001fc\u007f.png', 'png', 'x')).toBe('abc-x.png');
    expect(buildOutputFileName('wer?was*<>|".png', 'png', 'x')).toBe('wer_was_____-x.png');
    expect(buildOutputFileName('  Leer  zeichen  .png', 'png', 'x')).toBe('Leer zeichen-x.png');
  });

  it('entfernt Bidi-Steuerzeichen', () => {
    expect(buildOutputFileName('rechnung‮gpj.exe.png', 'png', 'x')).toBe('rechnunggpj.exe-x.png');
    expect(buildOutputFileName('‎a‏b‪c‭d⁦e⁩f؜.jpg', 'jpeg', 'x')).toBe('abcdef-x.jpg');
    expect(buildOutputFileName('‮⁧.png', 'png', 'x')).toBe('bild-x.png');
  });

  it('versieht reservierte Windows-Namen mit "_"', () => {
    expect(buildOutputFileName('CON.png', 'png', '')).toBe('_CON.png');
    expect(buildOutputFileName('nul.jpg', 'jpeg', '')).toBe('_nul.jpg');
    expect(buildOutputFileName('Com1.png', 'png', 'x')).toBe('_Com1-x.png');
    expect(buildOutputFileName('lpt9.png', 'png', '')).toBe('_lpt9.png');
    expect(buildOutputFileName('aux.png', 'png', '')).toBe('_aux.png');
    expect(buildOutputFileName('prn.png', 'png', '')).toBe('_prn.png');
    expect(buildOutputFileName('COM0.png', 'png', '')).toBe('COM0.png');
    expect(buildOutputFileName('console.png', 'png', '')).toBe('console.png');
  });

  it('fällt bei leerem Namen auf "bild" zurück', () => {
    expect(buildOutputFileName('', 'png', 'x')).toBe('bild-x.png');
    expect(buildOutputFileName('.png', 'webp', 'x')).toBe('png-x.webp');
    expect(buildOutputFileName('...', 'png', 'x')).toBe('bild-x.png');
    expect(buildOutputFileName('\u0001.jpg', 'png', 'x')).toBe('bild-x.png');
  });

  it('kürzt überlange Namen ohne Zeichen zu zerteilen', () => {
    const long = `${'ä'.repeat(300)}.png`;
    const name = buildOutputFileName(long, 'png', 'konvertiert');
    expect(name).toBe(`${'ä'.repeat(100)}-konvertiert.png`);
    const emoji = buildOutputFileName(`${'😀'.repeat(150)}.png`, 'png', 'x');
    expect(Array.from(emoji.replace('-x.png', ''))).toHaveLength(100);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('lässt leeres Suffix ohne Bindestrich weg', () => {
    expect(buildOutputFileName('a.png', 'jpeg', '')).toBe('a.jpg');
  });
});

describe('makeUniqueFileNames', () => {
  it('nummeriert Duplikate unabhängig von Groß-/Kleinschreibung', () => {
    expect(makeUniqueFileNames(['a-konvertiert.webp', 'A-konvertiert.webp', 'a-konvertiert.webp', 'b.webp'])).toEqual([
      'a-konvertiert.webp',
      'A-konvertiert-2.webp',
      'a-konvertiert-3.webp',
      'b.webp',
    ]);
  });

  it('vermeidet Kollisionen mit bereits vorhandenen nummerierten Namen', () => {
    expect(makeUniqueFileNames(['a.png', 'a-2.png', 'a.png'])).toEqual(['a.png', 'a-2.png', 'a-3.png']);
    expect(makeUniqueFileNames(['a.png', 'a.png', 'a-2.png'])).toEqual(['a.png', 'a-2.png', 'a-2-2.png']);
    expect(makeUniqueFileNames([])).toEqual([]);
  });
});

describe('buildFileName', () => {
  it('nutzt freie Endung und eigenen Ersatzstamm, sonst dieselben Regeln', () => {
    expect(buildFileName('Song.WAV', 'mp3', '', 'audio')).toBe('Song.mp3');
    expect(buildFileName('Song.mp3', 'mp3', 'konvertiert', 'audio')).toBe('Song-konvertiert.mp3');
    expect(buildFileName('‮⁧.flac', 'ogg', '', 'audio')).toBe('audio.ogg');
    expect(buildFileName('../a.wav', 'flac', '', 'audio')).toBe('_a.flac');
    expect(buildFileName('CON.wav', 'wav', '', 'audio')).toBe('_CON.wav');
  });

  it('liefert für Bildformate dasselbe wie buildOutputFileName', () => {
    expect(buildFileName('foto.png', 'jpg', 'klein', 'bild')).toBe(buildOutputFileName('foto.png', 'jpeg', 'klein'));
  });
});
