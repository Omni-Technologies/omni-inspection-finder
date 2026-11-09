/**
 * In-browser geocoding with no API key and no server.
 *
 * 1. US Census Geocoder (JSONP; it sends no CORS headers, so fetch() is not an option)
 * 2. OpenStreetMap Nominatim, free-form then structured (CORS, max 1 request/second)
 * 3. Nominatim street (checked against the town) or town/ZIP centre, flagged as
 *    approximate so the user can move the pin
 *
 * Results are cached in localStorage so each address is looked up once per browser.
 */
import { haversineMiles, parseAddressParts, simplifyStreet } from './address.ts';

export type GeoSource = 'census' | 'osm' | 'street' | 'area' | 'manual';

export type GeoPoint = {
  lat: number;
  lon: number;
  source: GeoSource;
  /** True when the pin is only on the right street ('street') or the town/ZIP centre ('area'). */
  approx: boolean;
  matched: string;
  at: number;
};

export type GeoCache = Record<string, GeoPoint>;

const CACHE_KEY = 'oif.geocache.v1';
const PINS_KEY = 'oif.pins.v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the session still works, it just won't remember */
  }
}

export const loadGeoCache = (): GeoCache => readJson<GeoCache>(CACHE_KEY, {});
export const saveGeoCache = (cache: GeoCache): void => writeJson(CACHE_KEY, cache);
/** Pins the user placed by hand; these always win over geocoder results. */
export const loadManualPins = (): GeoCache => readJson<GeoCache>(PINS_KEY, {});
export const saveManualPins = (pins: GeoCache): void => writeJson(PINS_KEY, pins);

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

let jsonpSeq = 0;

function jsonp<T>(url: string, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const name = `__oifCensus${Date.now().toString(36)}${jsonpSeq++}`;
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const cleanup = () => {
      clearTimeout(timer);
      delete w[name];
      script.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      // The script may still arrive; give it something harmless to call.
      w[name] = () => undefined;
      setTimeout(() => delete w[name], 60000);
      reject(new Error('timed out'));
    }, timeoutMs);
    w[name] = (data: T) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('request failed'));
    };
    script.src = `${url}&format=jsonp&callback=${name}`;
    document.head.appendChild(script);
  });
}

type CensusPayload = {
  result?: { addressMatches?: { matchedAddress: string; coordinates: { x: number; y: number } }[] };
};

async function census(query: string): Promise<GeoPoint | null> {
  const url = `${CENSUS}?address=${encodeURIComponent(query)}&benchmark=Public_AR_Current`;
  const payload = await jsonp<CensusPayload>(url);
  const best = payload.result?.addressMatches?.[0];
  if (!best) return null;
  return { lat: best.coordinates.y, lon: best.coordinates.x, source: 'census', approx: false, matched: best.matchedAddress, at: Date.now() };
}

type NominatimHit = { lat: string; lon: string; display_name: string };

let nominatimChain: Promise<unknown> = Promise.resolve();
let lastNominatim = 0;

/** Serialised so the whole app never exceeds Nominatim's 1 request/second policy. */
function nominatimQueued(params: Record<string, string>): Promise<NominatimHit[]> {
  const run = async () => {
    const wait = 1100 - (Date.now() - lastNominatim);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
    const qs = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'us', ...params });
    const res = await fetch(`${NOMINATIM}?${qs.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    // Rate-limited or refused: hold every queued lookup back for a minute.
    if (res.status === 429 || res.status === 403) lastNominatim = Date.now() + 60000;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as NominatimHit[]) : [];
  };
  const next = nominatimChain.then(run, run);
  nominatimChain = next.catch(() => undefined);
  return next;
}

function fromHit(hit: NominatimHit | undefined, source: GeoSource, approx: boolean): GeoPoint | null {
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, source, approx, matched: hit.display_name, at: Date.now() };
}

export async function geocodeAddress(query: string, isCancelled: () => boolean = () => false): Promise<GeoPoint | null> {
  const parts = parseAddressParts(query);
  const nominatim = (params: Record<string, string>) => {
    if (isCancelled()) return Promise.reject(new Error('cancelled'));
    return nominatimQueued(params);
  };
  try {
    const hit = await census(query);
    if (hit) return hit;
  } catch {
    /* Census down or slow: fall through to OpenStreetMap */
  }
  try {
    const free = fromHit((await nominatim({ q: query }))[0], 'osm', false);
    if (free) return free;
    // Wisconsin grid addresses: OSM stores "W123 S4567" as "W123S4567".
    const grid = query.replace(/\b([NSEW]\d+)\s+([NSEW]\d+)\b/g, '$1$2');
    if (grid !== query) {
      const gridHit = fromHit((await nominatim({ q: grid }))[0], 'osm', false);
      if (gridHit) return gridHit;
    }
    if (parts.street && (parts.city || parts.zip)) {
      const structured = fromHit(
        (
          await nominatim({
            street: simplifyStreet(parts.street),
            ...(parts.city ? { city: parts.city } : {}),
            ...(parts.state ? { state: parts.state } : {}),
            ...(parts.zip ? { postalcode: parts.zip } : {}),
          })
        )[0],
        'osm',
        false,
      );
      if (structured) return structured;
    }
    const state = parts.state || 'WI';
    let town = parts.city ? fromHit((await nominatim({ city: parts.city, state }))[0], 'area', true) : null;
    if (!town && parts.zip) town = fromHit((await nominatim({ postalcode: parts.zip }))[0], 'area', true);
    if (!town) return null;
    // The building isn't in either database; the street often is. Only trust a
    // street match close to the town, because street names repeat across the state.
    const name = streetName(parts.street);
    if (name) {
      const attempts: Record<string, string>[] = [{ q: `${name}, ${state}` }];
      if (parts.zip) attempts.push({ street: name, state, postalcode: parts.zip });
      for (const params of attempts) {
        const hit = fromHit((await nominatim(params))[0], 'street', true);
        if (hit && haversineMiles(hit, town) <= 8) return hit;
      }
    }
    return town;
  } catch {
    return null;
  }
}

/** "W123 S4567 S. Example Rd." -> "S. Example Rd."; "500 County Hwy M" -> "County Hwy M". */
export function streetName(street: string): string {
  let s = simplifyStreet(street).trim();
  while (/^[NSEW]?\d+[A-Z]?\b/i.test(s)) s = s.replace(/^[NSEW]?\d+[A-Z]?\b[\s,]*/i, '');
  return /[a-z]{2}/i.test(s) ? s : '';
}

export type GeocodeJob = { key: string; query: string };

/**
 * Geocodes every job not already cached. Census lookups run a few at a time;
 * Nominatim fallbacks queue behind the 1 request/second limiter.
 */
export async function geocodeAll(
  jobs: GeocodeJob[],
  onResult: (key: string, point: GeoPoint | null) => void,
  isCancelled: () => boolean,
  concurrency = 4,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !isCancelled()) {
      const job = jobs[next++];
      const point = await geocodeAddress(job.query, isCancelled);
      if (isCancelled()) return;
      onResult(job.key, point);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
}
