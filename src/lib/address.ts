/**
 * Address cleanup for the free-text Microsoft Lists "Address" column
 * ("1131 Main Dr. Waunakee WI 53597", multi-line campuses, missing commas).
 * Ported from the I&T Scheduling Center. The raw value is never changed; only
 * derived copies are normalised.
 */

export type AddressParts = {
  street: string;
  city: string;
  state: string;
  zip: string;
};

/** Longest match wins, so "Sun Prairie" never collapses to "Prairie". */
const CITY_GAZETTEER: string[] = [
  'Sun Prairie', 'Wisconsin Dells', 'Lake Delton', 'Richland Center', 'Lake Mills',
  'Lake Geneva', 'Beaver Dam', 'Fort Atkinson', 'Mount Horeb', 'Prairie Du Sac',
  'New Berlin', 'Madison', 'Fitchburg', 'Janesville', 'Verona', 'Baraboo',
  'Waunakee', 'Oregon', 'Oconomowoc', 'Columbus', 'Edgerton', 'Waukesha', 'Beloit',
  'Reedsburg', 'Portage', 'Barneveld', 'DeForest', 'Darlington', 'Stoughton',
  'Monona', 'Mukwonago', 'Deerfield', 'Middleton', 'Whitewater', 'Brookfield',
  'Clinton', 'Milton', 'Evansville', 'Dousman', 'Milwaukee', 'Salem', 'Cambridge',
  'Jefferson', 'Belleville', 'Mayville', 'Muscoda', 'Waterford', 'Muskego',
  'Hartland', 'Hollandale', 'Watertown', 'Necedah', 'Orfordville', 'Windsor',
  'Sussex', 'Richland', 'Dubuque', 'Cottage Grove', 'Cross Plains', 'McFarland',
  'Marshall', 'Waterloo', 'Black Earth', 'Mazomanie', 'Sauk City', 'Spring Green',
  'Dodgeville', 'Mineral Point', 'Lodi', 'Poynette', 'Rio', 'Arlington', 'Pardeeville',
  'Wyocena', 'Cambria', 'Randolph', 'Fall River', 'Doylestown', 'Lebanon', 'Ixonia',
  'Johnson Creek', 'Lake Ripley', 'Palmyra', 'Eagle', 'Elkhorn', 'Delavan',
  'Williams Bay', 'Fontana', 'Sharon', 'Walworth', 'Genoa City', 'Burlington',
  'Racine', 'Kenosha', 'Pleasant Prairie', 'Franksville', 'Union Grove', 'Bristol',
  'Twin Lakes', 'Silver Lake', 'Paddock Lake', 'Salem Lakes', 'Wilmot', 'Trevor',
  'Antioch', 'Pewaukee', 'Menomonee Falls', 'Germantown', 'Mequon', 'Grafton',
  'Cedarburg', 'Port Washington', 'Saukville', 'West Bend', 'Jackson', 'Slinger',
  'Hartford', 'Richfield', 'Hubertus', 'Delafield', 'Nashotah', 'Okauchee', 'Merton',
  'Lannon', 'Butler', 'Elm Grove', 'Wauwatosa', 'Shorewood', 'Whitefish Bay',
  'Glendale', 'Brown Deer', 'Fox Point', 'Bayside', 'Thiensville', 'Sturtevant',
  'Mount Pleasant', 'Caledonia', 'Wind Lake', 'Rochester', 'East Troy', 'Troy',
  'Springfield', 'Plain', 'Blue Mounds', 'Brooklyn', 'Albany', 'Monroe', 'New Glarus',
  'Platteville', 'Lancaster', 'Boscobel', 'Prairie du Chien', 'Tomah', 'Mauston',
  'Wisconsin Rapids', 'Stevens Point', 'Oshkosh', 'Fond du Lac', 'Appleton', 'Green Bay',
].sort((a, b) => b.length - a.length);

const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const STATE_ZIP = new RegExp(`\\b(${STATES})\\b[\\s,.]*(\\d{5})(?:-\\d{4})?\\b`, 'i');
const STATE_END = new RegExp(`\\b(${STATES})\\.?\\s*$`, 'i');

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Single-line display form of the raw address. */
export function flattenAddress(raw: string): string {
  return collapseWhitespace(raw.replace(/[\r\n]+/g, ', ')).replace(/(,\s*)+$/, '');
}

/** Key used to cache coordinates and to group inspections at the same site. */
export function normalizeAddressKey(value: string): string {
  return collapseWhitespace(
    value
      .replace(/[\r\n]+/g, ' ')
      .toLowerCase()
      .replace(/[.,;#]/g, ' ')
      .replace(/\b(ste|suite|unit|apt|bldg|building)\b\.?\s*/g, ' '),
  );
}

export function parseAddressParts(raw: string, defaultState = 'WI'): AddressParts {
  // "100 26th St.Prairie Du Sac" -> "100 26th St. Prairie Du Sac"
  const flat = flattenAddress(raw).replace(/\.(?=[A-Z])/g, '. ');
  if (!flat) return { street: '', city: '', state: '', zip: '' };

  let working = flat;
  let state = '';
  let zip = '';

  const stateZip = STATE_ZIP.exec(working);
  if (stateZip) {
    state = stateZip[1].toUpperCase();
    zip = stateZip[2];
    working = working.slice(0, stateZip.index);
  } else {
    const zipOnly = /\b(\d{5})(?:-\d{4})?\b\s*$/.exec(working);
    if (zipOnly) {
      zip = zipOnly[1];
      working = working.slice(0, zipOnly.index);
    } else {
      const stateOnly = STATE_END.exec(working);
      if (stateOnly) {
        state = stateOnly[1].toUpperCase();
        working = working.slice(0, stateOnly.index);
      }
    }
    state = state || defaultState;
  }

  working = working.replace(/[\s,]+$/, '').trim();

  let city = '';
  let street = working;
  const lower = working.toLowerCase();
  for (const name of CITY_GAZETTEER) {
    const n = name.toLowerCase();
    if (lower === n) {
      street = '';
      city = name;
      break;
    }
    if (lower.endsWith(', ' + n) || lower.endsWith(' ' + n)) {
      city = name;
      street = working.slice(0, working.length - name.length);
      break;
    }
  }

  if (!city) {
    // Fall back to the trailing capitalised run of words before the state.
    const tail = working.split(',').pop()?.trim() ?? '';
    const words = tail.split(' ').filter(Boolean);
    const guess: string[] = [];
    for (let i = words.length - 1; i >= 0 && guess.length < 3; i--) {
      const w = words[i];
      if (/^[A-Z][a-zA-Z'-]*$/.test(w) || /^(du|des|la|le)$/i.test(w)) guess.unshift(w);
      else break;
    }
    if (guess.length && working.includes(',')) {
      city = guess.join(' ');
      street = working.slice(0, working.length - city.length);
    }
  }

  street = street
    .replace(/[\s,]+$/, '')
    .replace(/\s+(?:in|at)$/i, '')
    .replace(/[\s,]+$/, '');

  return { street, city, state, zip };
}

/**
 * "1600-1610 & 1700-1704 Valley Dr." is one campus entered as several
 * building ranges; keep the first number so a geocoder can place it.
 */
export function simplifyStreet(street: string): string {
  const match = /^(\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*(?:&|and)\s*\d+(?:\s*[-–]\s*\d+)?)*)\s*(.*)$/i.exec(street);
  if (!match) return street;
  const number = /\d+/.exec(match[1])?.[0];
  if (!number) return street;
  const rest = match[2].trim();
  return rest ? `${number} ${rest}` : number;
}

export function addressForGeocoding(raw: string, parts = parseAddressParts(raw)): string {
  const composed = [simplifyStreet(parts.street), parts.city, parts.state, parts.zip].filter(Boolean).join(', ');
  return composed || flattenAddress(raw);
}

export type LatLon = { lat: number; lon: number };

export function haversineMiles(a: LatLon, b: LatLon): number {
  const R = 3958.7613;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
