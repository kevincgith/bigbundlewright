# Fonts

Vendored so that Big Bundle Wright makes no network requests at runtime.
Used for Chinese (Traditional) text and bilingual headings in index pages,
status front sheets, labels and page-number stamps.

| File | Size | Made from |
|---|---|---|
| `NotoSerifTC-Regular.ttf` | 10.0 MB | `ofl/notoseriftc/NotoSerifTC[wght].ttf`, wght=400 |
| `NotoSerifTC-Bold.ttf` | 10.0 MB | `ofl/notoseriftc/NotoSerifTC[wght].ttf`, wght=700 |
| `NotoSansTC-Bold.ttf` | 7.2 MB | `ofl/notosanstc/NotoSansTC[wght].ttf`, wght=700 |

Source: <https://github.com/google/fonts> (`main`, downloaded 24 Nov 2026).
Noto Serif TC version 2.003 (sha256 of the variable font
`0077e18f57c6908f4a000969880940bdb0dad057c0e8d98b49dc364c3d1b09c6`);
Noto Sans TC version 2.004 (`864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f`).

These are **modified versions** under the SIL Open Font License 1.1
(`OFL.txt` for Noto Serif TC, `OFL-NotoSansTC.txt` for Noto Sans TC):
`make_static.py` (fontTools 4.63) instanced each variable font at a fixed weight
and padded the glyph data to 4 bytes. Nothing else changed.

Why TrueType static instances and not the official OTF builds: pdf-lib's fontkit
subsetter corrupts CID-keyed CFF (OTF) CJK fonts (glyphs vanish when rendered),
and writes short `loca` offsets without padding odd-length glyphs, which breaks
TrueType fonts whose glyph data is unpadded. Padded static TTFs subset correctly;
`test/fonts.test.ts` renders and extracts Chinese text to prove it.
