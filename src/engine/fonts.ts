// Big Bundle Wright: font set used for index pages and stamps.
// Stage 2 uses the PDF standard fonts (Latin only). Stage 5 swaps in subset
// Noto Serif TC / Noto Sans TC through the same interface.
// SPDX-License-Identifier: MPL-2.0

import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

export interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  stamp: PDFFont;
  /** Replace characters the fonts cannot encode with "?" and remember them. */
  safe(text: string): string;
  unsupported: Set<string>;
}

export async function standardFontSet(doc: PDFDocument): Promise<FontSet> {
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const stamp = await doc.embedFont(StandardFonts.HelveticaBold);
  const ok = new Map<string, boolean>();
  const unsupported = new Set<string>();
  const safe = (text: string) => {
    let out = '';
    for (const ch of text) {
      if (ch === "\n") { out += ch; continue; }
      let good = ok.get(ch);
      if (good === undefined) {
        try { regular.encodeText(ch); good = true; } catch { good = false; }
        ok.set(ch, good);
      }
      if (good) out += ch;
      else { unsupported.add(ch); out += '?'; }
    }
    return out;
  };
  return { regular, bold, italic, stamp, safe, unsupported };
}
