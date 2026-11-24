// Big Bundle Wright: PD 5.6 para 8 lodging deadline.
// SPDX-License-Identifier: MPL-2.0
//
// "at least 72 hours before the date fixed for the hearing (excluding Saturdays,
// Sundays and general holidays)". Decision (stage 1, Q7): count back from 00:00 on
// the hearing date, skipping whole excluded days. Three counted days back gives
// 00:00 on the 3rd working day before the hearing, so in practice the bundle must
// be lodged by close of business on the 4th working day before.

import holidayData from '../data/hk-general-holidays.json' with { type: 'json' };

export interface HolidayData {
  source: string;
  fetched: string;
  coverage: { from: string; to: string };
  holidays: { date: string; name: string }[];
}

export interface DeadlineResult {
  hearingDate: string;
  /** Lodge before 00:00 on this date (start of the 3rd working day before). */
  cutoffDate: string;
  /** Last working day on which lodging is in time ("by close of business"). */
  lastLodgingDay: string;
  /** Days skipped while counting back, with reasons. */
  excluded: { date: string; reason: string }[];
  source: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function lodgingDeadline(hearingDate: string, data: HolidayData = holidayData as HolidayData): DeadlineResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hearingDate)) throw new Error(`Hearing date must be YYYY-MM-DD, got "${hearingDate}".`);
  const hol = new Map(data.holidays.map((h) => [h.date, h.name]));
  const excludedReason = (d: string) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 6) return 'Saturday';
    if (dow === 0) return 'Sunday';
    return hol.get(d) ? `General holiday: ${hol.get(d)}` : null;
  };
  const inCoverage = (d: string) => d >= data.coverage.from && d <= data.coverage.to;
  const excluded: DeadlineResult['excluded'] = [];
  let day = hearingDate;
  let counted = 0;
  // Count three whole working days back from 00:00 on the hearing date…
  while (counted < 3) {
    day = addDays(day, -1);
    if (!inCoverage(day)) throw new Error(`No Hong Kong general holiday data for ${day}; holiday data covers ${data.coverage.from} to ${data.coverage.to}.`);
    const r = excludedReason(day);
    if (r) excluded.push({ date: day, reason: r }); else counted++;
  }
  const cutoffDate = day;
  // …then the last working day before the cut-off is the last day to lodge.
  let last = cutoffDate;
  do {
    last = addDays(last, -1);
    if (!inCoverage(last)) throw new Error(`No Hong Kong general holiday data for ${last}; holiday data covers ${data.coverage.from} to ${data.coverage.to}.`);
  } while (excludedReason(last));
  return { hearingDate, cutoffDate, lastLodgingDay: last, excluded, source: data.source };
}

export function describeDeadline(r: DeadlineResult): string {
  const fmt = (s: string) => {
    const [y, m, d] = s.split('-');
    return `${DOW[new Date(`${s}T00:00:00Z`).getUTCDay()]} ${d}/${m}/${y}`;
  };
  return `Lodge by close of business on ${fmt(r.lastLodgingDay)} (the 72 hours run out at 00:00 on ${fmt(r.cutoffDate)}).`;
}
