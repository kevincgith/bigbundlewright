# Big Bundle Wright: Stage 1 design

*Court bundles fit for a 大狀*

Status: **draft for review**. Nothing is built yet. This doc covers the reference
analysis, the PD 5.6 reading, the proposed structure and data model, the licence
choice, and the open questions that need your decision.

---

## 1. The BunTool reference

Cloned to `./reference` (commit `837946f`, 10 May 2026). Its write permission is
removed and git ignores it. Nothing from it has been run.

### 1.1 What is in the repo

| File | Notes |
|---|---|
| `buntoolMain.js` | Orchestrator, `processTheBundle(filesMap, indexData, config, onProgress)` |
| `buntoolFunctions.js` | Merge, TOC, pagination, links, outlines, metadata |
| `buntoolConfig.js` | Options class with whitelists and validation |
| `buntoolRestore.js` | Unpacks an existing bundle. Stub, written by AI |
| `frontend.js` | **UI glue is in the repo** (1,156 lines), but the HTML and CSS are not |
| `js/*.js` | An **older** duplicate of the above (it has an off-by-one in link targets). The root copies are canonical |
| `fonts/` | Noto Serif/Sans, EB Garamond, Plus Jakarta, Ubuntu Mono (OFL/UFL). No CJK |

Two things matter for our privacy rules:
- Every library loads **from CDNs at runtime** (jsDelivr, esm.sh).
- `frontend.js` POSTs a "bundle event" to a `val.run` endpoint when it is served
  from buntool.co.uk.

We copy neither pattern.

### 1.2 Pipeline (`processTheBundle`, 11 steps)

1. **Validate the config structure.** Checks that the required keys exist.
2. **Validate the config options.** Checks values against whitelists (fonts,
   alignment, numbering style, date style, outline style).
3. **`createTocEntries`.** Walks `indexData`, which is a flat list of rows, each
   either a file row or a `sectionMarker` row. For each file row it assigns a
   sequential `tabNumber` and a 1-based `thisPage`. That page is relative to the
   *content* and excludes the index. In "printable" mode it adds a blank page
   after any document with an odd page count.
4. **`makeDummyTocPages`.** Renders the index once with jsPDF + autotable and
   counts its pages with muPDF. This is the standard two-pass trick: you need
   the index length before you know the final page numbers.
5. **`makeTocPages`.** Renders the real index, a jsPDF A4 page with:
   - the claim number top-right;
   - the project name, then the bundle title between tramlines;
   - an autotable of Tab / Title / Date / Page, where `actualStartPage` =
     `thisPage + tocLength`, so **the index pages are numbered too**.

   autotable's `didDrawCell` hook records each row's x, y, width, height and page
   in millimetres, for hyperlinking later.
6. **`mergePdfsByTOC`.** pdf-lib (`@cantoo/pdf-lib` fork) `copyPages` per file,
   in index order. It does no normalisation: no A4 fit, no rotation, and no
   handling of encryption or corrupt files beyond a thrown error.
7. **`mergeTwoPdfs`.** Puts the index in front of the content.
8. **`addPageNumberingToPdf`.** pdf-lib `drawText` puts one consecutive number
   on every page, in the **footer**. Alignment can be left, centre or right.
   There is no backing box and no collision check. Two zero-width spaces are
   prepended so the number can be found by search later.
9. **`addHyperlinks`.** **muPDF** (WASM) `page.createLink` turns each recorded
   index row (mm → pt) into a GoTo link to the entry's start page.
10. **`addOutlineItems`.** muPDF builds a flat outline: "[00] Index" first, then
    one bookmark per entry, with the page optionally shown in the title. There is
    no nesting under section headings.
11. **`setMetadata`.** muPDF sets Title, Subject, Keywords and Producer. It stores
    the config JSON in a custom `info:BundleIndex` key, and the entries JSON in an
    invisible zero-size FreeText annotation on page 1. Restore relies on that.

Each pass serialises the PDF to bytes and parses it again, about 6 full
round-trips in total. That works for small bundles but is slow and
memory-hungry at 1,500 pages.

### 1.3 What we keep, change and drop

| Idea | Decision |
|---|---|
| Two-pass index (measure, then render with final numbers) | **Keep.** We lay out the index ourselves, so we can measure without rendering |
| Record index row rectangles while drawing, then add links | **Keep**, done in the same pass |
| Entries model: flat rows with section markers, a tab number and a start page | **Keep** as the conceptual model, extended (§3) |
| jsPDF + autotable for the index | **Drop.** It is a second PDF library and has weak CJK support. We draw the index directly with pdf-lib + fontkit, which gives exact coordinates and one font pipeline |
| muPDF for links, outlines and metadata | **Drop.** muPDF.js is **AGPL-3.0**, which is incompatible with an MIT or MPL release unless the whole app goes AGPL. It is also a ~10 MB WASM binary. pdf-lib's low-level API can write `/Link` annotations and `/Outlines` dictionaries directly |
| Footer page number | **Replace** with a top-right stamp on a white box, with a collision check (§2) |
| Repeated save/load per step | **Replace** with one `PDFDocument` per volume, built once and saved once |
| Hidden annotation carrying the index | **Drop.** The project JSON is our save format, and hidden data in a court document is a disclosure risk |

What we take from BunTool is ideas and data shapes, not much code. Where a
function is genuinely adapted, for example the TOC-entry builder or the
outline-title formatter, it goes in `src/engine/adapted/` with the MPL header kept.

---

## 2. PD 5.6, as read

Source: <https://legalref.judiciary.hk/lrs/common/pd/pdcontent.jsp?pdn=PD5.6.htm&lang=EN>
(dated 12 Feb 2009, effective 2 Apr 2009, with no amendment shown). Your
requirement list maps cleanly onto paras 1 to 8. The points below are where the
text is silent or open to more than one reading; they become the questions in §6.

- **Para 4(3)**, "paged consecutively on the top right-hand corner". It does not
  say whether the **index pages** are numbered (BunTool numbers them), or whether
  the numbering runs across files. Your default (consecutive across the set)
  is the natural reading.
- **Para 1**, "88-1, 88-2, 88-3". "88" is the page the documents are inserted
  after. This is clear.
- **Para 2**, core bundle "where the agreed bundle exceeds 100 pages". It does
  not say whether index and front-sheet pages count, or whether transcripts count.
- **Para 3**, "marked on the front of the bundle". It does not say whether the
  front sheet goes in every volume or only Bundle A.
- **Para 5**, "transcripts in a separate bundle". It does not say how that bundle
  is paginated.
- **Para 6**, typed copies "interleaved at the appropriate place". It does not
  say how the interleaved page is numbered.
- **Para 7**, "more than 5 bundles". It does not say whether the core and
  transcript bundles count towards the 5.
- **Para 8**, "at least 72 hours before the date fixed for the hearing (excluding
  Saturdays, Sundays and general holidays)". The clock's anchor point (midnight
  starting the hearing date, or the listed hearing time) is not stated.

**Holidays.** The gov.hk feed <https://www.1823.gov.hk/common/ical/en.json>
returned 51 general holidays covering 2025–2027 on 24 Nov 2026. I will snapshot it
into `src/data/hk-general-holidays.json` with the source URL and the date fetched.
The calculator will refuse dates outside the covered range rather than guess.

---

## 3. Data model (TypeScript)

```ts
type DocType = 'document' | 'pleading' | 'witness_statement' | 'expert'
             | 'correspondence' | 'transcript';
type DocStatus = 'authentic' | 'inclusion_only' | 'evidence_of_contents';   // PD 5.6 para 3 (1)/(2)/(3)

interface SourceFile {            // never serialised with bytes
  id: string;                     // uuid
  name: string;                   // original filename
  sha256: string;                 // content hash: duplicate detection + reload check
  kind: 'pdf' | 'image';
  pageCount: number;
  pages: PageAnalysis[];          // filled by the analyser
}

interface PageAnalysis {
  index: number;
  widthPt: number; heightPt: number; rotate: 0|90|180|270;
  landscape: boolean;
  hasText: boolean;               // false → "image-only / unsearchable" flag
  cornerOccupied: boolean;        // top-right stamp zone has ink → shrink-to-fit
  edgeInk: ('top'|'right'|'bottom'|'left')[];  // content within binding/stamp margin
}

interface BundleDoc {
  id: string;
  fileId: string;                 // → SourceFile
  date: string | null;            // ISO yyyy-mm-dd; null = undated
  dateApprox?: boolean;           // "undated / c. 2023" support
  description: string;            // English
  descriptionZh?: string;         // optional 繁體中文
  type: DocType;
  status: DocStatus;
  core: boolean;
  sectionId?: string;             // when sections are on
  pageRange?: [number, number];   // subset of the source file (optional)
  typedCopies?: { afterSourcePage: number; fileId: string }[];  // para 6
}

interface Insert {                // para 1 additional documents
  id: string;
  afterPage: number;              // e.g. 88 → 88-1, 88-2 …
  docId: string;                  // a BundleDoc not in the main order
}

interface Section { id: string; letter: string; title: string; titleZh?: string; }

interface Project {
  schema: 'bigbundle-wright/project@1';
  case: { court: string; actionNo: string; parties: string; shortTitle: string;
          bundleTitle: string; hearingDate?: string; hearingTime?: string };
  settings: {
    maxPagesPerVolume: number;          // 250
    numbering: 'continuous' | 'per-volume-prefix';
    sectionsEnabled: boolean;
    bilingualHeadings: boolean;
    dateFormat: 'DD/MM/YYYY' | string;
    indexPagesNumbered: boolean;        // pending Q1
  };
  files: Omit<SourceFile, 'pages'>[];   // hashes only, no content
  docs: BundleDoc[];                    // in bundle order
  sections: Section[];
  inserts: Insert[];
  frozen?: FrozenLayout;                // set once a bundle is "issued"
}

// Once issued, page numbers are locked so later inserts don't renumber anything.
interface FrozenLayout {
  issuedAt: string;
  volumes: { letter: string; firstPage: number; lastPage: number; docIds: string[] }[];
  docStart: Record<string, number>;     // docId → first stamped page
}
```

**Engine output** is a `BuildPlan` (pure data, computed before any PDF is
written). It lists volumes, and per page records the stamp label, source
reference, transform (scale/rotate) and any warnings. The tests assert against
the plan *and* against text extracted from the finished PDFs.

---

## 4. Proposed repository structure

```
bigbundle-wright/
├─ src/
│  ├─ engine/                 # pure TS, no DOM; runs in Worker and Node
│  │  ├─ model.ts             # types above
│  │  ├─ plan.ts              # ordering, volumes, numbering, inserts → BuildPlan
│  │  ├─ analyse.ts           # page geometry, text presence, corner/edge ink
│  │  ├─ normalise.ts         # A4 fit, rotation, shrink-for-stamp
│  │  ├─ stamp.ts             # top-right number on white box
│  │  ├─ index-pdf.ts         # index + front sheet layout (pdf-lib + fontkit)
│  │  ├─ links.ts             # /Link annotations + /Outlines
│  │  ├─ build.ts             # orchestrator: BuildPlan → volume PDFs
│  │  ├─ core-bundle.ts, transcripts.ts, labels.ts, docx-index.ts, report.ts
│  │  ├─ deadline.ts          # para 8 calculator
│  │  ├─ project-io.ts        # save/load + hash verification
│  │  └─ adapted/             # MPL-2.0 files adapted from BunTool, notice kept
│  ├─ worker/                 # Web Worker wrapper with progress + cancel
│  ├─ ui/                     # vanilla TS UI
│  └─ data/hk-general-holidays.json
├─ cli/bbw-cli.ts             # Node CLI: project.json + folder → outputs
├─ test/                      # vitest; fixtures generated by script
├─ public/fonts/              # self-hosted, subset Noto Sans/Serif TC
├─ docs/
├─ Dockerfile, nginx.conf
└─ reference/                 # git-ignored BunTool clone
```

(The CLI file name is internal. Everywhere user-facing says "Big Bundle Wright".)

**Libraries** (pinned at install time):

| Library | Licence | Used for |
|---|---|---|
| `pdf-lib` + `@pdf-lib/fontkit` | MIT | Writing PDFs |
| `pdfjs-dist` | Apache-2.0 | **Analysis only**: whether a page has text (image-only flag), encryption detection, and rendering a low-res thumbnail of the corner and edges to detect ink. This avoids WASM; muPDF is excluded as AGPL. In Node, `@napi-rs/canvas` supplies the canvas |
| `docx` | MIT | The Word index |
| `jszip` | MIT / GPL-3.0 dual; we use it under MIT | The ZIP export |
| `vite`, `vitest`, `typescript` | — | Build and test |

**Performance.** Building one `PDFDocument` per volume and saving it once keeps
memory to roughly one volume plus the sources. The analysis pass renders only a
small corner and edge strip per page. Both run in a Worker that checks a cancel
flag between pages.

**A pdf-lib limitation to note now.** pdf-lib cannot open *encrypted* PDFs
(owner-password-only files included). We will detect them with pdf.js and give a
clear error naming the file, as you specified. We won't try to decrypt.

---

## 5. Licence for your own code

| | **MIT** | **MPL 2.0** |
|---|---|---|
| What a re-user must do | Keep the copyright notice | Publish changes to *our files* under MPL. They may combine our files with closed code in separate files |
| Mixing with the BunTool-adapted files | Works, but the repo becomes "MIT except `adapted/` is MPL", which needs a note in the README and in file headers | One licence across the whole repo; simpler |
| Corporate re-use (e.g. a firm forking it internally) | Easiest | Still easy. It only bites if they distribute modified files |
| Protects improvements from becoming closed forks | No | Yes, at file level |

**Recommendation: MPL 2.0.** Two reasons:
- The adapted files are MPL anyway, so one licence means no carve-outs to explain.
- File-level copyleft means a law-tech vendor can't take the engine, improve it
  and close it. Firms can still use it freely.

Choose MIT instead if your priority is maximum adoption with the fewest questions
from in-house IT or legal teams.

---

## 6. Questions for you (PD 5.6 ambiguities and design calls)

1. **Index pages.** Should the index and front sheet carry page numbers? PD 5.6
   is silent; BunTool numbers them.
   - (a) Unnumbered, so page 1 is the first page of the first document.
   - (b) Numbered as part of the consecutive run.
   - (c) Roman numerals (i, ii).

   I'd suggest (a). Then a rebuilt index can never shift document page numbers,
   which matters for 88-1 inserts.
2. **Front sheet (para 3).** Should it go at the front of **every volume**,
   showing only that volume's documents, or once in Bundle A covering the whole
   set? I'd suggest every volume, plus the full table in the master index.
3. **Core bundle threshold (para 2).** Does "agreed bundle exceeds 100 pages"
   count **document pages only**, excluding the index, front sheet and
   transcripts? I'd suggest yes.
4. **Transcript bundle pagination.** Its own run with a prefix (T1, T2…), or
   continuing the main sequence? I'd suggest a T-prefix, so adding transcripts
   late never disturbs the main numbers.
5. **Para 7 count.** Does "more than 5 bundles" include the core and transcript
   bundles, or only main volumes A, B, …? I'd suggest counting every physical
   file, which is the safer side.
6. **Typed copies (para 6).** How should an interleaved typed copy be numbered?
   - (a) As a normal page in the consecutive run.
   - (b) Like an insert (e.g. 45-1), so the original numbering is unaffected.

   I'd suggest (a) for a first build and (b) once numbers are frozen.
7. **Lodging deadline anchor (para 8).**
   - (a) Count back 72 working hours from 00:00 on the hearing date, i.e. by the
     end of the 3rd working day before.
   - (b) Count back from the listed hearing time (e.g. 10:00).

   I'd suggest (a), shown as "lodge by 23:59 on <date>", since (b) is the more
   aggressive reading.
8. **Landscape pages.** In a paper file a landscape page is bound with its top
   at the spine, so the number should go at the *portrait* top-right. On screen,
   you asked for auto-rotation so the page reads upright, which puts the stamp at
   the *landscape* top-right. Options:
   - (a) Rotate the page for screen reading and stamp the visual top-right.
   - (b) Keep it portrait-bound and stamp the sheet's top-right.

   I'd suggest (a) for the e-bundle, since that's what is lodged
   electronically, with (b) as a "print layout" option.
9. **Licence.** MPL 2.0 (recommended) or MIT?

---

## 7. Stage 2 plan (once you've answered)

Engine (`plan.ts` → `build.ts`) covering merge, A4 normalisation, top-right stamp
with shrink-to-fit, volumes ≤ limit without splitting documents, per-volume and
master index with links, and nested bookmarks. Plus the CLI, generated fixtures
(300+ pages, landscape, scan-only, CJK, transcript, encrypted, duplicate) and
vitest checks: stamps match the index, link and bookmark targets are correct, the
volume cap holds, and inserts don't renumber.
