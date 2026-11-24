// Big Bundle Wright: Chinese (Traditional) headings for bilingual output
// (settings.bilingualHeadings). Conservative Hong Kong court usage. Only fixed
// headings are translated; case details and descriptions are the user's own text.
// SPDX-License-Identifier: MPL-2.0

import type { BundleKind, DocStatus } from './model.ts';
import type { IndexColumn } from './layout-index.ts';

export const ZH = {
  index: '索引',
  masterIndex: '總索引',
  statusOfDocuments: '文件狀況（實務指示5.6第3段）',
  /** Bundle names. */
  bundle: '文件冊',
  coreBundle: '核心文件冊',
  transcriptBundle: '謄本文件冊',
  /** "Bundles A–C". */
  bundles: '文件冊',
  none: '無',
  /** Column titles, keyed by the English title. */
  columns: {
    'No.': '編號',
    'Date': '日期',
    'Description': '文件描述',
    'Status': '狀況',
    'Page(s)': '頁碼',
    'Bundle': '文件冊',
    'Main bundle': '主文件冊',
    'Documents': '文件',
  } as Record<string, string>,
  /** Short status labels for the index column. */
  status: {
    authentic: '真實',
    inclusion_only: '僅供納入',
    evidence_of_contents: '內容可作證據',
  } satisfies Record<DocStatus, string>,
  /** Status categories on the PD 5.6 para 3 front sheet. */
  statusFront: {
    authentic: '(1) 當作真實（第27號命令第4條規則）或同意為真實',
    inclusion_only: '(2) 僅同意納入文件冊',
    evidence_of_contents: '(3) 亦同意作為其內容的證據，惟須視乎其分量',
  } satisfies Record<DocStatus, string>,
  statusLegend:
    '文件狀況（實務指示5.6第3段；《高等法院規則》第27號命令第4條規則）：'
    + '「真實」指根據第27號命令第4條規則當作真實或同意為真實的文件；'
    + '「僅供納入」指只同意納入文件冊的文件；'
    + '「內容可作證據」指亦同意可接納為其內容的證據的文件，惟須就其分量作出陳詞。',
  frontLegend:
    '按實務指示5.6第3段標示。第(3)類文件已同意作為其內容的證據；'
    + '任何一方仍可以不相關為理由，保留反對接納該等文件的權利。',
} as const;

/** "第1至248頁" / "第5頁". */
export function zhPages(range: string): string {
  return `第${range.replace('–', '至')}頁`;
}

/** Chinese bundle name: "文件冊A", "核心文件冊", "謄本文件冊B". */
export function zhBundleName(kind: BundleKind, letter: string, name: string): string {
  if (kind === 'main') return `${ZH.bundle}${letter}`;
  const base = kind === 'core' ? ZH.coreBundle : ZH.transcriptBundle;
  return name.endsWith(` ${letter}`) ? `${base}${letter}` : base;
}

/** "English\n中文" when bilingual, else English. */
export const bi = (on: boolean, en: string, zh: string | undefined) => (on && zh ? `${en}\n${zh}` : en);

export function biColumns(cols: IndexColumn[], on: boolean): IndexColumn[] {
  return on ? cols.map((c) => ({ ...c, title: bi(true, c.title, ZH.columns[c.title]) })) : cols;
}
