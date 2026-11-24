// Big Bundle Wright: build everything and package it as one ZIP.
// Volume PDFs, master index, Word indexes, labels, compliance report (PDF + JSON)
// and the project file.
// SPDX-License-Identifier: MPL-2.0

import JSZip from 'jszip';
import { buildBundle, outputBaseName, type BuildInput, type BuildOutput } from './build.ts';
import { complianceFileBase, complianceReport, complianceReportPdf, type ComplianceReport } from './compliance.ts';
import { buildDocxIndexes } from './docx-index.ts';
import { buildLabels } from './labels.ts';
import { serializeProject } from './project-io.ts';
import { safeFileName } from './util.ts';

export type ExportFileKind = 'volume' | 'master-index' | 'docx-index' | 'labels' | 'report-pdf' | 'report-json' | 'project';

export interface ExportFile {
  name: string;
  kind: ExportFileKind;
  bytes: Uint8Array;
}

export type ExportProgress =
  | Parameters<NonNullable<BuildInput['onProgress']>>[0]
  | { phase: 'docx' | 'labels' | 'report' | 'zip'; done: number; total: number };

export interface ExportInput extends Omit<BuildInput, 'onProgress' | 'prelimsOnly'> {
  onProgress?: (p: ExportProgress) => void;
  /** Leave out the Word indexes (default: included). */
  noDocx?: boolean;
  /** Leave out the labels PDF (default: included). */
  noLabels?: boolean;
}

export interface ExportOutput {
  build: BuildOutput;
  report: ComplianceReport;
  /** Every file in the ZIP, in ZIP order. */
  files: ExportFile[];
  zip: Uint8Array;
  zipName: string;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Build cancelled', 'AbortError');
}

const enc = new TextEncoder();

/** "HCA 1234-2025 Chan v Wong Trial Bundle.zip". */
export function zipFileName(project: BuildInput['project']): string {
  return `${[outputBaseName(project), safeFileName(project.case.bundleTitle)].filter(Boolean).join(' ')}.zip`;
}

export async function exportBundle(input: ExportInput): Promise<ExportOutput> {
  const { project, signal, onProgress } = input;
  const created = input.date ?? new Date();
  const build = await buildBundle({ ...input, date: created, prelimsOnly: false, onProgress });
  const files: ExportFile[] = [];
  for (const v of build.volumes) files.push({ name: v.fileName, kind: 'volume', bytes: v.bytes });
  if (build.masterIndex) files.push({ name: build.masterIndex.fileName, kind: 'master-index', bytes: build.masterIndex.bytes });

  const issued = build.issuedProject ?? project;
  if (!input.noDocx) {
    checkAbort(signal);
    onProgress?.({ phase: 'docx', done: 0, total: 1 });
    for (const d of await buildDocxIndexes(issued, build.plan, { bilingual: build.bilingual })) files.push({ name: d.fileName, kind: 'docx-index', bytes: d.bytes });
  }
  if (!input.noLabels) {
    checkAbort(signal);
    onProgress?.({ phase: 'labels', done: 0, total: 1 });
    const l = await buildLabels(issued, build.plan, { fonts: input.fonts, bilingual: build.bilingual, date: created });
    files.push({ name: l.fileName, kind: 'labels', bytes: l.bytes });
  }

  checkAbort(signal);
  onProgress?.({ phase: 'report', done: 0, total: 1 });
  const report = complianceReport(issued, build, { date: created, labelsIncluded: !input.noLabels });
  const base = complianceFileBase(project);
  files.push({ name: `${base}.pdf`, kind: 'report-pdf', bytes: await complianceReportPdf(report, { fonts: input.fonts, date: created }) });
  files.push({ name: `${base}.json`, kind: 'report-json', bytes: enc.encode(`${JSON.stringify(report, null, 2)}\n`) });
  files.push({ name: `${outputBaseName(project)} project.json`, kind: 'project', bytes: enc.encode(serializeProject(issued)) });

  checkAbort(signal);
  const zip = new JSZip();
  for (const f of files) {
    // PDFs and .docx are already compressed.
    const deflate = f.kind === 'report-json' || f.kind === 'project';
    zip.file(f.name, f.bytes, { date: created, binary: true, compression: deflate ? 'DEFLATE' : 'STORE' });
  }
  onProgress?.({ phase: 'zip', done: 0, total: 100 });
  const bytes = await zip.generateAsync({ type: 'uint8array', platform: 'DOS' }, (m) => onProgress?.({ phase: 'zip', done: Math.round(m.percent), total: 100 }));
  checkAbort(signal);
  return { build, report, files, zip: bytes, zipName: zipFileName(project) };
}
