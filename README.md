# Big Bundle Wright

*Court bundles fit for a 大狀*

Big Bundle Wright is a free web tool that turns a set of PDFs into trial bundles following Hong Kong
**Practice Direction 5.6** (Documents for Use at Trial, effective 2 April 2009). It is published on
GitHub Pages and runs entirely in your browser: **your documents never leave your device.**

*A formatting tool, not legal advice. You are responsible for compliance with PD 5.6 and any
directions of the court.*

## What it does

Add PDFs (or JPG/PNG, converted to A4 pages), check the dates and descriptions it reads from the
file names, and build:

- the bundle in volumes of no more than 250 pages, each with its own index and a status front sheet;
- a master index linking into every volume;
- a core bundle (C1, C2…) and a separate transcript bundle (T1, T2…);
- page numbers in the top right-hand corner on a white box, with links from every index entry and
  bookmarks showing page numbers.

Once a bundle is issued, its page numbers are locked: later documents go in as 88-1, 88-2…
without renumbering anything.

## PD 5.6 mapping

| PD 5.6 | What Big Bundle Wright does |
|---|---|
| Para 1: no unnecessary documents | Reminder in the app |
| Para 1: additional documents | After issue, documents inserted after page 88 are numbered 88-1, 88-2, 88-3 (never letters); existing numbers never change; index rows and bookmarks are added |
| Para 2: core bundle over 100 pages | Prompts you to tag core documents; builds a Core Bundle with its own numbering and a cross-reference column to the main bundle pages |
| Para 3 / O.27 r.4: status of documents | Status per document (authentic / inclusion only / evidence of contents), shown in the index and on a front sheet in each volume |
| Para 4(2): chronological order | Sorted by date by default; manual order allowed, with a warning when out of order |
| Para 4(3): paged consecutively, top right | Consecutive across all files (or A1/B1 per file if you prefer); stamped top right on a white box; if the corner has content, the page is reduced slightly to keep the number clear, and the report says so |
| Para 4(4), 6: legibility | Flags pages that are images with no text, and content within 5 mm of the edge; typed copies can be interleaved after an illegible page |
| Paras 4-5: transcripts separate | Documents of type "transcript" always go in their own bundle |
| Para 5: at most 250 pages per file | Splits into Bundle A, B…; a document is split only if it alone exceeds the limit |
| Para 7: more than 5 bundles | Warns that inside-cover labels are needed (labels are produced with the export) |
| Para 8: lodging 72 hours before | Works out the deadline from the hearing date, skipping weekends and Hong Kong general holidays (2025-2027) |

## Privacy

- All processing happens in your browser, in a background worker. Files are never uploaded.
- No analytics, no cookies, no third-party requests: every library is bundled with the site,
  nothing is loaded from a CDN, and a Content Security Policy blocks connections to other sites.
- Nothing is kept after you close the tab, unless you save a project file (which holds only the
  document list, dates, descriptions, settings and file fingerprints, never document contents) or
  tick "Remember project details", which stores the same metadata in this browser only.

## Using it

1. Enter the case details (court, action number, parties, short title). Add a hearing date to see
   the lodging deadline.
2. Add documents. Dates and titles are read from names like `2024-03-15 Letter to D.pdf`.
   Set type, status and core flags; reorder by dragging or with Alt+arrow keys.
3. Optionally change settings (numbering style, sections, date format…). Defaults follow PD 5.6.
4. Build. "Build and issue" locks the page numbers; save the project file so you can add
   documents later. To add them, open the project, add the files again (they are recognised by
   content), add the new documents and set "Insert after page".

Not supported yet: Word, email and other non-PDF files (convert to PDF first), password-protected
PDFs (remove the protection first), and OCR.

## Development

Requires Node.js 24 or later.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine checks on generated PDFs
npm run build      # static site in dist/
```

The engine (`src/engine`) is a pure module with no browser dependencies, so it also runs from the
command line:

```bash
node cli/cli.ts init <folder> --action "HCA 1234/2025" --title "Chan v Wong"
node cli/cli.ts build <folder>/project.json --out <output folder> [--issue]
node cli/cli.ts issue <folder>/project.json
node cli/cli.ts deadline 2026-04-08
```

Design notes and decisions: [docs/stage-1-design.md](docs/stage-1-design.md).

## Deployment

Pushing to `main` runs `.github/workflows/pages.yml`: type check, tests, build, then deploy `dist/`
to GitHub Pages. In the repository settings, set Pages to deploy from "GitHub Actions".

## Licence and credits

Licensed under the [Mozilla Public License 2.0](LICENSE).

Big Bundle Wright was informed by **BunTool** by Tristan Sherliker
(<https://github.com/TrisSherliker/buntool2>, MPL 2.0), whose pipeline design (two-pass index,
recording index row positions for hyperlinks, bookmarks per entry) it follows. No BunTool source
code has been copied; any file adapted from BunTool will keep its MPL notice and say so.
This project is not affiliated with or endorsed by BunTool.

Third-party components, all bundled: [pdf-lib](https://github.com/Hopding/pdf-lib) and fontkit
(MIT), [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0).

Hong Kong general holiday data: HKSAR Government, <https://www.1823.gov.hk/common/ical/en.json>
(snapshot 24 Nov 2026, covering 2025-2027).
