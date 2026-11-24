// Big Bundle Wright: messages between the page and the worker.
// SPDX-License-Identifier: MPL-2.0
import type { BuildWarning, BundleKind, Project, SourceFileRef } from '../engine/model.ts';

export interface FileFlags { imageOnly: number[]; edge: number[]; corner: number[] }

export interface PlanSummary {
  volumes: { kind: BundleKind; name: string; first: string; last: string; pages: number }[];
  warnings: BuildWarning[];
  physicalFiles: number;
}

export type ToWorker =
  | { type: 'ingest'; reqId: string; tempId: string; name: string; bytes: ArrayBuffer }
  | { type: 'plan'; reqId: string; project: Project }
  | { type: 'build'; reqId: string; project: Project; issue?: boolean; prelimsOnly?: boolean }
  | { type: 'cancel' };

export type FromWorker =
  | { type: 'ingested'; reqId: string; ref: SourceFileRef }
  | { type: 'analysed'; sha: string; flags: FileFlags }
  | { type: 'analysis-failed'; sha: string; message: string }
  | { type: 'planned'; reqId: string; summary: PlanSummary }
  | { type: 'progress'; reqId: string; phase: string; done: number; total: number }
  | { type: 'built'; reqId: string; files: { fileName: string; bytes: Uint8Array; pageCount: number }[]; warnings: BuildWarning[]; issuedProject?: Project }
  | { type: 'error'; reqId: string; name: string; code?: string; fileName?: string; message: string };
