import { parseCsv } from './csv.ts';
import { addressForGeocoding, flattenAddress, normalizeAddressKey, parseAddressParts } from './address.ts';

export type Inspection = {
  id: string;
  title: string;
  client: string;
  systemType: string;
  frequency: string;
  progress: string;
  due: Date | null;
  dueRaw: string;
  scheduledDate: Date | null;
  scheduled: boolean;
  projectNumber: string;
  quotedHours: string;
  techs: string;
  preferredInspector: string;
  panelType: string;
  lastInspection: string;
  contractEnd: string;
  notes: string;
  address: string;
  contact: string;
  email: string;
  /** Groups inspections at the same street address onto one map pin. */
  siteKey: string;
  /** Cleaned single-line address sent to the geocoder. */
  geocodeQuery: string;
};

export type ParseResult = {
  inspections: Inspection[];
  missingColumns: string[];
  rowCount: number;
};

/** Microsoft Lists headers, matched case/space-insensitively, with "%23" decoded to "#". */
const COLUMNS = {
  title: ['title'],
  client: ['client name', 'client'],
  systemType: ['system type'],
  frequency: ['frequency'],
  progress: ['progress', 'status'],
  due: ['due date', 'due'],
  scheduledDate: ['scheduled date'],
  scheduledFlag: ['scheduled?', 'scheduled'],
  projectNumber: ['current project number', 'project number', 'project #'],
  quotedHours: ['quoted hours'],
  techs: ['# of techs required', 'techs required'],
  preferredInspector: ['preferred inspector'],
  panelType: ['panel type'],
  lastInspection: ['date of last inspection completed', 'last inspection'],
  contractEnd: ['contract end date/re-quote', 'contract end date'],
  notes: ['notes'],
  address: ['address', 'site address'],
  contact: ['contact name & number', 'contact'],
  email: ['contact (s) email', 'contact(s) email', 'contact email', 'email'],
} as const;

type ColumnKey = keyof typeof COLUMNS;
const REQUIRED: ColumnKey[] = ['title', 'due', 'address'];

function normHeader(h: string): string {
  let decoded = h;
  try {
    decoded = decodeURIComponent(h);
  } catch {
    decoded = h.replace(/%23/g, '#');
  }
  return decoded.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Parses M/D/YYYY (Lists export), YYYY-MM-DD, and M/D/YY into a local-midnight Date. */
export function parseDate(value: string): Date | null {
  const v = value.trim();
  if (!v) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(v);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return validDate(year, Number(m[1]), Number(m[2]));
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(v);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function validDate(y: number, mo: number, d: number): Date | null {
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

function isScheduled(progress: string, flag: string, scheduledDate: Date | null): boolean {
  if (/^\s*scheduled\b/i.test(progress)) return true;
  if (/yes/i.test(flag)) return true;
  return scheduledDate !== null;
}

export function parseInspections(text: string): ParseResult {
  const rows = parseCsv(text);
  if (!rows.length) return { inspections: [], missingColumns: [...REQUIRED], rowCount: 0 };
  const headers = rows[0].map(normHeader);
  const index = {} as Record<ColumnKey, number>;
  for (const key of Object.keys(COLUMNS) as ColumnKey[]) {
    index[key] = headers.findIndex((h) => (COLUMNS[key] as readonly string[]).includes(h));
  }
  const missingColumns = REQUIRED.filter((k) => index[k] < 0).map((k) => COLUMNS[k][0]);

  const inspections: Inspection[] = [];
  rows.slice(1).forEach((row, i) => {
    const get = (key: ColumnKey) => (index[key] >= 0 ? (row[index[key]] ?? '').trim() : '');
    const rawAddress = index.address >= 0 ? row[index.address] ?? '' : '';
    const title = get('title') || get('client');
    if (!title && !rawAddress.trim()) return;
    const parts = parseAddressParts(rawAddress);
    const geocodeQuery = rawAddress.trim() ? addressForGeocoding(rawAddress, parts) : '';
    const dueRaw = get('due');
    const scheduledDate = parseDate(get('scheduledDate'));
    const projectNumber = get('projectNumber');
    inspections.push({
      id: `${i + 2}:${projectNumber}`,
      title,
      client: get('client'),
      systemType: get('systemType'),
      frequency: get('frequency'),
      progress: get('progress'),
      due: parseDate(dueRaw),
      dueRaw,
      scheduledDate,
      scheduled: isScheduled(get('progress'), get('scheduledFlag'), scheduledDate),
      projectNumber,
      quotedHours: get('quotedHours'),
      techs: get('techs'),
      preferredInspector: get('preferredInspector'),
      panelType: get('panelType'),
      lastInspection: get('lastInspection'),
      contractEnd: get('contractEnd'),
      notes: get('notes'),
      address: flattenAddress(rawAddress),
      contact: get('contact'),
      email: get('email'),
      siteKey: geocodeQuery ? normalizeAddressKey(geocodeQuery) : `no-address:${i}`,
      geocodeQuery,
    });
  });
  return { inspections, missingColumns, rowCount: rows.length - 1 };
}

export type Urgency = 'overdue' | 'soon' | 'upcoming' | 'later' | 'scheduled' | 'none';

export const URGENCY_LABEL: Record<Urgency, string> = {
  overdue: 'Past due',
  soon: 'Due in 30 days',
  upcoming: 'Due in 31–90 days',
  later: 'Due later',
  scheduled: 'Scheduled',
  none: 'No due date',
};

const DAY = 86_400_000;

export function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function daysUntil(date: Date, today = startOfToday()): number {
  return Math.round((date.getTime() - today.getTime()) / DAY);
}

export function urgencyOf(insp: Pick<Inspection, 'due' | 'scheduled'>, today = startOfToday()): Urgency {
  if (insp.scheduled) return 'scheduled';
  if (!insp.due) return 'none';
  const days = daysUntil(insp.due, today);
  if (days < 0) return 'overdue';
  if (days <= 30) return 'soon';
  if (days <= 90) return 'upcoming';
  return 'later';
}

export function formatDate(date: Date | null, style: 'short' | 'long' = 'long'): string {
  if (!date) return '—';
  if (style === 'short') return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)}`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function relativeDue(date: Date | null, today = startOfToday()): string {
  if (!date) return 'no due date';
  const days = daysUntil(date, today);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days > 0) return `due in ${days} days`;
  if (days === -1) return '1 day past due';
  return `${-days} days past due`;
}

/** Earliest-due-first, with no-date records last. */
export function compareDue(a: Pick<Inspection, 'due'>, b: Pick<Inspection, 'due'>): number {
  const at = a.due ? a.due.getTime() : Number.POSITIVE_INFINITY;
  const bt = b.due ? b.due.getTime() : Number.POSITIVE_INFINITY;
  return at - bt;
}
