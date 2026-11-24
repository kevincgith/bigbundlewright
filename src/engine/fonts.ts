// Big Bundle Wright: font set used for index pages, labels and stamps.
// Without font bytes: the PDF standard fonts (Latin only), as in stage 2.
// With font bytes (BuildInput.fonts): subset-embedded Noto Serif TC / Noto Sans TC,
// so Chinese (Traditional) text renders. The engine never fetches fonts itself.
// SPDX-License-Identifier: MPL-2.0

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

/** Raw font files (TrueType) supplied by the caller. See `FONT_FILES` for the vendored names. */
export interface FontBytes {
  /** Noto Serif TC Regular: index body text. */
  serifRegular: Uint8Array;
  /** Noto Serif TC Bold: headings. */
  serifBold: Uint8Array;
  /** Noto Sans TC Bold: labels and page-number stamps. Falls back to serifBold. */
  sansBold?: Uint8Array;
}

/** File names under `fonts/` at the repo root, by `FontBytes` key. */
export const FONT_FILES = {
  serifRegular: 'NotoSerifTC-Regular.ttf',
  serifBold: 'NotoSerifTC-Bold.ttf',
  sansBold: 'NotoSansTC-Bold.ttf',
} as const satisfies Record<keyof FontBytes, string>;

export interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  /** Italic. With the Noto set this is the regular face, drawn oblique (see `oblique`). */
  italic: PDFFont;
  stamp: PDFFont;
  /** Bold face for labels (sans). */
  label: PDFFont;
  /** Draw `italic` text with a synthetic slant (the Noto TC fonts have no italic). */
  oblique: boolean;
  /** The fonts cover Chinese (Traditional). */
  cjk: boolean;
  /** Replace characters the fonts cannot encode with "?" and remember them. */
  safe(text: string): string;
  unsupported: Set<string>;
}

function makeSafe(has: (ch: string) => boolean) {
  const ok = new Map<string, boolean>();
  const unsupported = new Set<string>();
  const safe = (text: string) => {
    let out = '';
    for (const ch of text) {
      if (ch === '\n') { out += ch; continue; }
      let good = ok.get(ch);
      if (good === undefined) { good = has(ch); ok.set(ch, good); }
      if (good) out += ch;
      else { unsupported.add(ch); out += '?'; }
    }
    return out;
  };
  return { safe, unsupported };
}

export async function standardFontSet(doc: PDFDocument): Promise<FontSet> {
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const stamp = await doc.embedFont(StandardFonts.HelveticaBold);
  const { safe, unsupported } = makeSafe((ch) => {
    try { regular.encodeText(ch); return true; } catch { return false; }
  });
  return { regular, bold, italic, stamp, label: stamp, oblique: false, cjk: false, safe, unsupported };
}

type GlyphCheck = { hasGlyphForCodePoint(cp: number): boolean };

/** The fontkit font behind an embedded custom PDFFont (for glyph coverage checks). */
function fontkitOf(f: PDFFont): GlyphCheck {
  return (f as unknown as { embedder: { font: GlyphCheck } }).embedder.font;
}

/** Subset-embedded Noto TC fonts. Only the glyphs used end up in the PDF. */
export async function notoFontSet(doc: PDFDocument, bytes: FontBytes): Promise<FontSet> {
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(bytes.serifRegular, { subset: true });
  const bold = await doc.embedFont(bytes.serifBold, { subset: true });
  const label = bytes.sansBold ? await doc.embedFont(bytes.sansBold, { subset: true }) : bold;
  const faces = [regular, bold, label].map(fontkitOf);
  // Every face that may draw the text must have the glyph, or it would show as an empty box.
  const { safe, unsupported } = makeSafe((ch) => faces.every((f) => f.hasGlyphForCodePoint(ch.codePointAt(0)!)));
  return { regular, bold, italic: regular, stamp: label, label, oblique: true, cjk: true, safe, unsupported };
}

export function fontSetFor(doc: PDFDocument, bytes?: FontBytes): Promise<FontSet> {
  return bytes ? notoFontSet(doc, bytes) : standardFontSet(doc);
}

/** Characters outside Windows-1252 (what the standard fonts can show). */
const NON_LATIN = /[^\u0000-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201a\u201c-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/u;

/**
 * Whether a project needs the Noto TC fonts: bilingual headings are on, or some text that goes
 * into the index, front sheet or labels has characters the standard fonts cannot show.
 * A browser can use this to fetch the (large) font files only when needed.
 */
export function projectNeedsCjkFonts(project: {
  settings: { bilingualHeadings: boolean; stamp: { prefix: string } };
  case: { court: string; actionNo: string; actionLine?: string; parties: { name: string; role: string }[]; shortTitle: string; bundleTitle: string };
  docs: { description: string; descriptionZh?: string }[];
  sections: { title: string; titleZh?: string }[];
}): boolean {
  if (project.settings.bilingualHeadings) return true;
  const c = project.case;
  const texts = [
    c.court, c.actionNo, c.actionLine ?? '', c.shortTitle, c.bundleTitle, project.settings.stamp.prefix,
    ...c.parties.flatMap((p) => [p.name, p.role]),
    ...project.docs.flatMap((d) => [d.description, d.descriptionZh ?? '']),
    ...project.sections.flatMap((s) => [s.title, s.titleZh ?? '']),
  ];
  return texts.some((t) => NON_LATIN.test(t));
}
