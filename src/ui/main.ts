// Big Bundle Wright: the page. All document processing happens in ./worker.ts, on this device.
// SPDX-License-Identifier: MPL-2.0

import './styles.css';
import logoUrl from '../../assets/logo/glass-horizontal.svg?url';
import {
  DEFAULT_SETTINGS, chronologyWarnings, describeDeadline, lodgingDeadline, parseFileName, parseProject,
  serializeProject, unfreezeProject, outputBaseName, PROJECT_SCHEMA,
  type BundleDoc, type BuildWarning, type DocStatus, type DocType, type Project, type Settings, type SourceFileRef,
} from '../engine/index.ts';
import { orderedDocs } from '../engine/plan.ts';
import { announce, download, h, replace, uid } from './dom.ts';
import type { FileFlags, FromWorker, PlanSummary, ToWorker } from './protocol.ts';

const VERSION = '0.4.0';
const LS = { autosave: 'bigbundlewright:autosave', project: 'bigbundlewright:project', defaults: 'bigbundlewright:defaults', guide: 'bigbundlewright:guide-dismissed' };

// ---------------------------------------------------------------- worker RPC

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<string, { resolve: (m: FromWorker) => void; reject: (e: WorkerError) => void; progress?: (m: Extract<FromWorker, { type: 'progress' }>) => void }>();
interface WorkerError { name: string; code?: string; fileName?: string; message: string }

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
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
};

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
    const saved = JSON.parse(localStorage.getItem(LS.defaults) ?? 'null');
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
  results: null as null | { files: { fileName: string; url: string; pageCount: number; size: number }[]; warnings: BuildWarning[]; preview: boolean },
  reorder: 'drag' as 'drag' | 'arrows',
  ingesting: 0,
  dateDraft: new Map<string, string>(),
  analysisErrors: new Map<string, string>(),
};

const DOC_TYPES: [DocType, string][] = [['document', 'Document'], ['pleading', 'Pleading'], ['witness_statement', 'Witness statement'], ['expert', 'Expert report'], ['correspondence', 'Correspondence'], ['transcript', 'Transcript']];
const STATUSES: [DocStatus, string][] = [['authentic', '(1) Authentic'], ['inclusion_only', '(2) Inclusion only'], ['evidence_of_contents', '(3) Evidence of contents']];

const fileById = (id: string) => S.project.files.find((f) => f.id === id);
const docPages = (d: BundleDoc) => (fileById(d.fileId)?.pageCount ?? 0) + (d.typedCopies ?? []).reduce((a, t) => a + (fileById(t.fileId)?.pageCount ?? 0), 0);
const missingFiles = () => S.project.files.filter((f) => !S.loaded.has(f.sha256));
const isFrozen = () => !!S.project.frozen;
const frozenDocIds = () => new Set(Object.values(S.project.frozen?.bundles ?? {}).flatMap((b) => b?.volumes.flatMap((v) => v.pages.map((p) => p.docId)) ?? []));

function changed(opts: { docs?: boolean; build?: boolean } = {}) {
  S.results = null;
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
  S.ingesting += files.length;
  renderDocs();
  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer();
      const res = await call<'ingested'>({ type: 'ingest', reqId: uid('r'), tempId: uid('t'), name: file.name, bytes }, undefined, [bytes]);
      onIngested(res.ref, purpose);
    } catch (e) {
      const err = e as WorkerError;
      S.fileErrors.push({ name: file.name, message: err.message ?? String(e) });
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
  S.results = null;
  renderAll();
  schedulePlan();
}

let autosaveTimer = 0;
function autosave() {
  if (localStorage.getItem(LS.autosave) !== '1') return;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => localStorage.setItem(LS.project, serializeProject(S.project)), 400);
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
    } catch (e) {
      if (seq !== planSeq) return;
      S.plan = null; S.planError = (e as WorkerError).message;
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
  clearResults();
  const reqId = uid('r');
  S.job = { label: 'Starting', done: 0, total: 1 };
  renderBuild();
  try {
    const r = await call<'built'>({ type: 'build', reqId, project: S.project, issue: opts.issue, prelimsOnly: opts.prelimsOnly }, (p) => {
      S.job = { label: p.phase, done: p.done, total: p.total };
      updateProgress();
    });
    S.results = {
      preview: !!opts.prelimsOnly,
      warnings: r.warnings,
      files: r.files.map((f) => ({ fileName: f.fileName, pageCount: f.pageCount, size: f.bytes.byteLength, url: URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: 'application/pdf' })) })),
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

function showError(title: string, err: { name?: string; message: string; stack?: string }) {
  const details = [
    `Big Bundle Wright ${VERSION}`, `Browser: ${navigator.userAgent}`,
    `Error: ${err.name ?? 'Error'}: ${err.message}`,
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
  if (localStorage.getItem(LS.guide) === '1') { el.hidden = true; return; }
  el.hidden = false;
  replace(el,
    h('div', { class: 'guide-head' }, h('h2', null, 'Before you start: PD 5.6 in brief'),
      h('button', { class: 'btn ghost small', onclick: () => { localStorage.setItem(LS.guide, '1'); renderGuide(); } }, 'Hide')),
    h('ul', { class: 'guide' },
      h('li', null, h('strong', null, 'Leave out unnecessary documents'), ' — only those likely to be referred to at trial (para 1).'),
      h('li', null, h('strong', null, 'Chronological order'), ', paged consecutively in the top right-hand corner (para 4).'),
      h('li', null, h('strong', null, 'No more than 250 pages a file'), '; transcripts in a separate bundle (para 5).'),
      h('li', null, h('strong', null, 'Core bundle'), ' where the agreed bundle exceeds 100 pages (para 2).'),
      h('li', null, h('strong', null, 'Status of each document'), ' marked on the front (para 3).'),
      h('li', null, h('strong', null, 'Lodge at least 72 hours'), ' before the hearing, not counting weekends and general holidays (para 8).')));
}

function field(label: string, input: HTMLElement, hint?: string) {
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

function textInput(key: string, value: string, onInput: (v: string) => void, attrs: Record<string, unknown> = {}) {
  return h('input', { type: 'text', value, dataset: { key }, oninput: (e: Event) => onInput((e.target as HTMLInputElement).value), ...attrs });
}

function renderCase() {
  const c = S.project.case;
  const set = () => { autosave(); schedulePlan(); renderDeadline(); };
  const courtSel = h('select', {
    dataset: { key: 'court-preset' },
    onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (COURTS[v]) { c.court = v ? COURTS[v] : c.court; renderCase(); set(); } },
  }, h('option', { value: '' }, 'Preset…'), ...Object.keys(COURTS).map((k) => h('option', { value: k, selected: COURTS[k] === c.court }, k)));
  const court = h('textarea', { rows: 3, dataset: { key: 'court' }, oninput: (e: Event) => { c.court = (e.target as HTMLTextAreaElement).value; set(); } });
  court.value = c.court;

  const parties = h('div', { class: 'parties' },
    ...c.parties.map((p, i) => h('div', { class: 'party' },
      textInput(`pn${i}`, p.name, (v) => { p.name = v; set(); }, { placeholder: 'Name (as in the title of the action)', 'aria-label': `Party ${i + 1} name` }),
      textInput(`pr${i}`, p.role, (v) => { p.role = v; set(); }, { placeholder: 'Role', class: 'role', 'aria-label': `Party ${i + 1} role` }),
      h('button', { class: 'btn ghost small', 'aria-label': `Remove party ${i + 1}`, onclick: () => { c.parties.splice(i, 1); renderCase(); set(); } }, '×'))),
    h('button', { class: 'btn small', onclick: () => { c.parties.push({ name: '', role: 'Defendant' }); renderCase(); } }, 'Add party'));

  const cover = c.coversheetFileId ? fileById(c.coversheetFileId) : undefined;
  replace($('case'),
    h('h2', null, h('span', { class: 'step' }, '1'), 'Case details'),
    h('div', { class: 'grid2' },
      field('Action number', textInput('actionNo', c.actionNo, (v) => { c.actionNo = v; set(); }, { placeholder: 'HCA 1234/2025' })),
      field('Short title', textInput('shortTitle', c.shortTitle, (v) => { c.shortTitle = v; set(); }, { placeholder: 'Chan v Wong' }), 'Used in file names: "HCA 1234-2025 Chan v Wong Bundle A.pdf".'),
      field('Bundle title', textInput('bundleTitle', c.bundleTitle, (v) => { c.bundleTitle = v; set(); })),
      field('Hearing date', h('input', { type: 'date', value: c.hearingDate ?? '', dataset: { key: 'hearing' }, onchange: (e: Event) => { c.hearingDate = (e.target as HTMLInputElement).value || undefined; set(); } }),
        'Used to work out the lodging deadline.')),
    h('p', { id: 'deadline', class: 'deadline', 'aria-live': 'polite' }),
    h('div', { class: 'grid2' },
      field('Court', h('div', { class: 'stack' }, courtSel, court)),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Parties'), parties)),
    h('div', { class: 'row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.confidential, onchange: (e: Event) => { c.confidential = (e.target as HTMLInputElement).checked; set(); } }), 'Mark as confidential'),
      h('span', { class: 'cover' }, 'Cover page: ', cover ? h('span', null, cover.name, ' ', h('button', { class: 'btn ghost small', onclick: () => { delete c.coversheetFileId; renderCase(); changed(); } }, 'Remove'))
        : h('button', { class: 'btn small', onclick: () => pickFiles({ kind: 'cover' }, false) }, 'Add a cover page (optional)'))));
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
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-key="handle-${id}"]`)?.focus());
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
  const notes: (string | Node)[] = [];
  if (missing) notes.push(h('span', { class: 'badge bad' }, 'File needed'));
  if (warn.get(d.id)) notes.push(h('span', { class: 'badge warn', title: warn.get(d.id) }, 'Out of order'));
  if (fl?.imageOnly.length) notes.push(h('span', { class: 'badge', title: `Pages ${fl.imageOnly.join(', ')} are images with no text layer. Check legibility; you can attach a typed copy.` }, `Scanned: ${fl.imageOnly.length} p.`));
  if (fl?.edge.length) notes.push(h('span', { class: 'badge', title: `Pages ${fl.edge.join(', ')} have content within 5 mm of the edge.` }, 'Near edge'));
  if (f && S.project.files.some((g) => g.id !== f.id && g.sha256 === f.sha256)) notes.push(h('span', { class: 'badge warn' }, 'Duplicate'));
  if (f && fl === undefined && S.loaded.has(f.sha256)) notes.push(h('span', { class: 'badge muted' }, 'Checking…'));
  if (f && fl === null) notes.push(h('span', { class: 'badge warn', title: S.analysisErrors.get(f.sha256) ?? '' }, 'Pages not checked'));
  for (const t of d.typedCopies ?? []) notes.push(h('span', { class: 'badge' }, `Typed copy after p. ${t.afterPage} `, h('button', { class: 'linkish', 'aria-label': 'Remove typed copy', onclick: () => { d.typedCopies = d.typedCopies!.filter((x) => x !== t); changed(); } }, '×')));

  const tr = h('tr', {
    class: `${warn.get(d.id) ? 'oo' : ''} ${isNew ? 'new' : ''}`, dataset: { id: d.id },
    draggable: S.reorder === 'drag' ? 'true' : null,
    ondragstart: (e: DragEvent) => { dragId = d.id; e.dataTransfer?.setData('text/plain', d.id); tr.classList.add('dragging'); },
    ondragend: () => { dragId = null; tr.classList.remove('dragging'); },
    ondragover: (e: DragEvent) => { if (dragId) { e.preventDefault(); tr.classList.add('over'); } },
    ondragleave: () => tr.classList.remove('over'),
    ondrop: (e: DragEvent) => { e.preventDefault(); tr.classList.remove('over'); if (dragId) moveDoc(dragId, i); },
  },
  h('td', { class: 'handle-cell' },
    h('button', {
      class: 'handle', dataset: { key: `handle-${d.id}` }, 'aria-label': `Reorder "${d.description}". Use Alt plus arrow keys to move.`,
      title: 'Drag, or press Alt+↑ / Alt+↓', onkeydown: (e: KeyboardEvent) => {
        if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveDoc(d.id, i - 1); }
        if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveDoc(d.id, i + 1); }
      },
    }, '⠿'),
    S.reorder === 'arrows' ? h('span', { class: 'arrows' },
      h('button', { class: 'btn ghost small', disabled: i === 0, 'aria-label': 'Move up', onclick: () => moveDoc(d.id, i - 1) }, '▲'),
      h('button', { class: 'btn ghost small', disabled: i === n - 1, 'aria-label': 'Move down', onclick: () => moveDoc(d.id, i + 1) }, '▼')) : null),
  h('td', { class: 'num' }, String(i + 1)),
  h('td', null, h('input', {
    type: 'text', class: `date ${S.dateDraft.has(d.id) ? 'invalid' : ''}`, value: dateText, placeholder: 'DD/MM/YYYY', dataset: { key: `date-${d.id}` },
    'aria-label': `Date of "${d.description}"`, 'aria-invalid': S.dateDraft.has(d.id) ? 'true' : null,
    onchange: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      const iso = fromDisplay(v);
      if (iso === undefined) { S.dateDraft.set(d.id, v); renderDocs(); announce('That date is not valid. Use DD/MM/YYYY.'); return; }
      S.dateDraft.delete(d.id); d.date = iso; changed();
    },
  })),
  h('td', { class: 'desc' },
    h('input', { type: 'text', value: d.description, dataset: { key: `desc-${d.id}` }, 'aria-label': 'Description', oninput: (e: Event) => { d.description = (e.target as HTMLInputElement).value; autosave(); schedulePlan(); } }),
    h('input', { type: 'text', class: 'zh', lang: 'zh-Hant', value: d.descriptionZh ?? '', placeholder: '中文描述（選填）', dataset: { key: `zh-${d.id}` }, 'aria-label': 'Chinese description (optional)', oninput: (e: Event) => { d.descriptionZh = (e.target as HTMLInputElement).value || undefined; autosave(); } }),
    notes.length ? h('div', { class: 'notes' }, ...notes) : null,
    isNew ? h('div', { class: 'insert' }, h('label', null, 'Insert after page ', h('input', {
      type: 'text', class: 'short', value: d.insertAfter ?? '', placeholder: 'e.g. 88', dataset: { key: `ins-${d.id}` },
      onchange: (e: Event) => { d.insertAfter = (e.target as HTMLInputElement).value.trim() || undefined; changed(); },
    })), h('span', { class: 'hint' }, ' Numbered 88-1, 88-2… Leave blank to add at the end.')) : null),
  h('td', null, h('select', { 'aria-label': 'Type', dataset: { key: `type-${d.id}` }, onchange: (e: Event) => { d.type = (e.target as HTMLSelectElement).value as DocType; changed(); } },
    ...DOC_TYPES.map(([v, l]) => h('option', { value: v, selected: d.type === v }, l)))),
  h('td', null, h('select', { 'aria-label': 'Status (PD 5.6 para 3)', dataset: { key: `st-${d.id}` }, onchange: (e: Event) => { d.status = (e.target as HTMLSelectElement).value as DocStatus; changed({ docs: false }); } },
    ...STATUSES.map(([v, l]) => h('option', { value: v, selected: d.status === v }, l)))),
  S.project.settings.sectionsEnabled ? h('td', null, h('select', { 'aria-label': 'Section', dataset: { key: `sec-${d.id}` }, onchange: (e: Event) => { d.sectionId = (e.target as HTMLSelectElement).value || undefined; changed(); } },
    h('option', { value: '' }, '—'), ...S.project.sections.map((s) => h('option', { value: s.id, selected: d.sectionId === s.id }, `${s.letter} ${s.title}`)))) : null,
  h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: d.core, disabled: d.type === 'transcript', 'aria-label': 'Core bundle', dataset: { key: `core-${d.id}` }, onchange: (e: Event) => { d.core = (e.target as HTMLInputElement).checked; changed({ docs: false }); } })),
  h('td', { class: 'num' }, String(docPages(d))),
  h('td', { class: 'actions' },
    h('button', { class: 'btn ghost small', title: 'Attach a typed copy of an illegible page (PD 5.6 para 6)', onclick: () => askTyped(d) }, 'Typed copy…'),
    h('button', {
      class: 'btn ghost small', 'aria-label': `Remove "${d.description}"`, disabled: frozen && frozenIds.has(d.id),
      title: frozen && frozenIds.has(d.id) ? 'Issued documents cannot be removed without re-issuing' : 'Remove',
      onclick: () => { S.project.docs = S.project.docs.filter((x) => x.id !== d.id); S.project.files = S.project.files.filter((f2) => f2.id !== d.fileId || S.project.docs.some((x) => x.fileId === f2.id)); changed(); announce(`Removed "${d.description}".`); },
    }, 'Remove')));
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
      ' ', h('button', { class: 'btn ghost small', onclick: async () => { if (await confirmDialog('Unlock page numbers?', ['The whole bundle will be renumbered on the next build. Only do this if you will re-issue and re-lodge the bundle.'], 'Unlock')) { S.project = unfreezeProject(S.project); changed(); renderAll(); } } }, 'Unlock…')) : null,
    missing.length ? h('div', { class: 'notice warn' }, h('strong', null, 'Add these files again to continue: '), missing.map((f) => f.name).join(', '),
      h('span', { class: 'hint' }, ' They are recognised by content, so the file names can differ. If a file has changed, it will be added as a new document instead.')) : null,
    drop,
    S.fileErrors.length ? h('div', { class: 'notice bad', role: 'alert' },
      h('ul', null, ...S.fileErrors.map((e) => h('li', null, e.message))),
      h('button', { class: 'btn ghost small', onclick: () => { S.fileErrors = []; renderDocs(); } }, 'Dismiss')) : null,
    p.docs.length ? h('div', { class: 'toolbar' },
      h('button', { class: 'btn small', onclick: sortByDate, disabled: isFrozen() }, 'Sort by date'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.settings.sectionsEnabled, onchange: (e: Event) => { p.settings.sectionsEnabled = (e.target as HTMLInputElement).checked; if (p.settings.sectionsEnabled && !p.sections.length) p.sections.push({ id: uid('s'), letter: 'A', title: 'Pleadings' }); changed(); renderSettings(); } }), 'Use sections'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.reorder === 'arrows', onchange: (e: Event) => { S.reorder = (e.target as HTMLInputElement).checked ? 'arrows' : 'drag'; renderDocs(); } }), 'Show move buttons'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, `${p.docs.length} document(s), ${total} page(s)`),
      h('button', { class: 'btn ghost small', disabled: isFrozen(), onclick: async () => { if (await confirmDialog('Remove all documents?', ['This removes every document from the list.'], 'Remove all')) { p.docs = []; p.files = []; changed(); } } }, 'Clear all')) : null,
    p.settings.sectionsEnabled ? renderSections() : null,
    p.docs.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'docs' },
      h('thead', null, h('tr', null,
        h('th', null, h('span', { class: 'sr' }, 'Reorder')), h('th', null, 'No.'), h('th', null, 'Date'), h('th', null, 'Description'),
        h('th', null, 'Type'), h('th', null, 'Status'), p.settings.sectionsEnabled ? h('th', null, 'Section') : null,
        h('th', null, 'Core'), h('th', null, 'Pages'), h('th', null, h('span', { class: 'sr' }, 'Actions')))),
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
      h('input', { type: 'text', class: 'short', value: s.letter, 'aria-label': 'Section letter', dataset: { key: `sl-${s.id}` }, onchange: (e: Event) => { s.letter = (e.target as HTMLInputElement).value.trim() || s.letter; changed(); } }),
      h('input', { type: 'text', value: s.title, 'aria-label': 'Section title', dataset: { key: `stt-${s.id}` }, onchange: (e: Event) => { s.title = (e.target as HTMLInputElement).value; changed(); } }),
      h('button', { class: 'btn ghost small', 'aria-label': `Remove section ${s.letter}`, onclick: () => { p.sections.splice(i, 1); p.docs.forEach((d) => { if (d.sectionId === s.id) delete d.sectionId; }); changed(); } }, '×'))),
    h('button', { class: 'btn small', onclick: () => { p.sections.push({ id: uid('s'), letter: String.fromCharCode(65 + p.sections.length), title: '' }); changed(); } }, 'Add section'));
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
    h('details', null, h('summary', null, h('h2', null, h('span', { class: 'step' }, '3'), 'Settings ', h('span', { class: 'muted small' }, '(defaults follow PD 5.6)'))),
      h('div', { class: 'grid3' },
        h('fieldset', null, h('legend', null, 'Volumes and numbering'),
          field('Pages per file', h('input', { type: 'number', min: 20, max: 1000, value: s.maxPagesPerVolume, onchange: (e: Event) => { s.maxPagesPerVolume = Math.max(20, Number((e.target as HTMLInputElement).value) || 250); changed({ docs: false }); } }), 'PD 5.6 para 5: never more than 250.'),
          sel('Numbering', s.numbering, [['continuous', 'Consecutive across all files (1, 2, 3…)'], ['per-volume', 'Restart each file (A1, B1…)'], ['per-section', 'Restart each section (A1, B1…)']], (v) => { s.numbering = v; }),
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
          chk('Table borders', s.index.borders, (v) => { s.index.borders = v; }))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { localStorage.setItem(LS.defaults, JSON.stringify(s)); announce('Saved as your defaults on this device.'); } }, 'Save as my defaults'),
        h('button', { class: 'btn ghost small', onclick: () => { localStorage.removeItem(LS.defaults); announce('Saved defaults erased.'); } }, 'Erase saved defaults'),
        h('button', { class: 'btn ghost small', onclick: () => { S.project.settings = structuredClone(DEFAULT_SETTINGS); renderSettings(); changed(); } }, 'Reset to PD 5.6 defaults'))));
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
  replace($('build'),
    h('h2', null, h('span', { class: 'step' }, '4'), 'Build'),
    S.planError ? h('div', { class: 'notice bad', role: 'alert' }, S.planError) : null,
    plan ? h('div', { class: 'plan' },
      h('p', null, h('strong', null, `${plan.physicalFiles} file${plan.physicalFiles > 1 ? 's' : ''}: `),
        plan.volumes.map((v) => `${v.name} (pp. ${v.first}–${v.last}, ${v.pages} sheets)`).join('; '), '.')) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn', disabled: !ready || !!S.job, onclick: () => runBuild({ prelimsOnly: true }) }, 'Preview index'),
      h('button', { class: 'btn primary', disabled: !ready || !!S.job, onclick: () => runBuild() }, 'Build bundle'),
      h('button', { class: 'btn', disabled: !ready || !!S.job, onclick: () => runBuild({ issue: true }), title: 'Build and lock the page numbers for later 88-1 inserts' }, isFrozen() ? 'Build and re-issue' : 'Build and issue…')),
    S.job ? h('div', { class: 'job', role: 'status' },
      h('progress', { id: 'progress', max: S.job.total, value: S.job.done }),
      h('span', { id: 'progress-label' }, `${S.job.label}…`),
      h('button', { class: 'btn small', onclick: () => worker.postMessage({ type: 'cancel' } satisfies ToWorker) }, 'Cancel')) : null,
    S.results ? h('div', { class: 'results' },
      h('h3', null, S.results.preview ? 'Index preview' : 'Your bundle'),
      h('ul', { class: 'files' }, ...S.results.files.map((f) => h('li', null,
        h('a', { href: f.url, download: f.fileName }, f.fileName), h('span', { class: 'muted' }, ` ${f.pageCount} pages, ${kb(f.size)}`),
        ' ', h('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'small' }, 'Open')))),
      !S.results.preview ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => S.results!.files.forEach((f, i) => setTimeout(() => { const a = h('a', { href: f.url, download: f.fileName }); a.click(); }, i * 400)) }, 'Download all'),
        h('button', { class: 'btn small', onclick: saveProject }, 'Save project file'),
        h('span', { class: 'muted small' }, 'A single ZIP with the Word index, labels and compliance report is coming next.')) : null) : null,
    resultWarnings.length ? h('div', { class: 'checks' },
      h('h3', null, `Checks (${resultWarnings.length})`),
      h('ul', null, ...resultWarnings.map((w) => h('li', { class: sevCodes.has(w.code) ? 'warn' : '' }, w.message)))) : null);
  updateProgress();
}

// ---------------------------------------------------------------- footer, autosave prompt

function renderFooter() {
  const on = localStorage.getItem(LS.autosave) === '1';
  replace($('remember'),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: on, onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) { localStorage.setItem(LS.autosave, '1'); autosave(); }
        else { localStorage.removeItem(LS.autosave); localStorage.removeItem(LS.project); }
        announce('Saved.');
      },
    }), 'Remember project details in this browser'),
    h('span', { class: 'hint' }, ' Stores only the list, dates, descriptions and settings on this device, never document contents. Untick to erase.'));
}

function offerRestore() {
  const saved = localStorage.getItem(LS.autosave) === '1' ? localStorage.getItem(LS.project) : null;
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

(document.getElementById('logo') as HTMLImageElement).src = logoUrl;
// Keep a dropped file from opening in the tab if it misses the drop zone.
window.addEventListener('dragover', (e) => { if (!dragId) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (!dragId) e.preventDefault(); });
renderAll();
offerRestore();

