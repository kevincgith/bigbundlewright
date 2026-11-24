// Big Bundle Wright: data model.
// SPDX-License-Identifier: MPL-2.0

export type DocType =
  | 'document'
  | 'pleading'
  | 'witness_statement'
  | 'expert'
  | 'correspondence'
  | 'transcript';

/** PD 5.6 para 3 / O.27 r.4 categories. */
export type DocStatus = 'authentic' | 'inclusion_only' | 'evidence_of_contents';

export type NumberingMode = 'continuous' | 'per-volume' | 'per-section';
export type StampStyle = 'X' | 'PageX' | 'XofY' | 'XslashY' | 'PageXofY' | 'None';
export type StampPosition =
  | 'top-right' | 'top-centre' | 'top-left'
  | 'bottom-right' | 'bottom-centre' | 'bottom-left';
export type OutlineStyle = 'plain' | 'withPage' | 'withDate' | 'withDateAndPage';
export type DateStyle =
  | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM/DD/YYYY'
  | 'DD Mon. YYYY' | 'DD Month YYYY' | 'Mon. DD, YYYY' | 'Month DD, YYYY' | 'None';
export type Size = 'S' | 'M' | 'L';

export interface SourceFileRef {
  id: string;
  name: string;
  sha256: string;
  kind: 'pdf' | 'image';
  pageCount: number;
}

export interface BundleDoc {
  id: string;
  fileId: string;
  /** ISO yyyy-mm-dd, or null when undated. */
  date: string | null;
  description: string;
  descriptionZh?: string;
  type: DocType;
  status: DocStatus;
  core: boolean;
  sectionId?: string;
  /**
   * PD 5.6 para 6: typed copies of illegible pages, interleaved after source page
   * `afterPage` (1-based). Each refers to a file in `Project.files`.
   */
  typedCopies?: { afterPage: number; fileId: string }[];
  /**
   * PD 5.6 para 1: once the bundle is issued (frozen), insert this document after the
   * page with this stamped label, numbered "88-1, 88-2…". Ignored before issue.
   */
  insertAfter?: string;
}

export interface Section {
  id: string;
  /** Letter shown in the index and used as the stamp prefix in per-section mode. */
  letter: string;
  title: string;
  titleZh?: string;
}

export interface Party {
  name: string;
  role: string; // e.g. "Plaintiff", "1st Defendant"
}

export interface CaseInfo {
  /** Multi-line court heading, e.g. "IN THE HIGH COURT OF THE\nHONG KONG SPECIAL ADMINISTRATIVE REGION\nCOURT OF FIRST INSTANCE". */
  court: string;
  /** e.g. "HCA 1234/2025". */
  actionNo: string;
  /** Optional long form, e.g. "ACTION NO. 1234 OF 2025". */
  actionLine?: string;
  parties: Party[];
  /** Short title for filenames, e.g. "Chan v Wong". */
  shortTitle: string;
  /** e.g. "Trial Bundle". */
  bundleTitle: string;
  confidential?: boolean;
  hearingDate?: string;
  /** BunTool parity: a pre-made cover page (first page of this file) before the index of each main volume. Unnumbered. */
  coversheetFileId?: string;
}

export interface Settings {
  maxPagesPerVolume: number;
  numbering: NumberingMode;
  sectionsEnabled: boolean;
  sectionPrefix: '' | 'Section' | 'Part';
  bilingualHeadings: boolean;
  dateStyle: DateStyle;
  outlineStyle: OutlineStyle;
  stamp: {
    style: StampStyle;
    prefix: string;
    position: StampPosition;
    size: Size;
    colour: 'black' | 'red' | 'blue';
  };
  index: { headingSize: Size; tableSize: Size; borders: boolean };
  /** BunTool "printable mode": blank page after odd-length documents. */
  printable: boolean;
  /** PD 5.6 para 3 status front sheet at the front of each main and core volume. */
  frontSheet: boolean;
}

export interface Project {
  schema: 'bigbundle-wright/project@1';
  case: CaseInfo;
  settings: Settings;
  files: SourceFileRef[];
  /** In bundle order. */
  docs: BundleDoc[];
  sections: Section[];
  /** Set when the bundle is issued: page numbers are locked from then on. */
  frozen?: FrozenLayout;
}

export type BundleKind = 'main' | 'core' | 'transcripts';

export interface PlanPage {
  kind: 'doc' | 'blank';
  docId?: string;
  fileId?: string;
  /** 0-based page index in the source file. */
  srcIndex?: number;
  /** Stamped label, e.g. "12", "A12", "C3", "88-1". */
  label: string;
  /** Numbering series ("" for continuous main, else a letter prefix) for "of Y" styles. */
  series: string;
}

export interface PlanEntry {
  kind: 'doc';
  docId: string;
  /** Index number shown in the "No." column: "7", or "7-1" for an insert. */
  tab: string;
  part?: { n: number; of: number };
  /** Index into the volume's content pages of the first page, and the span to the last. */
  first: number;
  count: number;
  firstLabel: string;
  lastLabel: string;
}

export interface PlanSectionRow {
  kind: 'section';
  sectionId: string;
  continued: boolean;
}

export type PlanRow = PlanEntry | PlanSectionRow;

export interface FrozenVolume {
  letter: string;
  rows: PlanRow[];
  pages: PlanPage[];
}

export interface FrozenLayout {
  issuedAt: string;
  /** sha256 of every file used, by file id: content may not change after issue. */
  fileHashes: Record<string, string>;
  /** Description of each issued document, by id (for messages if one is later removed). */
  docTitles?: Record<string, string>;
  bundles: Partial<Record<BundleKind, { volumes: FrozenVolume[] }>>;
}

export const DEFAULT_SETTINGS: Settings = {
  maxPagesPerVolume: 250,
  numbering: 'continuous',
  sectionsEnabled: false,
  sectionPrefix: 'Section',
  bilingualHeadings: false,
  dateStyle: 'DD/MM/YYYY',
  outlineStyle: 'withDateAndPage',
  stamp: { style: 'X', prefix: '', position: 'top-right', size: 'M', colour: 'black' },
  index: { headingSize: 'M', tableSize: 'M', borders: true },
  printable: false,
  frontSheet: true,
};

/** Per-page facts gathered from the source before building. */
export interface PageAnalysis {
  /** Visual (post-/Rotate) size in points. */
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  hasText: boolean;
  /** Fraction of the page with ink (0..1), at low resolution. */
  ink: number;
  /** Ink inside the zone a stamp at each position would occupy on the normalised page. */
  stampZoneInk: Record<StampPosition, boolean>;
  /** Edges (of the normalised page) with ink within 5 mm. */
  edgeInk: ('top' | 'right' | 'bottom' | 'left')[];
}

export type WarningCode =
  | 'duplicate'
  | 'not-chronological'
  | 'undated'
  | 'image-only'
  | 'edge-content'
  | 'shrunk-for-stamp'
  | 'relaid-annotations-dropped'
  | 'doc-split'
  | 'non-compliant-setting'
  | 'unsupported-glyph'
  | 'analysis-skipped'
  | 'deferred-feature'
  | 'core-bundle-needed'
  | 'volume-over-limit'
  | 'appended-after-issue'
  | 'insert-before-issue'
  | 'inside-cover-labels'
  | 'hash-mismatch'
  | 'provisional-numbers'
  | 'label-clash';

export interface BuildWarning {
  code: WarningCode;
  message: string;
  docId?: string;
  fileId?: string;
  /** Stamped page labels affected, if any. */
  pages?: string[];
}

export type SourceErrorCode = 'encrypted' | 'corrupt' | 'unsupported' | 'empty' | 'missing' | 'hash-mismatch';

/** A problem with the project itself (bad JSON, broken references, a change not allowed after issue). */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

export class SourceError extends Error {
  readonly fileName: string;
  readonly code: SourceErrorCode;
  constructor(fileName: string, code: SourceErrorCode, message: string) {
    super(message);
    this.name = 'SourceError';
    this.fileName = fileName;
    this.code = code;
  }
}
