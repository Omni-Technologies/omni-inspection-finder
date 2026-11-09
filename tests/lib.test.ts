import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/lib/csv.ts';
import { parseAddressParts, simplifyStreet, addressForGeocoding, normalizeAddressKey } from '../src/lib/address.ts';
import { parseInspections, parseDate, urgencyOf, relativeDue } from '../src/lib/inspections.ts';
import { groupSites, nearbySites, passesFilters, searchInspections, leadInspection, type PlacedSite } from '../src/lib/sites.ts';

// Synthetic export shaped like the Microsoft Lists "I&T Master" CSV (no real customer data).
const HEADER =
  'Title,Client Name,System Type,Frequency,Proposal Status,Progress,Due date,Scheduled Date,Scheduled?,Actual Hours,Quoted Hours,Current Project Number,Parent Project Number ,%23 of Techs Required,Notes,Address,Contact Name & Number,Contact (s) Email';
const CSV =
  '﻿' +
  [
    HEADER,
    'Alpha Clinic ,Alpha Health Inc.,Fire Alarm,Annual,Accepted,Not Started,1/15/2026,,,0,6,25-0001,,2,"Line one\nLine two",100 Main St. Waunakee WI 53597,"Pat / T: 555-0100",pat@example.com',
    'Bravo Plant,Bravo Co,Fire Alarm,Semi-Annual,Accepted,Scheduled - In D-tools,12/1/2026,12/3/2026,"[""Yes""]",0,4,25-0002,24-0002 ,1,,"200 Oak Ave, Sun Prairie, WI 53590\n",Lee,lee@example.com',
    'Bravo Annex,Bravo Co,Nurse Call,Annual,Accepted,Not Started,3/1/2027,,,0,2,25-0003,,0,,"200 Oak Ave, Sun Prairie, WI 53590",Lee,lee@example.com',
    'Charlie School,Charlie District,Fire Alarm,Annual,Accepted,Not Started,,,,0,8,25-0004,,0,,"1600-1610 & 1700-1704 Valley Dr. Janesville WI 53545",Kim,kim@example.com',
  ].join('\r\n') +
  '\r\n';

const TODAY = new Date(2026, 10, 9); // Nov 9 2026

test('parseCsv handles BOM, CRLF, quoted newlines and doubled quotes', () => {
  const rows = parseCsv('﻿a,b\r\n"x\ny","say ""hi"""\r\n\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x\ny', 'say "hi"']]);
});

test('a quote inside an unquoted field is literal text, not the start of a quoted field', () => {
  assert.deepEqual(parseCsv('a,5" pipe,c\nd,e,f\n'), [['a', '5" pipe', 'c'], ['d', 'e', 'f']]);
});

test('only a Progress value that starts with "Scheduled" counts as scheduled', () => {
  const row = (progress: string) =>
    parseInspections(`Title,Progress,Due date,Address\nX,${progress},1/1/2027,1 Main St Madison WI 53703\n`).inspections[0].scheduled;
  assert.equal(row('Scheduled - In D-tools'), true);
  assert.equal(row('Not Scheduled'), false);
  assert.equal(row('Not Started'), false);
});

test('parseInspections maps Lists columns including %23 and trailing-space headers', () => {
  const { inspections, missingColumns, rowCount } = parseInspections(CSV);
  assert.equal(rowCount, 4);
  assert.deepEqual(missingColumns, []);
  assert.equal(inspections.length, 4);
  const a = inspections[0];
  assert.equal(a.title, 'Alpha Clinic');
  assert.equal(a.client, 'Alpha Health Inc.');
  assert.equal(a.techs, '2');
  assert.equal(a.notes, 'Line one\nLine two');
  assert.equal(a.due?.getTime(), new Date(2026, 0, 15).getTime());
  assert.equal(a.scheduled, false);
  assert.equal(inspections[1].scheduled, true);
  assert.equal(inspections[1].address, '200 Oak Ave, Sun Prairie, WI 53590');
  assert.equal(inspections[3].due, null);
});

test('missing required columns are reported', () => {
  assert.deepEqual(parseInspections('Name,Thing\nx,y\n').missingColumns, ['title', 'due date', 'address']);
});

test('parseDate accepts Lists, ISO and two-digit-year forms and rejects junk', () => {
  assert.equal(parseDate('3/25/2026')?.getTime(), new Date(2026, 2, 25).getTime());
  assert.equal(parseDate('2026-03-25')?.getTime(), new Date(2026, 2, 25).getTime());
  assert.equal(parseDate('3/25/26')?.getTime(), new Date(2026, 2, 25).getTime());
  assert.equal(parseDate('2/30/2026'), null);
  assert.equal(parseDate('TBD'), null);
});

test('parseAddressParts splits unpunctuated, multi-line and prepositional addresses', () => {
  assert.deepEqual(parseAddressParts('100 Main St. Waunakee WI 53597'), { street: '100 Main St.', city: 'Waunakee', state: 'WI', zip: '53597' });
  assert.deepEqual(parseAddressParts('100 26th St.Prairie Du Sac, WI 53578  \n'), { street: '100 26th St.', city: 'Prairie Du Sac', state: 'WI', zip: '53578' });
  assert.deepEqual(parseAddressParts('2850 Example Avenue in Sun Prairie, WI 53590'), { street: '2850 Example Avenue', city: 'Sun Prairie', state: 'WI', zip: '53590' });
  assert.equal(parseAddressParts('5 Elm Rd, Somewhere Else, WI 53000').city, 'Somewhere Else');
  assert.equal(parseAddressParts('10 Dr Way Madison 53703').state, 'WI');
});

test('simplifyStreet keeps the first number of a campus range', () => {
  assert.equal(simplifyStreet('1600-1610 & 1700-1704 Valley Dr.'), '1600 Valley Dr.');
  assert.equal(simplifyStreet('W123 S4567 Example Rd.'), 'W123 S4567 Example Rd.');
  assert.equal(addressForGeocoding('1600-1610 & 1700-1704 Valley Dr. Janesville WI 53545'), '1600 Valley Dr., Janesville, WI, 53545');
});

test('same address with different formatting groups onto one site', () => {
  const sites = groupSites(parseInspections(CSV).inspections);
  assert.equal(sites.length, 3);
  const bravo = sites.find((s) => s.inspections.length === 2);
  assert.ok(bravo);
  assert.equal(normalizeAddressKey('200 Oak Ave., Sun Prairie WI 53590'), normalizeAddressKey('200 Oak Ave, Sun Prairie, WI, 53590'));
  // The unscheduled inspection leads the pin even though the scheduled one is due first.
  assert.equal(leadInspection(bravo.inspections)?.title, 'Bravo Annex');
});

test('urgency bands and due filters', () => {
  const due = (d: Date | null, scheduled = false) => ({ due: d, scheduled });
  assert.equal(urgencyOf(due(new Date(2026, 10, 1)), TODAY), 'overdue');
  assert.equal(urgencyOf(due(new Date(2026, 11, 9)), TODAY), 'soon');
  assert.equal(urgencyOf(due(new Date(2027, 0, 30)), TODAY), 'upcoming');
  assert.equal(urgencyOf(due(new Date(2027, 5, 1)), TODAY), 'later');
  assert.equal(urgencyOf(due(new Date(2026, 10, 1), true), TODAY), 'scheduled');
  assert.equal(urgencyOf(due(null), TODAY), 'none');
  assert.equal(relativeDue(new Date(2026, 10, 7), TODAY), '2 days past due');

  const [a, b, , d] = parseInspections(CSV).inspections;
  assert.equal(passesFilters(a, { due: 'overdue', hideScheduled: false }, TODAY), true);
  assert.equal(passesFilters(a, { due: '30', hideScheduled: false }, TODAY), true, 'past due counts as due within 30 days');
  assert.equal(passesFilters(b, { due: 'all', hideScheduled: true }, TODAY), false);
  assert.equal(passesFilters(d, { due: '90', hideScheduled: false }, TODAY), false, 'no due date never matches a window');
  assert.equal(passesFilters(d, { due: 'all', hideScheduled: false }, TODAY), true);
});

test('nearbySites respects radius and filters, nearest first', () => {
  const sites = groupSites(parseInspections(CSV).inspections);
  const pt = (lat: number, lon: number) => ({ lat, lon, source: 'census' as const, approx: false, matched: '', at: 0 });
  const placed: PlacedSite[] = [
    { ...sites[0], point: pt(43.19, -89.45) },
    { ...sites[1], point: pt(43.18, -89.24) }, // ~10.5 mi east
    { ...sites[2], point: pt(42.68, -89.02) }, // ~43 mi south-east
  ];
  const all = nearbySites(placed[0], placed, 50, { due: 'all', hideScheduled: false }, TODAY);
  assert.deepEqual(all.map((n) => n.site.key), [placed[1].key, placed[2].key]);
  assert.ok(all[0].miles > 9 && all[0].miles < 12);
  assert.equal(nearbySites(placed[0], placed, 5, { due: 'all', hideScheduled: false }, TODAY).length, 0);
  const unscheduled = nearbySites(placed[0], placed, 50, { due: 'all', hideScheduled: true }, TODAY);
  assert.equal(unscheduled[0].list.length, 1);
});

test('search finds by company, client, address and project number', () => {
  const sites = groupSites(parseInspections(CSV).inspections);
  assert.equal(searchInspections(sites, 'alpha')[0].inspection.title, 'Alpha Clinic');
  assert.equal(searchInspections(sites, 'bravo').length, 2);
  assert.equal(searchInspections(sites, 'valley dr')[0].inspection.title, 'Charlie School');
  assert.equal(searchInspections(sites, '25-0002')[0].inspection.title, 'Bravo Plant');
  assert.equal(searchInspections(sites, 'charlie district')[0].inspection.title, 'Charlie School');
  assert.equal(searchInspections(sites, 'zzz').length, 0);
});

test('streetName strips house and grid numbers but keeps numbered streets', async () => {
  const { streetName } = await import('../src/lib/geocode.ts');
  assert.equal(streetName('W123 S4567 S. Example Rd.'), 'S. Example Rd.');
  assert.equal(streetName('500 County Hwy M'), 'County Hwy M');
  assert.equal(streetName('100 26th St.'), '26th St.');
  assert.equal(streetName('1600-1610 & 1700-1704 Valley Dr.'), 'Valley Dr.');
  assert.equal(streetName('12'), '');
});
