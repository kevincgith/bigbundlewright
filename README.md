# Big Bundle Wright

*Court bundles fit for a 大狀*

A free, browser-only tool that turns a set of PDFs into trial bundles that follow Hong Kong
**Practice Direction 5.6** (Documents for Use at Trial). Your documents never leave your device.

> Status: in development. Stages 2–3 (engine, CLI, core/transcript bundles, 88-1 inserts, save/load) are done. The browser UI comes in stage 4.
> A full README (PD 5.6 mapping, privacy, deployment) comes in stage 6.

## Engine and CLI (Node 24+)

```bash
npm install
npm run fixtures                      # generate the test documents
npm test                              # PD 5.6 checks on real generated PDFs
node cli/cli.ts init <folder> --action "HCA 1234/2025" --title "Chan v Wong"
node cli/cli.ts build <folder>/project.json --out <output folder> [--issue] [--zip]
                                      # --zip: one ZIP with volume PDFs, master index, Word indexes,
                                      # labels, PD 5.6 compliance report (PDF + JSON) and project file
node cli/cli.ts issue <folder>/project.json   # lock page numbers; later documents go in as 88-1…
node cli/cli.ts deadline 2026-04-08   # PD 5.6 para 8 lodging deadline
```

Chinese (Traditional) text and bilingual headings use the vendored Noto Serif TC / Noto Sans TC
fonts in [`fonts/`](fonts/README.md) (SIL OFL 1.1), subset-embedded so only the characters used go
into each PDF. The CLI loads them automatically (`--no-fonts` to use the PDF standard fonts).

Design notes and decisions: [docs/stage-1-design.md](docs/stage-1-design.md).

## Licence and credits

Licensed under the [Mozilla Public License 2.0](LICENSE).

Big Bundle Wright was informed by **BunTool** by Tristan Sherliker
(<https://github.com/TrisSherliker/buntool2>, MPL 2.0), whose pipeline design (two-pass index,
recording index row positions for hyperlinks, bookmarks per entry) it follows. No BunTool source
code has been copied so far; any file adapted from BunTool will keep its MPL notice and say so.
This project is not affiliated with or endorsed by BunTool.

Hong Kong general holiday data: HKSAR Government, <https://www.1823.gov.hk/common/ical/en.json>
(snapshot 24 Nov 2026, covering 2025–2027).

*A formatting tool, not legal advice. You are responsible for compliance with PD 5.6 and any
directions of the court.*
