// Big Bundle Wright: the page. All document processing happens in ./worker.ts, on this device.
// SPDX-License-Identifier: MPL-2.0

import './styles.css';
import iconUrl from '../../assets/logo/glass-icon.svg?url';
import {
  DEFAULT_SETTINGS, chronologyWarnings, describeDeadline, lodgingDeadline, parseFileName, parseProject,
  serializeProject, unfreezeProject, outputBaseName, validSectionLetter, PROJECT_SCHEMA,
  type BundleDoc, type BuildWarning, type DocStatus, type DocType, type Project, type Settings, type SourceFileRef,
} from '../engine/index.ts';
import { orderedDocs } from '../engine/plan.ts';
import { announce, download, h, replace, uid } from './dom.ts';
import BundleWorker from './worker.ts?worker&inline';
import { startTour, tourIsOpen, type TourStep } from './tour.ts';
import type { FileFlags, FromWorker, PlanSummary, ToWorker } from './protocol.ts';
import type { ComplianceCheck } from '../engine/compliance.ts';

const VERSION = '0.4.0';
const LS = { autosave: 'bigbundlewright:autosave', project: 'bigbundlewright:project', defaults: 'bigbundlewright:defaults', guide: 'bigbundlewright:guide-dismissed', toured: 'bigbundlewright:toured' };

// ---------------------------------------------------------------- worker RPC

/** localStorage that never throws (it does when a browser blocks site data). */
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): boolean { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// The worker is built inline (blob: URL) so it inherits this page's Content Security Policy.
let worker: Worker;
const pending = new Map<string, { resolve: (m: FromWorker) => void; reject: (e: WorkerError) => void; progress?: (m: Extract<FromWorker, { type: 'progress' }>) => void }>();
interface WorkerError { name: string; code?: string; fileName?: string; message: string }

function startWorker() {
  worker = new BundleWorker();
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => { e.preventDefault?.(); workerDied(); };
  worker.onmessageerror = () => workerDied();
  worker.postMessage({ type: 'init', base: new URL('.', document.baseURI).href } satisfies ToWorker);
}

/** The worker crashed (for example out of memory): fail everything pending and start again. */
function workerDied() {
  const err: WorkerError = { name: 'WorkerError', message: 'The background worker stopped, possibly because it ran out of memory. Add the files again to continue.' };
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  try { worker.terminate(); } catch { /* already gone */ }
  S.job = null;
  S.ingesting = 0;
  S.loaded.clear();
  S.flags.clear();
  for (const f of S.project.files) reopened.add(f.id);
  startWorker();
  renderAll();
  showError('Something went wrong', err);
}

function onWorkerMessage(e: MessageEvent<FromWorker>) {
  const m = e.data;
  if (m.type === 'fonts') {
    S.fontsState = m.state;
    if (m.state === 'failed') announce('The Chinese fonts could not be loaded.');
    renderBuild();
    return;
  }
  if (m.type === 'analysed' || m.type === 'analysis-failed') {
    S.flags.set(m.sha, m.type === 'analysed' ? m.flags : null);
    if (m.type === 'analysis-failed') { S.analysisErrors.set(m.sha, m.message); console.warn('Page check failed:', m.message); }
    renderDocs();
    return;
  }
  const p = pending.get(m.reqId);
  if (!p) return;
  if (m.type === 'progress') { p.progress?.(m); return; }
  pending.delete(m.reqId);
  if (m.type === 'error') p.reject(m); else p.resolve(m);
}

function call<T extends FromWorker['type']>(msg: ToWorker, progress?: (m: Extract<FromWorker, { type: 'progress' }>) => void, transfer: Transferable[] = []): Promise<Extract<FromWorker, { type: T }>> {
  return new Promise((resolve, reject) => {
    if ('reqId' in msg) pending.set(msg.reqId, { resolve: resolve as never, reject, progress });
    worker.postMessage(msg, transfer);
  });
}

// ---------------------------------------------------------------- state

function defaultSettings(): Settings {
  const d = structuredClone(DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(store.get(LS.defaults) ?? 'null');
    if (saved) return { ...d, ...saved, stamp: { ...d.stamp, ...saved.stamp }, index: { ...d.index, ...saved.index } };
  } catch { /* ignore */ }
  return d;
}

const COURTS: Record<string, string> = {
  'Court of First Instance': 'IN THE HIGH COURT OF THE\nHONG KONG SPECIAL ADMINISTRATIVE REGION\nCOURT OF FIRST INSTANCE',
  'Court of Appeal': 'IN THE HIGH COURT OF THE\nHONG KONG SPECIAL ADMINISTRATIVE REGION\nCOURT OF APPEAL',
  'District Court': 'IN THE DISTRICT COURT OF THE\nHONG KONG SPECIAL ADMINISTRATIVE REGION',
};

function newProject(): Project {
  return {
    schema: PROJECT_SCHEMA as Project['schema'],
    case: {
      court: COURTS['Court of First Instance'], actionNo: '', parties: [{ name: '', role: 'Plaintiff' }, { name: '', role: 'Defendant' }],
      shortTitle: '', bundleTitle: 'Trial Bundle',
    },
    settings: defaultSettings(),
    files: [], docs: [], sections: [],
  };
}

const S = {
  project: newProject(),
  /** sha256 of files loaded into the worker in this session. */
  loaded: new Set<string>(),
  /** Page-analysis flags by sha (null = analysis failed). */
  flags: new Map<string, FileFlags | null>(),
  fileErrors: [] as { name: string; message: string }[],
  plan: null as PlanSummary | null,
  planError: '' as string,
  job: null as null | { label: string; done: number; total: number },
  results: null as null | {
    files: { fileName: string; url: string; pageCount?: number; size: number; kind: string }[];
    zip?: { fileName: string; url: string; size: number };
    checks?: ComplianceCheck[];
    warnings: BuildWarning[]; preview: boolean;
  },
  reorder: 'drag' as 'drag' | 'arrows',
  ingesting: 0,
  dateDraft: new Map<string, string>(),
  analysisErrors: new Map<string, string>(),
  /** Rows where the Chinese description box has been opened. */
  zhOpen: new Set<string>(),
  fontsState: '' as '' | 'loading' | 'ready' | 'failed',
  /** Bumped on every edit; a build whose revision is stale is not shown. */
  rev: 0,
  settingsOpen: false,
};

const DOC_TYPES: [DocType, string][] = [['document', 'Document'], ['pleading', 'Pleading'], ['witness_statement', 'Witness statement'], ['expert', 'Expert report'], ['correspondence', 'Correspondence'], ['transcript', 'Transcript']];
const STATUSES: [DocStatus, string][] = [['authentic', '(1) Authentic'], ['inclusion_only', '(2) Inclusion only'], ['evidence_of_contents', '(3) Evidence of contents']];

const fileById = (id: string) => S.project.files.find((f) => f.id === id);
const docPages = (d: BundleDoc) => (fileById(d.fileId)?.pageCount ?? 0) + (d.typedCopies ?? []).reduce((a, t) => a + (fileById(t.fileId)?.pageCount ?? 0), 0);
const missingFiles = () => S.project.files.filter((f) => !S.loaded.has(f.sha256));
const isFrozen = () => !!S.project.frozen;
const frozenPages = () => Object.values(S.project.frozen?.bundles ?? {}).flatMap((b) => b?.volumes.flatMap((v) => v.pages) ?? []);
const frozenDocIds = () => new Set(frozenPages().map((p) => p.docId));
/** "docId|fileId" pairs fixed by the issued layout (typed copies included). */
const frozenFilePairs = () => new Set(frozenPages().map((p) => `${p.docId}|${p.fileId}`));
const sel$ = (key: string) => `[data-key="${CSS.escape(key)}"]`;

/** Drop file entries nothing refers to any more, and tell the worker to free their bytes. */
function pruneFiles() {
  const p = S.project;
  const used = new Set<string>();
  for (const d of p.docs) { used.add(d.fileId); for (const t of d.typedCopies ?? []) used.add(t.fileId); }
  if (p.case.coversheetFileId) used.add(p.case.coversheetFileId);
  for (const id of Object.keys(p.frozen?.fileHashes ?? {})) used.add(id);
  const removed = p.files.filter((f) => !used.has(f.id));
  if (!removed.length) return;
  p.files = p.files.filter((f) => used.has(f.id));
  for (const f of removed) {
    reopened.delete(f.id);
    if (!p.files.some((g) => g.sha256 === f.sha256)) {
      S.loaded.delete(f.sha256);
      S.flags.delete(f.sha256);
      worker.postMessage({ type: 'forget', sha: f.sha256 } satisfies ToWorker);
    }
  }
}

/** Light edit (typing): stale results go, the plan refreshes. */
function edited() {
  S.rev++;
  if (S.results) { clearResults(); renderBuild(); }
  autosave();
  schedulePlan();
}

function changed(opts: { docs?: boolean; build?: boolean } = {}) {
  S.rev++;
  pruneFiles();
  clearResults();
  renderHeader();
  if (opts.docs !== false) renderDocs();
  if (opts.build !== false) renderBuild();
  schedulePlan();
  autosave();
}

// ---------------------------------------------------------------- dates

function toDisplay(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function fromDisplay(s: string): string | null | undefined {
  const t = s.trim();
  if (!t) return null;
  let m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(t);
  let iso: string | undefined;
  if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) iso = t;
  if (!iso) return undefined;
  const [y, mo, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? iso : undefined;
}

// ---------------------------------------------------------------- files

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

type Purpose = { kind: 'doc' } | { kind: 'typed'; docId: string; afterPage: number } | { kind: 'cover' };

async function addFiles(list: FileList | File[], purpose: Purpose = { kind: 'doc' }) {
  const files = [...list];
  if (S.job) { announce('Wait for the build to finish before adding files.'); return; }
  S.ingesting += files.length;
  renderDocs();
  renderBuild();
  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer();
      const res = await call<'ingested'>({ type: 'ingest', reqId: uid('r'), tempId: uid('t'), name: file.name, bytes }, undefined, [bytes]);
      onIngested(res.ref, purpose);
    } catch (e) {
      const err = e as WorkerError;
      S.fileErrors.push({ name: file.name, message: err.message ?? String(e) });
      announce(err.message ?? String(e));
    } finally {
      S.ingesting--;
    }
  }
  changed();
  announce(`${files.length} file(s) processed.`);
}

function onIngested(ref: SourceFileRef, purpose: Purpose) {
  S.loaded.add(ref.sha256);
  const p = S.project;
  // A file an opened project is waiting for (matched by content): just mark it present.
  if (purpose.kind === 'doc') {
    const waiting = p.files.find((f) => reopened.has(f.id) && f.sha256 === ref.sha256);
    if (waiting) { for (const f of p.files) if (f.sha256 === ref.sha256) reopened.delete(f.id); return; }
  }
  const id = uid('f');
  const fileRef = { ...ref, id };
  p.files.push(fileRef);
  if (purpose.kind === 'cover') { p.case.coversheetFileId = id; renderCase(); return; }
  if (purpose.kind === 'typed' && !p.docs.some((x) => x.id === purpose.docId)) return; // document removed meanwhile; pruned on next change
  if (purpose.kind === 'typed') {
    const d = p.docs.find((x) => x.id === purpose.docId);
    if (d) (d.typedCopies ??= []).push({ afterPage: purpose.afterPage, fileId: id });
    return;
  }
  const { date, title } = parseFileName(ref.name);
  const doc: BundleDoc = {
    id: uid('d'), fileId: id, date, description: title,
    type: /transcript/i.test(ref.name) ? 'transcript' : 'document', status: 'authentic', core: false,
  };
  // Chronological by default: insert after the last document dated on or before this one.
  if (!isFrozen() && date) {
    let at = p.docs.length;
    for (let i = p.docs.length - 1; i >= 0; i--) {
      const di = p.docs[i].date;
      if (di && di <= date) { at = i + 1; break; }
      if (i === 0) at = 0;
    }
    if (p.docs.every((d) => !d.date)) at = 0;
    p.docs.splice(at, 0, doc);
  } else {
    p.docs.push(doc);
  }
}

/** Files of an opened project that have not been re-added yet. */
const reopened = new Set<string>();

function pickFiles(purpose: Purpose, multiple = true) {
  const input = h('input', { type: 'file', accept: ACCEPT, multiple });
  input.addEventListener('change', () => { if (input.files?.length) addFiles(input.files, purpose); });
  input.click();
}

// ---------------------------------------------------------------- project save / open / autosave

function saveProject() {
  const name = `${outputBaseName(S.project) || 'Untitled'} project.json`;
  download(name, serializeProject(S.project), 'application/json');
  announce('Project saved.');
}

async function openProject(file: File) {
  try {
    const { project, warnings } = parseProject(await file.text());
    adoptProject(project);
    if (warnings.length) showMessage('Project opened with notes', warnings);
  } catch (e) {
    showError('Could not open the project', e as Error);
  }
}

function adoptProject(project: Project) {
  S.project = project;
  reopened.clear();
  for (const f of project.files) if (!S.loaded.has(f.sha256)) reopened.add(f.id);
  S.fileErrors = [];
  clearResults();
  S.rev++;
  pruneFiles();
  renderAll();
  schedulePlan();
  autosave();
}

let autosaveTimer = 0;
function autosave() {
  if (store.get(LS.autosave) !== '1') return;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (store.get(LS.autosave) === '1') store.set(LS.project, serializeProject(S.project));
  }, 400);
}

// ---------------------------------------------------------------- planning (live compliance preview)

let planTimer = 0;
let planSeq = 0;
function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = window.setTimeout(async () => {
    const seq = ++planSeq;
    if (!S.project.docs.length) { S.plan = null; S.planError = ''; renderBuild(); return; }
    try {
      const r = await call<'planned'>({ type: 'plan', reqId: uid('r'), project: S.project });
      if (seq !== planSeq) return;
      S.plan = r.summary; S.planError = '';
      renderDocs();
    } catch (e) {
      if (seq !== planSeq) return;
      const msg = (e as WorkerError).message;
      if (msg !== S.planError) announce(msg);
      S.plan = null; S.planError = msg;
    }
    renderBuild();
  }, 450);
}

// ---------------------------------------------------------------- build

function missingInfo(): string[] {
  const c = S.project.case;
  const out: string[] = [];
  if (!c.actionNo.trim()) out.push('Action number (e.g. HCA 1234/2025)');
  if (!c.shortTitle.trim()) out.push('Short title (used in file names)');
  if (!c.parties.some((p) => p.name.trim())) out.push('Parties');
  const undated = S.project.docs.filter((d) => !d.date).length;
  if (undated) out.push(`${undated} document(s) without a date`);
  if (frozenDocIds().size) {
    const fresh = S.project.docs.filter((d) => !frozenDocIds().has(d.id) && !d.insertAfter);
    if (fresh.length) out.push(`${fresh.length} new document(s) with no "insert after page" (they will go at the end)`);
  }
  return out;
}

async function runBuild(opts: { issue?: boolean; prelimsOnly?: boolean } = {}) {
  if (missingFiles().length) { showMessage('Add the files first', [`These files need to be added again: ${missingFiles().map((f) => f.name).join(', ')}`]); return; }
  if (!opts.prelimsOnly) {
    const miss = missingInfo();
    if (miss.length && !(await confirmDialog('Missing information', miss, 'Build anyway'))) return;
  }
  if (opts.issue && !(await confirmDialog('Issue the bundle?', [
    'Issuing locks every page number. After this, late documents are added as 88-1, 88-2… (PD 5.6 para 1) and nothing can be removed without re-issuing.',
    'Save the project file afterwards: you need it to add documents later.',
  ], 'Build and issue'))) return;
  if (S.job || S.ingesting) return;
  clearResults();
  const reqId = uid('r');
  const startRev = S.rev;
  S.job = { label: 'Starting', done: 0, total: 1 };
  renderBuild();
  announce('Building.');
  try {
    const r = await call<'built'>({ type: 'build', reqId, project: S.project, issue: opts.issue, prelimsOnly: opts.prelimsOnly }, (p) => {
      if (S.job && p.phase !== S.job.label) announce(p.phase);
      S.job = { label: p.phase, done: p.done, total: p.total };
      updateProgress();
    });
    if (S.rev !== startRev) {
      // Editing is locked during a build, so this should not happen; never show results for a changed project.
      announce('The project changed during the build; build again.');
      return;
    }
    const mime = (n: string) => n.endsWith('.pdf') ? 'application/pdf' : n.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : n.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    S.results = {
      preview: !!opts.prelimsOnly,
      warnings: r.warnings,
      checks: r.checks,
      files: r.files.map((f) => ({ fileName: f.fileName, kind: f.kind, pageCount: f.pageCount, size: f.bytes.byteLength, url: URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: mime(f.fileName) })) })),
      zip: r.zip ? { fileName: r.zip.fileName, size: r.zip.bytes.byteLength, url: URL.createObjectURL(new Blob([r.zip.bytes as BlobPart], { type: 'application/zip' })) } : undefined,
    };
    if (r.issuedProject) { S.project = r.issuedProject; autosave(); renderAll(); }
    announce(opts.prelimsOnly ? 'Index preview ready.' : 'Bundle ready to download.');
  } catch (e) {
    const err = e as WorkerError;
    if (err.name === 'AbortError') announce('Build cancelled.');
    else showError('The bundle could not be built', err);
  } finally {
    S.job = null;
    renderBuild();
  }
}

function clearResults() {
  for (const f of S.results?.files ?? []) URL.revokeObjectURL(f.url);
  if (S.results?.zip) URL.revokeObjectURL(S.results.zip.url);
  S.results = null;
}

// ---------------------------------------------------------------- dialogs

function dialog(title: string, body: (Node | string)[], buttons: { label: string; value: string; primary?: boolean }[]): Promise<string> {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'dlg-title' },
      h('h2', { id: 'dlg-title' }, title),
      ...body,
      h('div', { class: 'dlg-actions' }, ...buttons.map((b) => h('button', { class: b.primary ? 'btn primary' : 'btn', value: b.value, onclick: () => dlg.close(b.value) }, b.label))));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}
const confirmDialog = async (title: string, lines: string[], ok: string) =>
  (await dialog(title, [h('ul', null, ...lines.map((l) => h('li', null, l)))], [{ label: 'Go back', value: 'no' }, { label: ok, value: 'yes', primary: true }])) === 'yes';
const showMessage = (title: string, lines: string[]) => dialog(title, [h('ul', null, ...lines.map((l) => h('li', null, l)))], [{ label: 'OK', value: 'ok', primary: true }]);

function showError(title: string, err: { name?: string; code?: string; message: string; stack?: string }) {
  // The message can contain document names, so the copied details leave it out.
  const details = [
    `Big Bundle Wright ${VERSION}`, `Browser: ${navigator.userAgent}`,
    `Error: ${err.name ?? 'Error'}${err.code ? ` (${err.code})` : ''}`,
    `Documents: ${S.project.docs.length}, files: ${S.project.files.length}, pages: ${S.project.files.reduce((a, f) => a + f.pageCount, 0)}, issued: ${isFrozen()}`,
  ].join('\n');
  dialog(title, [h('p', null, err.message),
    h('p', { class: 'muted' }, 'If this looks like a fault, "Copy details" copies a short technical summary (no document names or contents) you can send in a bug report.')],
  [{ label: 'Copy details', value: 'copy' }, { label: 'OK', value: 'ok', primary: true }]).then((v) => {
    if (v === 'copy') navigator.clipboard?.writeText(details).then(() => announce('Details copied.'));
  });
}

// ---------------------------------------------------------------- rendering: header, guide, case

const $ = (id: string) => document.getElementById(id)!;

function renderHeader() {
  replace($('hdr-actions'),
    h('button', { class: 'btn ghost', dataset: { key: 'tour' }, onclick: () => openTour() }, 'Tour'),
    h('button', { class: 'btn', onclick: () => { const i = h('input', { type: 'file', accept: '.json,application/json' }); i.onchange = () => i.files?.[0] && openProject(i.files[0]); i.click(); } }, 'Open project…'),
    h('button', { class: 'btn', onclick: saveProject, disabled: !S.project.docs.length }, 'Save project'),
    h('button', {
      class: 'btn ghost', onclick: async () => {
        if (S.project.docs.length && !(await confirmDialog('Start a new project?', ['This clears the current documents and details from the page. Save the project first if you will need it.'], 'Start new'))) return;
        clearResults(); adoptProject(newProject());
      },
    }, 'New'));
}

function renderGuide() {
  const el = $('guide');
  if (store.get(LS.guide) === '1') { el.hidden = true; return; }
  el.hidden = false;
  const items: [string, string, string][] = [
    ['Para 1', 'Leave out unnecessary documents.', 'Only those likely to be referred to at trial.'],
    ['Para 2', 'A core bundle over 100 pages.', 'The documents central to the dispute.'],
    ['Para 3', 'Status of each document.', 'Marked on the front of the bundle.'],
    ['Para 4', 'Chronological order, numbered top right.', 'Paged consecutively from the front.'],
    ['Para 5', 'No more than 250 pages a file.', 'Transcripts go in a separate bundle.'],
    ['Para 8', 'Lodge at least 72 hours ahead.', 'Not counting weekends and general holidays.'],
  ];
  replace(el,
    h('div', { class: 'guide-head' },
      h('h2', null, 'PD 5.6 in brief'),
      h('div', { class: 'guide-actions' },
        h('button', { class: 'linkbtn', dataset: { key: 'guide-tour' }, onclick: () => openTour() }, store.get(LS.toured) ? 'Show the walk-through again' : 'New here? Take the two-minute walk-through'),
        h('button', { class: 'btn ghost small', dataset: { key: 'guide-hide' }, onclick: () => { store.set(LS.guide, '1'); renderGuide(); } }, 'Hide'))),
    h('ul', { class: 'pd-list' }, ...items.map(([ref, lead, rest]) => h('li', null, h('span', { class: 'ref' }, ref), h('span', null, h('b', null, lead), ' ', rest)))));
}

function field(label: string, input: HTMLElement, hint?: string) {
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

function textInput(key: string, value: string, onInput: (v: string) => void, attrs: Record<string, unknown> = {}) {
  return h('input', { type: 'text', value, dataset: { key }, oninput: (e: Event) => onInput((e.target as HTMLInputElement).value), ...attrs });
}

function renderCase() {
  const c = S.project.case;
  const set = () => { edited(); renderDeadline(); };
  const courtSel = h('select', {
    dataset: { key: 'court-preset' },
    onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (COURTS[v]) { c.court = v ? COURTS[v] : c.court; renderCase(); set(); } },
  }, h('option', { value: '' }, 'Preset…'), ...Object.keys(COURTS).map((k) => h('option', { value: k, selected: COURTS[k] === c.court }, k)));
  const court = h('textarea', { rows: 3, 'aria-label': 'Court heading (one line per row)', dataset: { key: 'court' }, oninput: (e: Event) => { c.court = (e.target as HTMLTextAreaElement).value; set(); } });
  court.value = c.court;

  const parties = h('div', { class: 'parties' },
    ...c.parties.map((p, i) => h('div', { class: 'party' },
      textInput(`pn${i}`, p.name, (v) => { p.name = v; set(); }, { placeholder: 'Name (as in the title of the action)', 'aria-label': `Party ${i + 1} name` }),
      textInput(`pr${i}`, p.role, (v) => { p.role = v; set(); }, { placeholder: 'Role', class: 'role', 'aria-label': `Party ${i + 1} role` }),
      h('button', { class: 'btn ghost small', 'aria-label': `Remove party ${i + 1}`, onclick: () => { c.parties.splice(i, 1); renderCase(); set(); } }, '×'))),
    h('div', null, h('button', { class: 'btn small', onclick: () => { c.parties.push({ name: '', role: 'Defendant' }); renderCase(); requestAnimationFrame(() => document.querySelector<HTMLElement>(sel$(`pn${c.parties.length - 1}`))?.focus()); } }, 'Add party')));

  const cover = c.coversheetFileId ? fileById(c.coversheetFileId) : undefined;
  replace($('case'),
    h('h2', null, h('span', { class: 'step' }, '1'), 'Case details'),
    h('div', { class: 'grid2' },
      field('Action number', textInput('actionNo', c.actionNo, (v) => { c.actionNo = v; set(); }, { placeholder: 'e.g. HCA 1234/2025' })),
      field('Short title', textInput('shortTitle', c.shortTitle, (v) => { c.shortTitle = v; set(); }, { placeholder: 'e.g. Chan v Wong' }), 'Used in file names, e.g. "HCA 1234-2025 Chan v Wong Bundle A.pdf".'),
      field('Bundle title', textInput('bundleTitle', c.bundleTitle, (v) => { c.bundleTitle = v; set(); })),
      field('Hearing date', h('input', { type: 'date', value: c.hearingDate ?? '', dataset: { key: 'hearing' }, onchange: (e: Event) => { c.hearingDate = (e.target as HTMLInputElement).value || undefined; set(); } }),
        'Used to work out the lodging deadline.')),
    h('p', { id: 'deadline', class: 'deadline', 'aria-live': 'polite' }),
    h('div', { class: 'grid2' },
      field('Court', h('div', { class: 'stack' }, courtSel, court)),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Parties'), parties)),
    h('div', { class: 'grid2 options' },
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Confidentiality'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.confidential, onchange: (e: Event) => { c.confidential = (e.target as HTMLInputElement).checked; set(); } }), 'Mark the bundle as confidential (shown in red on the index)')),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Cover page (optional)'),
        cover ? h('span', null, cover.name, ' ', h('button', { class: 'linkbtn danger', dataset: { key: 'cover-remove' }, onclick: () => { delete c.coversheetFileId; changed(); renderCase(); } }, 'Remove'))
          : h('span', null, h('button', { class: 'btn small', dataset: { key: 'cover-add' }, onclick: () => pickFiles({ kind: 'cover' }, false) }, 'Choose a cover page…'), h('span', { class: 'hint' }, ' The first page of the file goes before the index, unnumbered.')))));
  renderDeadline();
}

function renderDeadline() {
  const el = document.getElementById('deadline');
  if (!el) return;
  const d = S.project.case.hearingDate;
  if (!d) { el.textContent = ''; return; }
  try {
    const r = lodgingDeadline(d);
    replace(el, h('strong', null, 'PD 5.6 para 8: '), describeDeadline(r));
  } catch (e) {
    replace(el, h('span', { class: 'warn' }, (e as Error).message, ' Check the deadline manually.'));
  }
}

// ---------------------------------------------------------------- rendering: documents

let dragId: string | null = null;

function moveDoc(id: string, to: number) {
  const docs = S.project.docs;
  const from = docs.findIndex((d) => d.id === id);
  if (from < 0 || to < 0 || to >= docs.length || to === from) return;
  const [d] = docs.splice(from, 1);
  docs.splice(to, 0, d);
  changed();
  announce(`Moved "${d.description}" to position ${to + 1} of ${docs.length}.`);
  requestAnimationFrame(() => document.querySelector<HTMLElement>(sel$(`handle-${id}`))?.focus());
}

function sortByDate() {
  const docs = S.project.docs;
  const key = (d: BundleDoc) => d.date ?? '9999-99-99';
  S.project.docs = docs.map((d, i) => ({ d, i })).sort((a, b) => (key(a.d) < key(b.d) ? -1 : key(a.d) > key(b.d) ? 1 : a.i - b.i)).map((x) => x.d);
  changed();
  announce('Sorted by date.');
}

function docRow(d: BundleDoc, i: number, warn: Map<string, string>, frozenIds: Set<string>) {
  const f = fileById(d.fileId);
  const fl = f ? S.flags.get(f.sha256) : undefined;
  const missing = f && !S.loaded.has(f.sha256);
  const frozen = isFrozen();
  const isNew = frozen && !frozenIds.has(d.id);
  const n = S.project.docs.length;
  const dateText = S.dateDraft.get(d.id) ?? toDisplay(d.date);
  const locked = frozen && frozenIds.has(d.id);
  const lockedPairs = frozen ? frozenFilePairs() : new Set<string>();
  const notes: (string | Node)[] = [];
  if (missing) notes.push(h('span', { class: 'badge bad' }, 'File needed'));
  if (!d.date && !S.dateDraft.has(d.id)) notes.push(h('span', { class: 'badge warn', title: 'Add a date so the document can be placed in chronological order.' }, 'No date'));
  if (warn.get(d.id)) notes.push(h('span', { class: 'badge warn', title: warn.get(d.id) }, 'Out of order'));
  if (fl?.imageOnly.length) notes.push(h('span', { class: 'badge', title: `Pages ${fl.imageOnly.join(', ')} are images with no text layer. Check legibility; you can attach a typed copy.` }, `Scanned: ${fl.imageOnly.length} p.`));
  if (fl?.edge.length) notes.push(h('span', { class: 'badge', title: `Pages ${fl.edge.join(', ')} have content within 5 mm of the edge.` }, 'Near edge'));
  if (f && S.project.files.some((g) => g.id !== f.id && g.sha256 === f.sha256)) notes.push(h('span', { class: 'badge warn' }, 'Duplicate'));
  if (f && fl === undefined && S.loaded.has(f.sha256)) notes.push(h('span', { class: 'badge muted' }, 'Checking…'));
  if (f && fl === null) notes.push(h('span', { class: 'badge warn', title: S.analysisErrors.get(f.sha256) ?? '' }, 'Pages not checked'));
  for (const t of d.typedCopies ?? []) {
    const fixed = lockedPairs.has(`${d.id}|${t.fileId}`);
    notes.push(h('span', { class: 'badge' }, `Typed copy after p. ${t.afterPage}`,
      fixed ? null : [' ', h('button', { class: 'linkish', 'aria-label': `Remove typed copy after page ${t.afterPage}`, dataset: { key: `tcrm-${d.id}-${t.fileId}` }, onclick: () => { d.typedCopies = d.typedCopies!.filter((x) => x !== t); changed(); } }, '×')]));
  }

  const tr = h('tr', {
    class: `${warn.get(d.id) ? 'oo' : ''} ${isNew ? 'new' : ''}`, dataset: { id: d.id },
    draggable: S.reorder === 'drag' && !locked ? 'true' : null,
    ondragstart: (e: DragEvent) => { dragId = d.id; e.dataTransfer?.setData('text/plain', d.id); tr.classList.add('dragging'); },
    ondragend: () => { dragId = null; tr.classList.remove('dragging'); },
    ondragover: (e: DragEvent) => { e.preventDefault(); if (dragId) tr.classList.add('over'); },
    ondragleave: () => tr.classList.remove('over'),
    ondrop: (e: DragEvent) => {
      e.preventDefault(); tr.classList.remove('over');
      if (dragId) moveDoc(dragId, i);
      else if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files); // files dropped on the list are added too
    },
  },
  h('td', { class: 'handle-cell' },
    h('button', {
      class: 'handle', dataset: { key: `handle-${d.id}` }, disabled: locked,
      'aria-label': locked ? `"${d.description}" is fixed by the issued bundle` : `Reorder "${d.description}". Use Alt plus arrow keys to move.`,
      title: locked ? 'Fixed by the issued bundle' : 'Drag, or press Alt+↑ / Alt+↓', onkeydown: (e: KeyboardEvent) => {
        if (locked) return;
        if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveDoc(d.id, i - 1); }
        if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveDoc(d.id, i + 1); }
      },
    }, '⠿'),
    S.reorder === 'arrows' ? h('span', { class: 'arrows' },
      h('button', { class: 'btn ghost small', disabled: locked || i === 0, 'aria-label': `Move "${d.description}" up`, dataset: { key: `up-${d.id}` }, onclick: () => moveDoc(d.id, i - 1) }, '▲'),
      h('button', { class: 'btn ghost small', disabled: locked || i === n - 1, 'aria-label': `Move "${d.description}" down`, dataset: { key: `down-${d.id}` }, onclick: () => moveDoc(d.id, i + 1) }, '▼')) : null),
  h('td', { class: 'num', dataset: { label: 'No.' } }, String(i + 1)),
  h('td', { class: 'datecell', dataset: { label: 'Date' } }, h('input', {
    type: 'text', class: `date ${S.dateDraft.has(d.id) ? 'invalid' : ''}`, value: dateText, placeholder: 'DD/MM/YYYY', dataset: { key: `date-${d.id}` },
    'aria-label': `Date of "${d.description}"`, 'aria-invalid': S.dateDraft.has(d.id) ? 'true' : null,
    onchange: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      const iso = fromDisplay(v);
      if (iso === undefined) { S.dateDraft.set(d.id, v); renderDocs(); announce('That date is not valid. Use DD/MM/YYYY.'); return; }
      S.dateDraft.delete(d.id); d.date = iso; changed();
    },
  })),
  h('td', { class: 'desc', dataset: { label: 'Description' } },
    h('input', { type: 'text', value: d.description, dataset: { key: `desc-${d.id}` }, 'aria-label': `Description of document ${i + 1}`, oninput: (e: Event) => { d.description = (e.target as HTMLInputElement).value; edited(); } }),
    d.descriptionZh !== undefined || S.zhOpen.has(d.id)
      ? h('input', { type: 'text', class: 'zh', lang: 'zh-Hant', value: d.descriptionZh ?? '', placeholder: '中文描述', dataset: { key: `zh-${d.id}` }, 'aria-label': `Chinese description of document ${i + 1}`, oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; d.descriptionZh = v || undefined; if (!v) S.zhOpen.add(d.id); edited(); } })
      : null,
    notes.length ? h('div', { class: 'notes' }, ...notes) : null,
    S.plan?.placement[d.id] ? h('div', { class: 'placement' }, S.plan.placement[d.id]) : null,
    isNew ? h('div', { class: 'insert' }, h('label', null, 'Insert after page ', h('input', {
      type: 'text', class: 'short', value: d.insertAfter ?? '', placeholder: 'e.g. 88', dataset: { key: `ins-${d.id}` },
      onchange: (e: Event) => { d.insertAfter = (e.target as HTMLInputElement).value.trim() || undefined; changed(); },
    })), h('span', { class: 'hint' }, ' Numbered 88-1, 88-2… Leave blank to add at the end.')) : null,
    h('div', { class: 'rowactions' },
      d.descriptionZh === undefined && !S.zhOpen.has(d.id)
        ? h('button', { class: 'linkbtn', dataset: { key: `zhadd-${d.id}` }, onclick: () => { S.zhOpen.add(d.id); renderDocs(); requestAnimationFrame(() => document.querySelector<HTMLElement>(sel$(`zh-${d.id}`))?.focus()); } }, 'Add Chinese description') : null,
      h('button', { class: 'linkbtn', dataset: { key: `typed-${d.id}` }, title: 'Attach a typed copy of an illegible page (PD 5.6 para 6)', onclick: () => askTyped(d) }, 'Attach typed copy'),
      h('button', {
        class: 'linkbtn danger', dataset: { key: `rm-${d.id}` }, 'aria-label': `Remove "${d.description}"`, disabled: locked,
        title: locked ? 'Issued documents cannot be removed without re-issuing' : '',
        onclick: () => { S.project.docs = S.project.docs.filter((x) => x.id !== d.id); changed(); announce(`Removed "${d.description}".`); },
      }, 'Remove'))),
  h('td', { dataset: { label: 'Type' } }, h('select', { 'aria-label': `Type of document ${i + 1}`, dataset: { key: `type-${d.id}` }, onchange: (e: Event) => { d.type = (e.target as HTMLSelectElement).value as DocType; changed(); } },
    ...DOC_TYPES.map(([v, l]) => h('option', { value: v, selected: d.type === v }, l)))),
  h('td', { dataset: { label: 'Status' } }, h('select', { 'aria-label': `Status of document ${i + 1} (PD 5.6 para 3)`, dataset: { key: `st-${d.id}` }, onchange: (e: Event) => { d.status = (e.target as HTMLSelectElement).value as DocStatus; changed({ docs: false }); } },
    ...STATUSES.map(([v, l]) => h('option', { value: v, selected: d.status === v }, l)))),
  S.project.settings.sectionsEnabled ? h('td', { dataset: { label: 'Section' } }, h('select', { 'aria-label': `Section of document ${i + 1}`, dataset: { key: `sec-${d.id}` }, onchange: (e: Event) => { d.sectionId = (e.target as HTMLSelectElement).value || undefined; changed(); } },
    h('option', { value: '' }, '—'), ...S.project.sections.map((s) => h('option', { value: s.id, selected: d.sectionId === s.id }, `${s.letter} ${s.title}`)))) : null,
  h('td', { class: 'center', dataset: { label: 'Core' } }, h('input', { type: 'checkbox', checked: d.core, disabled: d.type === 'transcript', 'aria-label': `Document ${i + 1} in core bundle`, title: d.type === 'transcript' ? 'Transcripts go in the transcript bundle' : 'Include in the core bundle', dataset: { key: `core-${d.id}` }, onchange: (e: Event) => { d.core = (e.target as HTMLInputElement).checked; changed({ docs: false }); } })),
  h('td', { class: 'num', dataset: { label: 'Pages' } }, String(docPages(d))));
  return tr;
}

async function askTyped(d: BundleDoc) {
  const max = fileById(d.fileId)?.pageCount ?? 1;
  const input = h('input', { type: 'number', min: 1, max, value: 1, class: 'short' });
  const v = await dialog('Attach a typed copy', [
    h('p', null, `The typed copy is placed straight after the page you choose in "${d.description}" (${max} page${max > 1 ? 's' : ''}).`),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'After page'), input),
  ], [{ label: 'Cancel', value: 'no' }, { label: 'Choose file…', value: 'yes', primary: true }]);
  if (v !== 'yes') return;
  const page = Math.min(max, Math.max(1, Number(input.value) || 1));
  pickFiles({ kind: 'typed', docId: d.id, afterPage: page }, false);
}

function renderDocs() {
  const p = S.project;
  const ordered = orderedDocs(p);
  const warn = new Map<string, string>();
  if (!isFrozen()) for (const w of chronologyWarnings(p, ordered)) if (w.code === 'not-chronological' && w.docId) warn.set(w.docId, w.message);
  const total = p.docs.filter((d) => d.type !== 'transcript').reduce((a, d) => a + docPages(d), 0);
  const frozenIds = frozenDocIds() as Set<string>;
  const missing = missingFiles();
  const anyCore = p.docs.some((d) => d.core);

  const drop = h('div', {
    class: 'drop', tabindex: 0, role: 'button', 'aria-label': 'Add documents: choose PDF, JPG or PNG files',
    onclick: () => pickFiles({ kind: 'doc' }),
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles({ kind: 'doc' }); } },
    ondragover: (e: DragEvent) => { if (!dragId) { e.preventDefault(); drop.classList.add('over'); } },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e: DragEvent) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files); },
  },
  h('strong', null, 'Add documents'), h('span', null, 'Drop PDF, JPG or PNG files here, or click to choose. Word and email files: convert to PDF first.'),
  S.ingesting ? h('span', { class: 'busy' }, `Reading ${S.ingesting} file(s)…`) : null);

  replace($('docs'),
    h('h2', null, h('span', { class: 'step' }, '2'), 'Documents'),
    isFrozen() ? h('div', { class: 'notice' }, h('strong', null, `Issued ${new Date(S.project.frozen!.issuedAt).toLocaleDateString('en-GB')}. `),
      'Page numbers are locked. New documents go in after a page you choose and are numbered 88-1, 88-2… (PD 5.6 para 1).',
      ' ', h('button', { class: 'btn ghost small', dataset: { key: 'unlock' }, onclick: async () => { if (await confirmDialog('Unlock page numbers?', ['The whole bundle will be renumbered on the next build. Only do this if you will re-issue and re-lodge the bundle.'], 'Unlock')) { S.project = unfreezeProject(S.project); changed(); renderAll(); } } }, 'Unlock…')) : null,
    missing.length ? h('div', { class: 'notice warn' }, h('strong', null, 'Add these files again to continue: '), missing.map((f) => f.name).join(', '),
      h('span', { class: 'hint' }, ' They are recognised by content, so the file names can differ. If a file has changed, it will be added as a new document instead.')) : null,
    drop,
    S.fileErrors.length ? h('div', { class: 'notice bad' },
      h('ul', null, ...S.fileErrors.map((e) => h('li', null, e.message))),
      h('button', { class: 'btn ghost small', dataset: { key: 'errors-dismiss' }, onclick: () => { S.fileErrors = []; renderDocs(); } }, 'Dismiss')) : null,
    p.docs.length ? h('div', { class: 'toolbar' },
      h('button', { class: 'btn small', dataset: { key: 'sort' }, onclick: sortByDate, disabled: isFrozen() }, 'Sort by date'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { key: 'sections-toggle' }, checked: p.settings.sectionsEnabled, onchange: (e: Event) => { p.settings.sectionsEnabled = (e.target as HTMLInputElement).checked; if (p.settings.sectionsEnabled && !p.sections.length) p.sections.push({ id: uid('s'), letter: 'A', title: 'Pleadings' }); changed(); renderSettings(); } }), 'Use sections'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { key: 'arrows-toggle' }, checked: S.reorder === 'arrows', onchange: (e: Event) => { S.reorder = (e.target as HTMLInputElement).checked ? 'arrows' : 'drag'; renderDocs(); } }), 'Show move buttons'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, `${p.docs.length} document(s), ${total} page(s)`),
      h('button', { class: 'btn ghost small', dataset: { key: 'clear-all' }, disabled: isFrozen(), onclick: async () => { if (await confirmDialog('Remove all documents?', ['This removes every document from the list (the case details and cover page stay).'], 'Remove all')) { S.project.docs = []; S.zhOpen.clear(); S.dateDraft.clear(); changed(); } } }, 'Clear all')) : null,
    p.settings.sectionsEnabled ? renderSections() : null,
    p.docs.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'docs' },
      h('thead', null, h('tr', null,
        h('th', null, h('span', { class: 'sr' }, 'Reorder')), h('th', null, 'No.'), h('th', null, 'Date'), h('th', null, 'Description'),
        h('th', null, 'Type'), h('th', null, 'Status'), p.settings.sectionsEnabled ? h('th', null, 'Section') : null,
        h('th', null, 'Core'), h('th', null, 'Pages'))),
      h('tbody', null, ...p.docs.map((d, i) => docRow(d, i, warn, frozenIds))))) : null,
    warn.size ? h('p', { class: 'warn' }, `${warn.size} document(s) are out of date order (PD 5.6 para 4(2)). "Sort by date" fixes this, or keep your order if the parties have agreed it.`) : null,
    total > 100 && !anyCore ? h('p', { class: 'notice' }, h('strong', null, 'Core bundle: '), `the documents come to ${total} pages. PD 5.6 para 2 says a core bundle should be prepared where the agreed bundle exceeds 100 pages: tick "Core" for the documents central to the dispute.`) : null,
    p.docs.length ? h('p', { class: 'muted small' }, 'Reminder (PD 5.6 para 1): leave out documents unlikely to be referred to at the trial.') : null);
}

function renderSections() {
  const p = S.project;
  return h('div', { class: 'sections' },
    h('span', { class: 'lbl' }, 'Sections (in order):'),
    ...p.sections.map((s, i) => h('span', { class: 'section' },
      h('input', {
        type: 'text', class: 'short', value: s.letter, maxlength: 3, 'aria-label': `Letter of section ${i + 1} (capital letters A-Z)`, dataset: { key: `sl-${s.id}` },
        onchange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value.trim().toUpperCase();
          if (!validSectionLetter(v)) { announce('Section letters must be 1 to 3 capital letters A-Z.'); renderDocs(); return; }
          if (p.sections.some((x) => x !== s && x.letter === v)) { announce(`Section letter ${v} is already used.`); renderDocs(); return; }
          s.letter = v; changed();
        },
      }),
      h('input', { type: 'text', value: s.title, 'aria-label': `Title of section ${i + 1}`, dataset: { key: `stt-${s.id}` }, onchange: (e: Event) => { s.title = (e.target as HTMLInputElement).value; changed(); } }),
      h('button', { class: 'btn ghost small', 'aria-label': `Remove section ${s.letter}`, onclick: () => { p.sections.splice(i, 1); p.docs.forEach((d) => { if (d.sectionId === s.id) delete d.sectionId; }); changed(); } }, '×'))),
    h('button', {
      class: 'btn small', dataset: { key: 'add-section' }, onclick: () => {
        let n = 0; let letter = 'A';
        const used = new Set(p.sections.map((x) => x.letter));
        // Next free letter: A…Z, then AA, AB…
        do { letter = n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26)); n++; } while (used.has(letter));
        p.sections.push({ id: uid('s'), letter, title: '' }); changed();
      },
    }, 'Add section'));
}

// ---------------------------------------------------------------- rendering: settings

function sel<T extends string>(label: string, value: T, options: [T, string][], set: (v: T) => void, hint?: string) {
  return field(label, h('select', { onchange: (e: Event) => { set((e.target as HTMLSelectElement).value as T); changed({ docs: false }); } },
    ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))), hint);
}
function chk(label: string, value: boolean, set: (v: boolean) => void) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); changed({ docs: false }); } }), label);
}

function renderSettings() {
  const s = S.project.settings;
  const st = s.stamp;
  replace($('settings'),
    h('details', { open: S.settingsOpen || null, ontoggle: (e: Event) => { S.settingsOpen = (e.target as HTMLDetailsElement).open; } }, h('summary', null, h('h2', null, h('span', { class: 'step' }, '3'), 'Settings', h('span', { class: 'summary-cue' }, ''), h('span', { class: 'muted small normal' }, 'Defaults follow PD 5.6; change only if needed.'))),
      h('div', { class: 'grid3' },
        h('fieldset', null, h('legend', null, 'Volumes and numbering'),
          field('Pages per file', h('input', { type: 'number', min: 20, max: 1000, value: s.maxPagesPerVolume, onchange: (e: Event) => { s.maxPagesPerVolume = Math.max(20, Number((e.target as HTMLInputElement).value) || 250); changed({ docs: false }); } }), 'PD 5.6 para 5: never more than 250.'),
          sel('Numbering', s.numbering, [['continuous', 'Consecutive across all files (1, 2, 3…)'], ['per-volume', 'Restart each file (A1, B1…)'], ...(s.sectionsEnabled || s.numbering === 'per-section' ? [['per-section', 'Restart each section (A1, B1…)'] as ['per-section', string]] : [])], (v) => { s.numbering = v; },
            s.sectionsEnabled ? undefined : 'Turn on "Use sections" (Documents) to restart numbering in each section.'),
          sel('Section label', s.sectionPrefix, [['Section', '"Section A"'], ['Part', '"Part A"'], ['', '"A"']], (v) => { s.sectionPrefix = v; }),
          chk('Status front sheet (PD 5.6 para 3)', s.frontSheet, (v) => { s.frontSheet = v; }),
          chk('Printable: blank page after odd-length documents', s.printable, (v) => { s.printable = v; })),
        h('fieldset', null, h('legend', null, 'Page numbers'),
          sel('Style', st.style, [['X', '12'], ['PageX', 'Page 12'], ['XofY', '12 of 300'], ['XslashY', '12/300'], ['PageXofY', 'Page 12 of 300'], ['None', 'None']], (v) => { st.style = v; }),
          sel('Position', st.position, [['top-right', 'Top right (PD 5.6)'], ['top-centre', 'Top centre'], ['top-left', 'Top left'], ['bottom-right', 'Bottom right'], ['bottom-centre', 'Bottom centre'], ['bottom-left', 'Bottom left']], (v) => { st.position = v; }),
          field('Prefix', h('input', { type: 'text', value: st.prefix, placeholder: 'e.g. Exhibit A-', onchange: (e: Event) => { st.prefix = (e.target as HTMLInputElement).value; changed({ docs: false }); } })),
          sel('Size', st.size, [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']], (v) => { st.size = v; }),
          sel('Colour', st.colour, [['black', 'Black'], ['red', 'Red'], ['blue', 'Blue']], (v) => { st.colour = v; })),
        h('fieldset', null, h('legend', null, 'Index and bookmarks'),
          sel('Date format', s.dateStyle, [['DD/MM/YYYY', '15/03/2024'], ['DD Month YYYY', '15 March 2024'], ['DD Mon. YYYY', '15 Mar. 2024'], ['YYYY-MM-DD', '2024-03-15'], ['DD-MM-YYYY', '15-03-2024'], ['MM/DD/YYYY', '03/15/2024'], ['Month DD, YYYY', 'March 15, 2024'], ['Mon. DD, YYYY', 'Mar. 15, 2024'], ['None', 'No date column']], (v) => { s.dateStyle = v; }),
          sel('Bookmarks', s.outlineStyle, [['withDateAndPage', 'Title (date) — p. 12'], ['withPage', 'Title — p. 12'], ['withDate', 'Title (date)'], ['plain', 'Title']], (v) => { s.outlineStyle = v; }),
          sel('Heading size', s.index.headingSize, [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']], (v) => { s.index.headingSize = v; }),
          sel('Table text size', s.index.tableSize, [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']], (v) => { s.index.tableSize = v; }),
          chk('Table borders', s.index.borders, (v) => { s.index.borders = v; }),
          chk('English and 繁體中文 headings', s.bilingualHeadings, (v) => { s.bilingualHeadings = v; }),
          h('p', { class: 'hint' }, 'Chinese text loads extra fonts (about 27 MB, once). Have the Chinese headings checked before lodging.'))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { announce(store.set(LS.defaults, JSON.stringify(s)) ? 'Saved as your defaults on this device.' : 'This browser does not allow saving settings.'); } }, 'Save as my defaults'),
        h('button', { class: 'btn ghost small', onclick: () => { store.del(LS.defaults); announce('Saved defaults erased.'); } }, 'Erase saved defaults'),
        h('button', { class: 'btn ghost small', onclick: () => { S.project.settings = structuredClone(DEFAULT_SETTINGS); renderSettings(); changed(); announce('Settings reset to the PD 5.6 defaults.'); } }, 'Reset to PD 5.6 defaults'))));
}

// ---------------------------------------------------------------- rendering: build

function updateProgress() {
  const bar = document.getElementById('progress') as HTMLProgressElement | null;
  const lbl = document.getElementById('progress-label');
  if (!bar || !lbl || !S.job) return;
  bar.max = Math.max(1, S.job.total);
  bar.value = S.job.done;
  lbl.textContent = `${S.job.label}: ${S.job.done} of ${S.job.total}`;
}

const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);

function renderBuild() {
  const p = S.project;
  const ready = p.docs.length > 0 && !missingFiles().length && !S.ingesting;
  const plan = S.plan;
  const sevCodes = new Set(['not-chronological', 'volume-over-limit', 'non-compliant-setting', 'core-bundle-needed', 'duplicate', 'undated', 'appended-after-issue']);
  const resultWarnings = S.results?.warnings ?? plan?.warnings ?? [];
  // Editing is locked while a build runs, so the result always matches what is on screen.
  for (const id of ['case', 'docs', 'settings', 'hdr-actions', 'restore', 'remember', 'guide']) document.getElementById(id)?.toggleAttribute('inert', !!S.job);
  replace($('build'),
    h('h2', null, h('span', { class: 'step' }, '4'), 'Build'),
    S.planError ? h('div', { class: 'notice bad' }, S.planError) : null,
    plan ? h('div', { class: 'plan' },
      h('p', null, h('strong', null, `${plan.physicalFiles} file${plan.physicalFiles > 1 ? 's' : ''}: `),
        plan.volumes.map((v) => `${v.name} (pp. ${v.first}–${v.last}, ${v.pages} pages in all)`).join('; '), '.')) : null,
    !ready && !S.job ? h('p', { class: 'hint' }, !p.docs.length ? 'Add documents to build the bundle.' : missingFiles().length ? 'Add the missing files again (see Documents) to build.' : 'Reading files…') : null,
    S.fontsState === 'loading' ? h('p', { class: 'hint' }, 'Loading Chinese fonts (about 27 MB, once per visit)…') : null,
    S.fontsState === 'failed' ? h('p', { class: 'warn' }, 'The Chinese fonts could not be loaded; check the connection and try again.') : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn', dataset: { key: 'b-preview' }, disabled: !ready || !!S.job, onclick: () => runBuild({ prelimsOnly: true }) }, 'Preview index'),
      h('button', { class: 'btn primary', dataset: { key: 'b-build' }, disabled: !ready || !!S.job, onclick: () => runBuild() }, 'Build bundle'),
      h('button', { class: 'btn', dataset: { key: 'b-issue' }, disabled: !ready || !!S.job, onclick: () => runBuild({ issue: true }), title: 'Build and lock the page numbers for later 88-1 inserts' }, isFrozen() ? 'Build and re-issue' : 'Build and issue…')),
    S.job ? h('div', { class: 'job' },
      h('progress', { id: 'progress', max: S.job.total, value: S.job.done }),
      h('span', { id: 'progress-label' }, `${S.job.label}…`),
      h('button', { class: 'btn small', dataset: { key: 'b-cancel' }, onclick: () => { worker.postMessage({ type: 'cancel' } satisfies ToWorker); announce('Cancelling.'); } }, 'Cancel')) : null,
    S.results ? h('div', { class: 'results' },
      h('h3', null, S.results.preview ? 'Index preview' : 'Your bundle'),
      S.results.zip ? h('p', { class: 'row' },
        h('a', { class: 'btn primary', href: S.results.zip.url, download: S.results.zip.fileName }, 'Download everything (ZIP)'),
        h('span', { class: 'muted' }, ` ${S.results.zip.fileName}, ${kb(S.results.zip.size)}`)) : null,
      h('details', { open: S.results.preview || null },
        h('summary', { class: 'small linkish-summary' }, S.results.preview ? `Files (${S.results.files.length})` : `Download files one by one (${S.results.files.length})`),
        h('ul', { class: 'files' }, ...S.results.files.map((f) => h('li', null,
          h('a', { href: f.url, download: f.fileName }, f.fileName),
          h('span', { class: 'muted' }, ` ${f.pageCount ? `${f.pageCount} pages, ` : ''}${kb(f.size)}`),
          f.fileName.endsWith('.pdf') ? [' ', h('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'small' }, 'Open')] : null)))),
      S.results.checks ? h('div', { class: 'compliance' },
        h('h3', null, 'PD 5.6 compliance report'),
        h('div', { class: 'reportwrap' }, h('table', { class: 'report' },
          h('thead', null, h('tr', null, h('th', null, 'Para'), h('th', null, 'Requirement'), h('th', null, 'Result'), h('th', null, 'Detail'))),
          h('tbody', null, ...S.results.checks.map((c) => h('tr', { class: c.status === 'warning' ? 'oo' : '' },
            h('td', null, c.para), h('td', null, c.requirement),
            h('td', null, h('span', { class: `badge ${c.status === 'warning' ? 'warn' : c.status === 'pass' ? '' : 'muted'}` }, c.status === 'pass' ? 'Pass' : c.status === 'warning' ? 'Warning' : 'Not applicable')),
            h('td', { class: 'small' }, c.detail))))))) : null,
      !S.results.preview ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: saveProject }, 'Save project file'),
        h('span', { class: 'muted small' }, 'The ZIP already contains the project file.')) : null) : null,
    resultWarnings.length ? h('div', { class: 'checks' },
      h('h3', null, `Checks (${resultWarnings.length})`),
      h('ul', null, ...resultWarnings.map((w) => h('li', { class: sevCodes.has(w.code) ? 'warn' : '' }, w.message)))) : null);
  updateProgress();
}

// ---------------------------------------------------------------- footer, autosave prompt

function renderFooter() {
  const on = store.get(LS.autosave) === '1';
  replace($('remember'),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: on, onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) {
          if (!store.set(LS.autosave, '1')) { (e.target as HTMLInputElement).checked = false; announce('This browser does not allow saving project details.'); return; }
          autosave();
          announce('Project details will be remembered in this browser.');
        } else {
          clearTimeout(autosaveTimer);
          store.del(LS.autosave); store.del(LS.project);
          announce('Remembered project details erased.');
        }
      },
    }), 'Remember project details in this browser'),
    h('span', { class: 'hint' }, ' Stores only the list, dates, descriptions and settings on this device, never document contents. Untick to erase.'));
}

function offerRestore() {
  const saved = store.get(LS.autosave) === '1' ? store.get(LS.project) : null;
  if (!saved) return;
  try {
    const { project } = parseProject(saved);
    if (!project.docs.length) return;
    replace($('restore'),
      h('div', { class: 'notice' }, `Continue "${project.case.shortTitle || project.case.actionNo || 'your last project'}" (${project.docs.length} documents)? You will need to add the files again.`,
        ' ', h('button', { class: 'btn small', onclick: () => { adoptProject(project); replace($('restore')); } }, 'Continue'),
        ' ', h('button', { class: 'btn ghost small', onclick: () => replace($('restore')) }, 'Not now')));
  } catch { /* ignore a corrupt autosave */ }
}

function renderAll() {
  renderHeader(); renderGuide(); renderCase(); renderDocs(); renderSettings(); renderBuild(); renderFooter();
}

// ---------------------------------------------------------------- boot

// ---------------------------------------------------------------- example documents and the walk-through

/** Make a few example PDFs on this device (nothing is downloaded) and add them like any other files. */
async function loadExamples() {
  if (S.project.docs.length && !(await confirmDialog('Add example documents?', ['The example documents are added to your current list. Use "New" first if you want to start clean.'], 'Add them'))) return;
  const r = await call<'samples'>({ type: 'samples', reqId: uid('r') });
  const files = r.files.map((f) => new File([f.bytes as BlobPart], f.name, { type: 'application/pdf' }));
  const c = S.project.case;
  if (!c.actionNo && !c.shortTitle) {
    c.actionNo = 'HCA 1234/2025';
    c.shortTitle = 'Chan v Wong (example)';
    c.parties = [{ name: 'CHAN TAI MAN', role: 'Plaintiff' }, { name: 'WONG SIU MING', role: 'Defendant' }];
    renderCase();
  }
  await addFiles(files);
}

function tourSteps(): TourStep[] {
  const q = (sel: string) => () => document.querySelector(sel);
  const p = (t: string) => h('p', null, t);
  return [
    {
      title: 'How Big Bundle Wright works',
      body: [p('This walk-through takes about two minutes. It goes through the four parts of the page: case details, documents, settings and build.'),
        p('You can follow along with your own files, or with a few example documents made on this device.')],
      actions: S.project.docs.length ? undefined : [{ label: 'Use example documents', run: loadExamples }, { label: 'Use my own files', primary: true, run: () => undefined }],
    },
    {
      target: q('#case .grid2'), title: 'Case details',
      body: [p('Enter the action number and the parties as they appear in the title of the action.'),
        p('The short title goes into the file names, for example "HCA 1234-2025 Chan v Wong Bundle A.pdf". Add the hearing date to see the lodging deadline under PD 5.6 para 8.')],
    },
    {
      target: q('#docs .drop'), title: 'Add the documents',
      body: [p('Drop PDFs, JPGs or PNGs here, or click to choose them. Dates and titles are read from file names such as "2025-03-15 Letter to D.pdf".'),
        p('Password-protected PDFs and Word files are refused with a message saying what to do.')],
    },
    {
      target: () => document.querySelector('#docs table.docs tbody tr') ?? document.querySelector('#docs'), title: 'Check the list',
      body: [p('Each row is one document, in bundle order. Check its date and description, and choose its status under PD 5.6 para 3.'),
        p('To reorder, drag the handle at the left, or focus it and press Alt with the up or down arrow. Tick Core for the documents central to the dispute.')],
    },
    {
      target: () => document.querySelector('#docs tbody tr td.desc') ?? document.querySelector('#docs'), title: 'What each row tells you',
      body: [p('Under each description you can see where the document will land, for example "Bundle A, pages 1–8".'),
        p('Labels mark anything worth a look: scanned pages with no searchable text, content close to the edge, a missing date or a duplicate file.')],
    },
    {
      target: q('#settings'), title: 'Settings',
      body: [p('The defaults follow PD 5.6: numbers in the top right-hand corner, no more than 250 pages a file, and a status front sheet. Change them only if the parties have agreed something different.')],
    },
    {
      target: () => document.querySelector('#build .row') ?? document.querySelector('#build'), title: 'Build the bundle',
      body: [h('ul', null,
        h('li', null, h('b', null, 'Preview index'), ' builds just the index pages, to check them quickly.'),
        h('li', null, h('b', null, 'Build bundle'), ' gives one ZIP: every volume, the Word index, spine labels and a compliance report.'),
        h('li', null, h('b', null, 'Build and issue'), ' also locks the page numbers, so late documents go in as 88-1, 88-2 without renumbering.'))],
    },
    {
      target: q('#hdr-actions'), title: 'Save your project',
      body: [p('Save the project file to come back later. It holds the list, dates, descriptions and settings, never the documents themselves.'),
        p('When you open it again, add the same files; they are recognised by their content, even if renamed.')],
    },
    {
      title: 'That is the whole process',
      body: [p('Reopen this walk-through any time with "Tour" at the top of the page.')],
    },
  ];
}

function openTour() {
  if (tourIsOpen() || S.job) return;
  startTour(tourSteps(), { onClose: () => { store.set(LS.toured, '1'); renderGuide(); } });
}

startWorker();
for (const img of document.querySelectorAll<HTMLImageElement>('img.brand-icon')) img.src = iconUrl;
// Keep a dropped file from opening in the tab if it misses the drop zone.
window.addEventListener('dragover', (e) => { if (!dragId) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (!dragId) e.preventDefault(); });
renderAll();
offerRestore();

