// Big Bundle Wright engine: public API. Pure module; no DOM.
// SPDX-License-Identifier: MPL-2.0
export * from './model.ts';
export * from './util.ts';
export { loadSource, imageToA4Pdf, type LoadedSource } from './sources.ts';
export { analysePdf, type PdfjsAssets } from './analyse.ts';
export { planProjectBundles, sortChronologically, chronologyWarnings, freezeProject, unfreezeProject, type BuildPlan, type BundlePlan, type PlanVolume } from './plan.ts';
export { buildBundle, planProject, outputBaseName, useBilingual, type BuildInput, type BuildOutput, type BuiltVolume, type BuiltFile } from './build.ts';
export { serializeProject, parseProject, matchSources, describeMatch, PROJECT_SCHEMA, type SourceMatch, type SourceCandidate } from './project-io.ts';
export { lodgingDeadline, describeDeadline, type DeadlineResult } from './deadline.ts';
export { FONT_FILES, projectNeedsCjkFonts, type FontBytes } from './fonts.ts';
export { ZH, zhBundleName, zhPages } from './i18n.ts';
export { buildDocxIndexes, docxVolumeIndex, docxMasterIndex, type DocxFile, type DocxIndexOptions } from './docx-index.ts';
export { buildLabels, labelVolumes, spineText, SPINE_LABEL_MM, COVER_LABEL_MM, INSIDE_COVER_THRESHOLD, type LabelsFile, type LabelsOptions, type LabelVolume } from './labels.ts';
export { complianceReport, complianceReportPdf, complianceFileBase, CHECK_STATUS_TEXT, type ComplianceReport, type ComplianceCheck, type CheckStatus, type ComplianceOptions } from './compliance.ts';
export { exportBundle, zipFileName, type ExportInput, type ExportOutput, type ExportFile, type ExportFileKind, type ExportProgress } from './export.ts';
