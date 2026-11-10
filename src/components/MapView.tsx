import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatDate, urgencyOf, type Inspection, type Urgency } from '../lib/inspections.ts';
import type { PlacedSite } from '../lib/sites.ts';

export type LabelMode = 'auto' | 'names' | 'dates' | 'dots';

export type MapItem = {
  site: PlacedSite;
  list: Inspection[];
  lead: Inspection;
  urgency: Urgency;
  /** Inside the nearby radius of the selected site. */
  near: boolean;
};

type Props = {
  items: MapItem[];
  selectedKey: string | null;
  hoverKey: string | null;
  radiusMiles: number;
  labelMode: LabelMode;
  placing: boolean;
  /** Bumped by the parent to fit the map to every pin. */
  fitSignal: number;
  /** Bumped by the parent to frame the selected site and its radius. */
  focusSignal: number;
  onSelect: (key: string | null) => void;
  onPlace: (lat: number, lon: number) => void;
  onBoundsChange: (bounds: L.LatLngBounds) => void;
};

const RANK: Record<Urgency, number> = { overdue: 500, soon: 400, upcoming: 300, later: 200, none: 100, scheduled: 0 };
const MILE = 1609.344;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type LabelKind = 'names' | 'dates' | 'dots';
type Placement = { label: LabelKind; left: boolean };

function wantedLabel(mode: LabelMode, zoom: number, near: boolean): LabelKind {
  if (mode !== 'auto') return mode;
  if (near || zoom >= 11) return 'names';
  if (zoom >= 9) return 'dates';
  return 'dots';
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, weight: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7;
  measureCtx.font = `${weight} 12px system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

function dueText(insp: Inspection): string {
  return `${insp.scheduled ? '✓ ' : ''}${formatDate(insp.due, 'short')}`;
}

/** Label padding + border, the gap between label parts, and the divider before each extra date. */
const LABEL_CHROME = 16;
const LABEL_GAP = 6;
const DATE_DIVIDER = 7;

function labelWidth(item: MapItem, kind: LabelKind): number {
  if (kind === 'dots') return 0;
  let w = LABEL_CHROME + item.list.reduce((sum, i) => sum + textWidth(dueText(i), 700), 0);
  w += (item.list.length - 1) * (LABEL_GAP + DATE_DIVIDER);
  if (kind === 'names') w += Math.min(190, textWidth(item.lead.title, 600)) + LABEL_GAP;
  return w;
}

type Rect = [number, number, number, number];
const hits = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * Greedy label placement: the selected/hovered site first, then the nearby
 * ring, then most urgent. Each label tries the right side, then the left, then
 * a shorter date-only label, and drops to a bare dot rather than covering
 * another label or pin.
 */
function placeLabels(map: L.Map, items: MapItem[], mode: LabelMode, zoom: number, selectedKey: string | null, hoverKey: string | null): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const pts = new Map(items.map((i) => [i.site.key, map.project([i.site.point.lat, i.site.point.lon], zoom)]));
  const taken: Rect[] = items.map((i) => {
    const p = pts.get(i.site.key)!;
    return [p.x - 7, p.y - 7, p.x + 7, p.y + 7];
  });
  const prio = (i: MapItem) =>
    i.site.key === selectedKey ? 0 : i.site.key === hoverKey ? 1 : i.near ? 2 : 3;
  const order = [...items].sort(
    (a, b) => prio(a) - prio(b) || RANK[b.urgency] - RANK[a.urgency] || (a.lead.due?.getTime() ?? Infinity) - (b.lead.due?.getTime() ?? Infinity),
  );
  for (const item of order) {
    const key = item.site.key;
    const p = pts.get(key)!;
    const forced = key === selectedKey || key === hoverKey;
    const want: LabelKind = forced ? 'names' : wantedLabel(mode, zoom, item.near);
    const kinds: LabelKind[] = want === 'names' ? ['names', 'dates'] : want === 'dates' ? ['dates'] : [];
    let placed: Placement = { label: 'dots', left: false };
    search: for (const kind of kinds) {
      const w = labelWidth(item, kind);
      for (const left of [false, true]) {
        const r: Rect = left ? [p.x - 11 - w, p.y - 10, p.x - 11, p.y + 10] : [p.x + 11, p.y - 10, p.x + 11 + w, p.y + 10];
        if (forced || !taken.some((t) => hits(r, t))) {
          taken.push(r);
          placed = { label: kind, left };
          break search;
        }
      }
    }
    out.set(key, placed);
  }
  return out;
}

function iconHtml(item: MapItem, place: Placement, selected: boolean, dim: boolean): string {
  const { lead, list, urgency, site } = item;
  const count = list.length;
  const cls = ['pin', `u-${urgency}`, selected && 'is-selected', dim && 'is-dim', site.point.approx && 'is-approx', place.left && 'is-left']
    .filter(Boolean)
    .join(' ');
  // A bare dot can't show every date, so it shows how many inspections share the site instead.
  if (place.label === 'dots') return `<div class="${cls}"><span class="pin-dot">${count > 1 ? count : ''}</span></div>`;
  const name = place.label === 'names' ? `<span class="pin-name">${esc(lead.title)}</span>` : '';
  const dues = list.map((i) => `<span class="pin-due u-${urgencyOf(i)}">${esc(dueText(i))}</span>`).join('');
  return `<div class="${cls}"><span class="pin-dot"></span><span class="pin-label">${name}${dues}</span></div>`;
}

export function MapView(props: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [zoom, setZoom] = useState(8);

  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { zoomControl: false, worldCopyJump: false }).setView([43.07, -89.4], 8);
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('zoomend', () => setZoom(map.getZoom()));
    map.on('moveend', () => propsRef.current.onBoundsChange(map.getBounds()));
    map.on('click', (e: L.LeafletMouseEvent) => {
      const p = propsRef.current;
      if (p.placing) p.onPlace(e.latlng.lat, e.latlng.lng);
    });
    mapRef.current = map;
    setZoom(map.getZoom());
    propsRef.current.onBoundsChange(map.getBounds());
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(el.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Markers
  useEffect(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    const { items, selectedKey, hoverKey, labelMode } = props;
    const placement = placeLabels(map, items, labelMode, zoom, selectedKey, hoverKey);
    for (const item of items) {
      const selected = item.site.key === selectedKey;
      const hovered = item.site.key === hoverKey;
      const dim = selectedKey !== null && !selected && !item.near;
      const place = placement.get(item.site.key) ?? { label: 'dots', left: false };
      const marker = L.marker([item.site.point.lat, item.site.point.lon], {
        icon: L.divIcon({ className: 'pin-wrap', html: iconHtml(item, place, selected || hovered, dim), iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: selected ? 20000 : hovered ? 15000 : dim ? RANK[item.urgency] - 5000 : RANK[item.urgency] + (place.label !== 'dots' ? 1000 : 0),
        riseOnHover: true,
        keyboard: false,
        title: `${item.lead.title} — ${item.list
          .map((i) => `${i.frequency ? i.frequency + ' ' : ''}due ${formatDate(i.due)}${i.scheduled ? ' (scheduled)' : ''}`)
          .join(', ')}`,
      });
      marker.on('click', () => {
        if (propsRef.current.placing) return;
        propsRef.current.onSelect(item.site.key);
      });
      marker.addTo(layer);
    }
  }, [props.items, props.selectedKey, props.hoverKey, props.labelMode, zoom]);

  // Radius circle around the selected site
  const selected = props.items.find((i) => i.site.key === props.selectedKey);
  const selLat = selected?.site.point.lat;
  const selLon = selected?.site.point.lon;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    circleRef.current?.remove();
    circleRef.current = null;
    if (selLat === undefined || selLon === undefined) return;
    circleRef.current = L.circle([selLat, selLon], {
      radius: props.radiusMiles * MILE,
      color: '#1d4ed8',
      weight: 1.5,
      dashArray: '6 6',
      fillColor: '#3b82f6',
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(map);
  }, [selLat, selLon, props.radiusMiles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.fitSignal) return;
    const pts = propsRef.current.items.map((i) => L.latLng(i.site.point.lat, i.site.point.lon));
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 13 });
  }, [props.fitSignal]);

  // A focus request waits until the selected site has coordinates (it may still be geocoding).
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (props.focusSignal) pendingFocus.current = propsRef.current.selectedKey;
  }, [props.focusSignal]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || pendingFocus.current === null || pendingFocus.current !== propsRef.current.selectedKey) return;
    if (selLat === undefined || selLon === undefined) return;
    pendingFocus.current = null;
    const bounds = L.latLng(selLat, selLon).toBounds(propsRef.current.radiusMiles * MILE * 2);
    map.flyToBounds(bounds, { padding: [24, 24], maxZoom: 15, duration: 0.6 });
  }, [props.focusSignal, selLat, selLon]);

  useEffect(() => {
    el.current?.classList.toggle('is-placing', props.placing);
  }, [props.placing]);

  return <div ref={el} className="map" role="application" aria-label="Inspection map" />;
}
