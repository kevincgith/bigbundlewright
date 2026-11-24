// Big Bundle Wright: save and load the project file (structure, metadata and file
// hashes only; never document content).
// SPDX-License-Identifier: MPL-2.0

import {
  DEFAULT_SETTINGS, ProjectError,
  type DocStatus, type DocType, type Project, type Settings, type SourceFileRef,
} from './model.ts';
import { isValidIsoDate } from './util.ts';

export const PROJECT_SCHEMA = 'bigbundle-wright/project@1';

const DOC_TYPES: DocType[] = ['document', 'pleading', 'witness_statement', 'expert', 'correspondence', 'transcript'];
const STATUSES: DocStatus[] = ['authentic', 'inclusion_only', 'evidence_of_contents'];

export function serializeProject(p: Project): string {
  return `${JSON.stringify(p, null, 2)}\n`;
}

function mergeSettings(s: Partial<Settings> | undefined): Settings {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!s) return d;
  return { ...d, ...s, stamp: { ...d.stamp, ...(s.stamp ?? {}) }, index: { ...d.index, ...(s.index ?? {}) } };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const ENUMS: [string, (s: Settings) => unknown, readonly unknown[]][] = [
  ['numbering', (s) => s.numbering, ['continuous', 'per-volume', 'per-section']],
  ['sectionPrefix', (s) => s.sectionPrefix, ['', 'Section', 'Part']],
  ['dateStyle', (s) => s.dateStyle, ['DD/MM/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY', 'DD Mon. YYYY', 'DD Month YYYY', 'Mon. DD, YYYY', 'Month DD, YYYY', 'None']],
  ['outlineStyle', (s) => s.outlineStyle, ['plain', 'withPage', 'withDate', 'withDateAndPage']],
  ['stamp.style', (s) => s.stamp.style, ['X', 'PageX', 'XofY', 'XslashY', 'PageXofY', 'None']],
  ['stamp.position', (s) => s.stamp.position, ['top-right', 'top-centre', 'top-left', 'bottom-right', 'bottom-centre', 'bottom-left']],
  ['stamp.size', (s) => s.stamp.size, ['S', 'M', 'L']],
  ['stamp.colour', (s) => s.stamp.colour, ['black', 'red', 'blue']],
  ['index.headingSize', (s) => s.index.headingSize, ['S', 'M', 'L']],
  ['index.tableSize', (s) => s.index.tableSize, ['S', 'M', 'L']],
];
const BOOLS: [string, (s: Settings) => unknown][] = [
  ['sectionsEnabled', (s) => s.sectionsEnabled], ['bilingualHeadings', (s) => s.bilingualHeadings], ['printable', (s) => s.printable],
  ['frontSheet', (s) => s.frontSheet], ['index.borders', (s) => s.index.borders],
];

/** Section letters become page-number prefixes, so they must be plain, unique ASCII letters. */
export function validSectionLetter(letter: string): boolean {
  return /^[A-Z]{1,3}$/.test(letter);
}

/** Types and ranges of everything the engine relies on, so a bad file fails clearly instead of crashing. */
function validateShape(project: Project) {
  const c = project.case as unknown as Record<string, unknown>;
  for (const k of ['court', 'actionNo', 'shortTitle', 'bundleTitle'] as const) {
    if (!isStr(c[k])) throw new ProjectError(`The case "${k}" must be text.`);
  }
  if (c.actionLine !== undefined && !isStr(c.actionLine)) throw new ProjectError('The case "actionLine" must be text.');
  if (!Array.isArray(c.parties) || !c.parties.every((p) => p && isStr((p as { name: unknown }).name) && isStr((p as { role: unknown }).role))) {
    throw new ProjectError('The parties must be a list of names and roles.');
  }
  if (c.hearingDate !== undefined && c.hearingDate !== '' && !(isStr(c.hearingDate) && isValidIsoDate(c.hearingDate))) {
    throw new ProjectError(`The hearing date "${String(c.hearingDate)}" is not a valid date (use YYYY-MM-DD).`);
  }
  if (c.hearingDate === '') delete c.hearingDate;
  const s = project.settings;
  if (!Number.isInteger(s.maxPagesPerVolume) || s.maxPagesPerVolume < 10 || s.maxPagesPerVolume > 5000) {
    throw new ProjectError(`The page limit per file must be a whole number from 10 to 5000 (it is "${String(s.maxPagesPerVolume)}").`);
  }
  for (const [name, get, ok] of ENUMS) {
    if (!ok.includes(get(s))) throw new ProjectError(`The setting "${name}" has an unknown value "${String(get(s))}".`);
  }
  for (const [name, get] of BOOLS) {
    if (typeof get(s) !== 'boolean') throw new ProjectError(`The setting "${name}" must be true or false.`);
  }
  if (!isStr(s.stamp.prefix)) throw new ProjectError('The page-number prefix must be text.');
  const letters = new Set<string>();
  const ids = new Set<string>();
  for (const sec of project.sections) {
    if (!sec || !isStr(sec.id) || !isStr(sec.title) || !isStr(sec.letter)) throw new ProjectError('Each section needs an id, a letter and a title.');
    if (!validSectionLetter(sec.letter)) throw new ProjectError(`Section letter "${sec.letter}" must be 1 to 3 capital letters A-Z.`);
    if (letters.has(sec.letter)) throw new ProjectError(`Section letter "${sec.letter}" is used twice.`);
    if (ids.has(sec.id)) throw new ProjectError(`Section id "${sec.id}" is used twice.`);
    letters.add(sec.letter); ids.add(sec.id);
  }
  for (const d of project.docs) {
    if (!d || typeof d !== 'object') throw new ProjectError('A document entry is not valid.');
    const name = isStr(d.description) ? `"${d.description}"` : `Document ${String(d.id)}`;
    if (!isStr(d.id) || !isStr(d.fileId) || !isStr(d.description)) throw new ProjectError(`${name} needs an id, a file and a description.`);
    if (d.descriptionZh !== undefined && !isStr(d.descriptionZh)) throw new ProjectError(`${name}: the Chinese description must be text.`);
    if (d.insertAfter !== undefined && !isStr(d.insertAfter)) throw new ProjectError(`${name}: "insert after page" must be text, e.g. "88".`);
    if (d.typedCopies !== undefined) {
      if (!Array.isArray(d.typedCopies)) throw new ProjectError(`${name}: typed copies must be a list.`);
      for (const t of d.typedCopies) {
        if (!t || !isStr(t.fileId) || !Number.isInteger(t.afterPage) || t.afterPage < 1) throw new ProjectError(`${name}: each typed copy needs a file and a page number.`);
      }
    }
  }
  const fz = project.frozen as unknown as Record<string, unknown> | undefined;
  if (fz !== undefined) {
    const bundles = fz.bundles as Record<string, { volumes?: unknown }> | undefined;
    const okVolumes = (b: { volumes?: unknown } | undefined) => !!b && Array.isArray(b.volumes) && b.volumes.length > 0
      && (b.volumes as { pages?: unknown; rows?: unknown; letter?: unknown }[]).every((v) => v && isStr(v.letter) && Array.isArray(v.pages) && v.pages.length > 0 && Array.isArray(v.rows));
    if (!isStr(fz.issuedAt) || !fz.fileHashes || typeof fz.fileHashes !== 'object' || !bundles || !okVolumes(bundles.main)
      || (bundles.core !== undefined && !okVolumes(bundles.core)) || (bundles.transcripts !== undefined && !okVolumes(bundles.transcripts))) {
      throw new ProjectError('The issued page numbers in this saved file cannot be read; the issued layout is damaged. Open an earlier saved copy.');
    }
  }
}

/**
 * Parse and validate a project file. Missing settings take their defaults, so files
 * saved by older versions still open. Throws ProjectError with a readable message.
 */
export function parseProject(text: string): { project: Project; warnings: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProjectError(`This is not a valid project file (${(e as Error).message}).`);
  }
  if (!raw || typeof raw !== 'object') throw new ProjectError('This is not a Big Bundle Wright project file.');
  if (raw.schema !== PROJECT_SCHEMA) {
    throw new ProjectError(`This is not a Big Bundle Wright project file, or it is from an unsupported version (schema "${raw.schema ?? 'missing'}").`);
  }
  const warnings: string[] = [];
  const project: Project = {
    schema: PROJECT_SCHEMA,
    case: {
      court: '', actionNo: '', parties: [], shortTitle: '', bundleTitle: 'Trial Bundle',
      ...(raw.case ?? {}),
    },
    settings: mergeSettings(raw.settings),
    files: Array.isArray(raw.files) ? raw.files : [],
    docs: Array.isArray(raw.docs) ? raw.docs : [],
    sections: Array.isArray(raw.sections) ? raw.sections : [],
    ...(raw.frozen ? { frozen: raw.frozen } : {}),
  };

  validateShape(project);

  const fileIds = new Set<string>();
  for (const f of project.files) {
    if (!f.id || !f.name || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || !Number.isInteger(f.pageCount) || f.pageCount < 1) {
      throw new ProjectError(`File entry "${f.name ?? f.id ?? '?'}" is incomplete (needs id, name, sha256 and page count).`);
    }
    if (fileIds.has(f.id)) throw new ProjectError(`File id "${f.id}" appears twice.`);
    fileIds.add(f.id);
  }
  const sectionIds = new Set(project.sections.map((s) => s.id));
  const docIds = new Set<string>();
  for (const d of project.docs) {
    const name = d.description ? `"${d.description}"` : `Document ${d.id}`;
    if (!d.id || docIds.has(d.id)) throw new ProjectError(`${name} has a missing or duplicate id.`);
    docIds.add(d.id);
    if (!fileIds.has(d.fileId)) throw new ProjectError(`${name} refers to a file that is not in the project.`);
    if (d.date !== null && d.date !== undefined && !isValidIsoDate(d.date)) throw new ProjectError(`${name} has an invalid date "${d.date}" (use YYYY-MM-DD).`);
    d.date = d.date ?? null;
    if (!DOC_TYPES.includes(d.type)) throw new ProjectError(`${name} has an unknown type "${d.type}".`);
    if (!STATUSES.includes(d.status)) throw new ProjectError(`${name} has an unknown status "${d.status}".`);
    d.core = !!d.core;
    for (const t of d.typedCopies ?? []) {
      if (!fileIds.has(t.fileId)) throw new ProjectError(`A typed copy for ${name} refers to a file that is not in the project.`);
    }
    if (d.sectionId && !sectionIds.has(d.sectionId)) warnings.push(`${name} refers to a section that no longer exists; it will be listed under "Other documents".`);
    if (d.insertAfter && !project.frozen) warnings.push(`${name} is marked to go after page ${d.insertAfter}, which only applies once the bundle has been issued.`);
  }
  if (project.case.coversheetFileId && !fileIds.has(project.case.coversheetFileId)) {
    throw new ProjectError('The coversheet refers to a file that is not in the project.');
  }
  if (project.frozen) {
    for (const id of Object.keys(project.frozen.fileHashes ?? {})) {
      if (!fileIds.has(id)) throw new ProjectError(`The issued bundle used a file (${id}) that is no longer in the project.`);
    }
  }
  return { project, warnings };
}

export interface SourceCandidate {
  name: string;
  sha256: string;
}

export interface SourceMatch {
  /** Project file id → index into the candidates. */
  matched: Map<string, number>;
  /** Found under a different name (same content). */
  renamed: { file: SourceFileRef; as: string }[];
  /** A candidate has the expected name but different content. */
  changed: { file: SourceFileRef; candidate: string }[];
  /** No candidate with this content. */
  missing: SourceFileRef[];
}

/** Match re-added files to the project by content hash (preferring the same name). */
export function matchSources(files: SourceFileRef[], candidates: SourceCandidate[]): SourceMatch {
  const out: SourceMatch = { matched: new Map(), renamed: [], changed: [], missing: [] };
  const used = new Set<number>();
  for (const f of files) {
    const byHash = candidates.map((c, i) => ({ c, i })).filter(({ c, i }) => c.sha256 === f.sha256 && !used.has(i));
    const pick = byHash.find(({ c }) => c.name === f.name) ?? byHash[0];
    if (pick) {
      out.matched.set(f.id, pick.i);
      used.add(pick.i);
      if (pick.c.name !== f.name) out.renamed.push({ file: f, as: pick.c.name });
      continue;
    }
    const sameName = candidates.find((c) => c.name === f.name);
    if (sameName) out.changed.push({ file: f, candidate: sameName.name });
    else out.missing.push(f);
  }
  return out;
}

export function describeMatch(m: SourceMatch): { errors: string[]; notes: string[] } {
  return {
    errors: [
      ...m.changed.map(({ file }) => `"${file.name}" does not match the file used before: its content (hash) is different. Add the original file, or replace the document in the project.`),
      ...m.missing.map((f) => `"${f.name}" is missing. Add it again (any file name; it is recognised by content).`),
    ],
    notes: m.renamed.map(({ file, as }) => `"${file.name}" found as "${as}".`),
  };
}
