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

  const fileIds = new Set<string>();
  for (const f of project.files) {
    if (!f.id || !f.name || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || !(f.pageCount > 0)) {
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
