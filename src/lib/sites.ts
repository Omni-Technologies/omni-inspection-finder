import { haversineMiles } from './address.ts';
import type { GeoPoint } from './geocode.ts';
import { compareDue, daysUntil, startOfToday, urgencyOf, type Inspection, type Urgency } from './inspections.ts';

/** One map pin: every inspection that shares a street address. */
export type Site = {
  key: string;
  address: string;
  query: string;
  inspections: Inspection[];
};

export type PlacedSite = Site & { point: GeoPoint };

export type DueWindow = 'all' | 'overdue' | '30' | '60' | '90' | '180';

export type Filters = {
  due: DueWindow;
  hideScheduled: boolean;
};

export const DEFAULT_FILTERS: Filters = { due: 'all', hideScheduled: false };

export function groupSites(inspections: Inspection[]): Site[] {
  const map = new Map<string, Site>();
  for (const insp of inspections) {
    let site = map.get(insp.siteKey);
    if (!site) {
      site = { key: insp.siteKey, address: insp.address, query: insp.geocodeQuery, inspections: [] };
      map.set(insp.siteKey, site);
    }
    site.inspections.push(insp);
  }
  for (const site of map.values()) site.inspections.sort(compareDue);
  return [...map.values()];
}

export function passesFilters(insp: Inspection, filters: Filters, today = startOfToday()): boolean {
  if (filters.hideScheduled && insp.scheduled) return false;
  if (filters.due === 'all') return true;
  if (!insp.due) return false;
  const days = daysUntil(insp.due, today);
  if (filters.due === 'overdue') return days < 0;
  return days <= Number(filters.due);
}

export function visibleInspections(site: Site, filters: Filters, today = startOfToday()): Inspection[] {
  return site.inspections.filter((i) => passesFilters(i, filters, today));
}

/** The inspection a pin represents: the soonest due date at the site, scheduled or not. */
export function leadInspection(list: Inspection[]): Inspection | undefined {
  return leadFirst(list)[0];
}

/** Soonest due first, so lists and pins agree on what a site represents. */
export function leadFirst(list: Inspection[]): Inspection[] {
  return [...list].sort(compareDue);
}

/** The soonest inspection at a site that still needs scheduling. */
export function firstUnscheduled(list: Inspection[]): Inspection | undefined {
  return leadFirst(list).find((i) => !i.scheduled);
}

export function siteUrgency(list: Inspection[], today = startOfToday()): Urgency {
  const lead = leadInspection(list);
  return lead ? urgencyOf(lead, today) : 'none';
}

export type Neighbour = { site: PlacedSite; miles: number; list: Inspection[] };

export function nearbySites(
  origin: PlacedSite,
  sites: PlacedSite[],
  radiusMiles: number,
  filters: Filters,
  today = startOfToday(),
): Neighbour[] {
  const out: Neighbour[] = [];
  for (const site of sites) {
    if (site.key === origin.key) continue;
    const miles = haversineMiles(origin.point, site.point);
    if (miles > radiusMiles) continue;
    const list = leadFirst(visibleInspections(site, filters, today));
    if (list.length) out.push({ site, miles, list });
  }
  return out.sort((a, b) => a.miles - b.miles);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export type SearchHit = { site: Site; inspection: Inspection; score: number };

/** Company / client / address / project-number search, best matches first. */
export function searchInspections(sites: Site[], query: string, limit = 12): SearchHit[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ');
  const hits: SearchHit[] = [];
  for (const site of sites) {
    for (const insp of site.inspections) {
      const title = norm(insp.title);
      const client = norm(insp.client);
      const hay = `${title} ${client} ${norm(insp.address)} ${norm(insp.projectNumber)}`;
      if (!words.every((w) => hay.includes(w))) continue;
      let score = 1;
      if (title.startsWith(q) || client.startsWith(q)) score = 4;
      else if (title.includes(q) || client.includes(q)) score = 3;
      else if (words.every((w) => title.includes(w) || client.includes(w))) score = 2;
      hits.push({ site, inspection: insp, score });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || compareDue(a.inspection, b.inspection) || a.inspection.title.localeCompare(b.inspection.title))
    .slice(0, limit);
}
