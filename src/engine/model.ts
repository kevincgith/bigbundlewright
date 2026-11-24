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
}

export interface Project {
  schema: 'bigbundle-wright/project@1';
  case: CaseInfo;
  settings: Settings;
  files: SourceFileRef[];
  /** In bundle order. */
  docs: BundleDoc[];
  sections: Section[];
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
  | 'deferred-feature';

export interface BuildWarning {
  code: WarningCode;
  message: string;
  docId?: string;
  fileId?: string;
  /** Stamped page labels affected, if any. */
  pages?: string[];
}

export type SourceErrorCode = 'encrypted' | 'corrupt' | 'unsupported' | 'empty' | 'missing' | 'hash-mismatch';

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
