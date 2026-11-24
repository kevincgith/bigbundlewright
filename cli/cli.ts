#!/usr/bin/env node
// Big Bundle Wright: command-line interface (for headless use and testing).
// SPDX-License-Identifier: MPL-2.0

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildBundle, describeDeadline, lodgingDeadline, parseProject, planProject, freezeProject, serializeProject,
  ProjectError, SourceError, type PageAnalysis,
} from '../src/engine/index.ts';
import { analyse, initProject, loadFonts, loadProjectSources } from './node-support.ts';

const HELP = `Big Bundle Wright: court bundles fit for a 大狀 (PD 5.6)

Usage:
  bigbundle-wright init <folder> [-o project.json] [--action "HCA 1234/2025"] [--title "Chan v Wong"]
  bigbundle-wright build <project.json> [--files <folder>] [--out <folder>] [--limit 250] [--no-analyse] [--no-fonts] [--issue]
  bigbundle-wright issue <project.json>      lock page numbers so later documents go in as 88-1, 88-2…
  bigbundle-wright deadline <hearing date YYYY-MM-DD>
`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      files: { type: 'string' },
      action: { type: 'string' },
      title: { type: 'string' },
      limit: { type: 'string' },
      'no-analyse': { type: 'boolean' },
      'no-fonts': { type: 'boolean' },
      issue: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
    },
  });
  const log = (s: string) => { if (!values.quiet) console.log(s); };

  if (cmd === 'init') {
    const dir = resolve(positionals[0] ?? '.');
    const { project, errors } = await initProject(dir, { actionNo: values.action, shortTitle: values.title });
    const out = resolve(values.out ?? join(dir, 'project.json'));
    await writeFile(out, JSON.stringify(project, null, 2));
    log(`Wrote ${out}: ${project.docs.length} documents, ${project.files.reduce((a, f) => a + f.pageCount, 0)} pages.`);
    for (const e of errors) console.error(`  Error: ${e.message}`);
    return errors.length ? 2 : 0;
  }

  if (cmd === 'build') {
    const projPath = resolve(positionals[0] ?? 'project.json');
    const { project, warnings: loadWarnings } = parseProject(await readFile(projPath, 'utf8'));
    loadWarnings.forEach((w) => log(`  Note: ${w}`));
    if (values.limit) project.settings.maxPagesPerVolume = Number(values.limit);
    const filesDir = resolve(values.files ?? dirname(projPath));
    const outDir = resolve(values.out ?? join(dirname(projPath), 'out'));
    const { sources, notes } = await loadProjectSources(project, filesDir);
    notes.forEach((n) => log(`  Note: ${n}`));
    let analysis: Map<string, PageAnalysis[]> | undefined;
    if (!values['no-analyse']) {
      analysis = new Map();
      let i = 0;
      for (const [id, src] of sources) {
        analysis.set(id, await analyse(src));
        log(`  analysed ${++i}/${sources.size}: ${src.ref.name}`);
      }
    }
    // The vendored Noto TC fonts (fonts/) give Chinese text and bilingual headings.
    const fonts = values['no-fonts'] ? undefined : await loadFonts();
    const result = await buildBundle({ project, sources, analysis, issue: values.issue, fonts });
    await mkdir(outDir, { recursive: true });
    for (const v of result.volumes) {
      await writeFile(join(outDir, v.fileName), v.bytes);
      const front = `${v.frontSheetPages ? `${v.frontSheetPages} status + ` : ''}${v.prelimPages - v.frontSheetPages} index`;
      log(`  OK ${v.fileName}: ${v.pageCount} pages (${front} + pages ${v.firstLabel}–${v.lastLabel})`);
    }
    if (result.masterIndex) {
      await writeFile(join(outDir, result.masterIndex.fileName), result.masterIndex.bytes);
      log(`  OK ${result.masterIndex.fileName}`);
    }
    await writeFile(join(outDir, 'build-report.json'), JSON.stringify({ warnings: result.warnings }, null, 2));
    if (result.issuedProject) {
      await writeFile(projPath, serializeProject(result.issuedProject));
      log(`  OK Issued: page numbers are now locked in ${projPath}`);
    }
    if (result.warnings.length) {
      log(`\n${result.warnings.length} warning(s):`);
      for (const w of result.warnings) log(`  Warning [${w.code}] ${w.message}`);
    }
    return 0;
  }

  if (cmd === 'issue') {
    const projPath = resolve(positionals[0] ?? 'project.json');
    const { project } = parseProject(await readFile(projPath, 'utf8'));
    const plan = await planProject(project);
    await writeFile(projPath, serializeProject(freezeProject(project, plan, new Date().toISOString())));
    log(`Issued ${projPath}: ${plan.main.volumes.length} main volume(s); page numbers are now locked.`);
    return 0;
  }

  if (cmd === 'deadline') {
    const r = lodgingDeadline(positionals[0]);
    log(describeDeadline(r));
    for (const e of r.excluded) log(`  skipped ${e.date}: ${e.reason}`);
    log(`  holidays: ${r.source}`);
    return 0;
  }

  console.log(HELP);
  return cmd ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e instanceof SourceError || e instanceof ProjectError ? `Error: ${e.message}` : e);
  process.exit(1);
});
