import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type L from 'leaflet';
import { haversineMiles } from './lib/address.ts';
import { geocodeAll, loadGeoCache, loadManualPins, saveGeoCache, saveManualPins, type GeoCache, type GeoPoint } from './lib/geocode.ts';
import { compareDue, parseInspections, startOfToday, URGENCY_LABEL, urgencyOf, type Inspection, type Urgency } from './lib/inspections.ts';
import {
  DEFAULT_FILTERS,
  firstUnscheduled,
  groupSites,
  leadFirst,
  nearbySites,
  visibleInspections,
  type DueWindow,
  type Filters,
  type PlacedSite,
  type Site,
} from './lib/sites.ts';
import { clearSavedData, loadDataset, loadPrefs, saveDataset, savePrefs } from './lib/storage.ts';
import { MapView, type LabelMode, type MapItem } from './components/MapView.tsx';
import { SearchBox } from './components/SearchBox.tsx';
import { InViewList, SiteDetail, type ListEntry } from './components/Panel.tsx';

type Dataset = { name: string; loadedAt: number; inspections: Inspection[]; sites: Site[] };

type Prefs = { filters: Filters; labelMode: LabelMode; radius: number };
const DEFAULT_PREFS: Prefs = { filters: DEFAULT_FILTERS, labelMode: 'auto', radius: 10 };

const DUE_OPTIONS: { value: DueWindow; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'overdue', label: 'Past due' },
  { value: '30', label: '≤ 30 days' },
  { value: '60', label: '≤ 60 days' },
  { value: '90', label: '≤ 90 days' },
  { value: '180', label: '≤ 6 months' },
];

const LEGEND: Urgency[] = ['overdue', 'soon', 'upcoming', 'later', 'scheduled'];

function toDataset(name: string, loadedAt: number, text: string): Dataset | string {
  const parsed = parseInspections(text);
  if (parsed.missingColumns.length) {
    return `“${name}” doesn’t look like the I&T Master export — it has no ${parsed.missingColumns.map((c) => `“${c}”`).join(', ')} column.`;
  }
  if (!parsed.inspections.length) return `“${name}” has no inspection rows.`;
  return { name, loadedAt, inspections: parsed.inspections, sites: groupSites(parsed.inspections) };
}

function initialDataset(): Dataset | null {
  const saved = loadDataset();
  if (!saved) return null;
  const ds = toDataset(saved.name, saved.loadedAt, saved.text);
  return typeof ds === 'string' ? null : ds;
}

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(initialDataset);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [geo, setGeo] = useState<GeoCache>(loadGeoCache);
  const [pins, setPins] = useState<GeoCache>(loadManualPins);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(DEFAULT_PREFS));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [bounds, setBounds] = useState<L.LatLngBounds | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  const { filters, labelMode, radius } = prefs;
  const updatePrefs = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  const today = startOfToday();

  // ---- loading a CSV ----
  const loadFile = useCallback(async (file: File) => {
    setError(null);
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
      setError(`“${file.name}” isn’t a CSV. Export the I&T Master list from Microsoft Lists as CSV and upload that.`);
      return;
    }
    const text = await file.text();
    const loadedAt = Date.now();
    const ds = toDataset(file.name, loadedAt, text);
    if (typeof ds === 'string') {
      setError(ds);
      return;
    }
    const stored = saveDataset({ name: file.name, loadedAt, text });
    setNotice(stored ? null : 'This browser wouldn’t save the file, so you’ll need to upload it again next time.');
    setDataset(ds);
    setSelectedKey(null);
    setPlacing(false);
    setFailed(new Set());
    setFitSignal((n) => n + 1);
  }, []);

  // ---- geocoding whatever isn't cached yet ----
  const fittedAfterGeocode = useRef(false);
  useEffect(() => {
    if (!dataset) return;
    const jobs = dataset.sites
      .filter((s) => s.query && !geoRef.current[s.key] && !pins[s.key])
      .map((s) => ({ key: s.key, query: s.query }));
    if (!jobs.length) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    let done = 0;
    fittedAfterGeocode.current = false;
    setProgress({ done: 0, total: jobs.length });
    void geocodeAll(
      jobs,
      (key, point) => {
        done++;
        setProgress({ done, total: jobs.length });
        if (point) {
          const next = { ...geoRef.current, [key]: point };
          geoRef.current = next;
          saveGeoCache(next);
          setGeo(next);
        } else {
          setFailed((f) => new Set(f).add(key));
        }
      },
      () => cancelled,
    ).then(() => {
      if (cancelled) return;
      setProgress(null);
      if (!fittedAfterGeocode.current) {
        fittedAfterGeocode.current = true;
        setFitSignal((n) => n + 1);
      }
    });
    return () => {
      cancelled = true;
    };
    // pins are only read to skip work, so moving a pin does not restart geocoding
  }, [dataset, retryTick]);

  // Fit to the data once on first load when coordinates are already cached.
  useEffect(() => {
    if (dataset) setFitSignal((n) => n + 1);
  }, []);

  // ---- derived data ----
  const pointOf = useCallback((key: string): GeoPoint | null => pins[key] ?? geo[key] ?? null, [pins, geo]);

  const placed = useMemo<PlacedSite[]>(() => {
    if (!dataset) return [];
    const out: PlacedSite[] = [];
    for (const site of dataset.sites) {
      const point = pointOf(site.key);
      if (point) out.push({ ...site, point });
    }
    return out;
  }, [dataset, pointOf]);

  const selectedSite = dataset?.sites.find((s) => s.key === selectedKey) ?? null;
  const selectedPlaced = placed.find((s) => s.key === selectedKey) ?? null;

  const items = useMemo<MapItem[]>(() => {
    const out: MapItem[] = [];
    for (const site of placed) {
      const isSel = site.key === selectedKey;
      const list = leadFirst(isSel ? site.inspections : visibleInspections(site, filters, today));
      if (!list.length) continue;
      const near = selectedPlaced !== null && !isSel && haversineMiles(selectedPlaced.point, site.point) <= radius;
      out.push({ site, list, lead: list[0], urgency: urgencyOf(list[0], today), near });
    }
    return out;
  }, [placed, filters, selectedKey, selectedPlaced, radius]);

  const neighbours = useMemo(
    () => (selectedPlaced ? nearbySites(selectedPlaced, placed, radius, filters, today) : []),
    [selectedPlaced, placed, radius, filters],
  );

  const inView = useMemo<ListEntry[]>(() => {
    const visible = bounds ? items.filter((i) => bounds.contains([i.site.point.lat, i.site.point.lon])) : items;
    // Work still to be scheduled first (by its earliest unscheduled due date), fully scheduled sites after.
    return visible
      .map((i) => ({ site: i.site, list: i.list, open: firstUnscheduled(i.list) }))
      .sort((a, b) => Number(!a.open) - Number(!b.open) || compareDue(a.open ?? a.list[0], b.open ?? b.list[0]))
      .map(({ site, list }) => ({ site, list }));
  }, [items, bounds]);

  const unplaced = useMemo(() => {
    if (!dataset) return [];
    return dataset.sites.filter(
      (s) => !pointOf(s.key) && (failed.has(s.key) || !s.query) && visibleInspections(s, filters, today).length > 0,
    );
  }, [dataset, pointOf, failed, filters]);

  const legendCounts = useMemo(() => {
    const counts: Record<Urgency, number> = { overdue: 0, soon: 0, upcoming: 0, later: 0, scheduled: 0, none: 0 };
    if (dataset) for (const site of dataset.sites) for (const i of visibleInspections(site, filters, today)) counts[urgencyOf(i, today)]++;
    return counts;
  }, [dataset, filters]);

  // ---- actions ----
  const select = useCallback((key: string | null, focus = true) => {
    setSelectedKey(key);
    setPlacing(false);
    setHoverKey(null);
    if (key && focus) setFocusSignal((n) => n + 1);
  }, []);

  const placePin = (lat: number, lon: number) => {
    if (!selectedKey) return;
    const point: GeoPoint = { lat, lon, source: 'manual', approx: false, matched: 'Placed by hand', at: Date.now() };
    const next = { ...pins, [selectedKey]: point };
    setPins(next);
    saveManualPins(next);
    setPlacing(false);
  };

  const resetPin = () => {
    if (!selectedKey) return;
    const next = { ...pins };
    delete next[selectedKey];
    setPins(next);
    saveManualPins(next);
    if (!geo[selectedKey]) setRetryTick((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (placing) setPlacing(false);
      else if ((e.target as HTMLElement | null)?.tagName !== 'INPUT') setSelectedKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing]);

  // Drag a CSV anywhere onto the window.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) void loadFile(file);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [loadFile]);

  const loadedLabel = dataset
    ? `${dataset.inspections.length} inspections · ${new Date(dataset.loadedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : '';
  const inViewCount = inView.reduce((n, e) => n + e.list.length, 0);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 2C10.5 2 6 6.4 6 11.9 6 19.4 16 30 16 30s10-10.6 10-18.1C26 6.4 21.5 2 16 2z" />
            <circle cx="16" cy="12" r="4.5" />
          </svg>
          <span>
            Omni <b>Inspection Finder</b>
          </span>
        </div>
        {dataset && <SearchBox sites={dataset.sites} onPick={(key) => select(key)} />}
        <div className="file">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
              e.target.value = '';
            }}
          />
          {dataset && (
            <span className="file-meta" title={dataset.name}>
              <span className="file-name">{dataset.name}</span>
              <span className="file-sub">{loadedLabel}</span>
            </span>
          )}
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
            {dataset ? 'Upload new CSV' : 'Upload CSV'}
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div className={`banner ${error ? 'is-error' : ''}`} role="status">
          <span>{error ?? notice}</span>
          <button type="button" className="link" onClick={() => (error ? setError(null) : setNotice(null))}>
            Dismiss
          </button>
        </div>
      )}

      <main className="body">
        <aside className="panel">
          {dataset && (
            <div className="filters">
              <div className="seg" role="group" aria-label="Due date filter">
                {DUE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={filters.due === o.value ? 'is-on' : ''}
                    aria-pressed={filters.due === o.value}
                    onClick={() => updatePrefs({ filters: { ...filters, due: o.value } })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="filter-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={filters.hideScheduled}
                    onChange={(e) => updatePrefs({ filters: { ...filters, hideScheduled: e.target.checked } })}
                  />
                  Hide scheduled
                </label>
                <label className="labels">
                  Map labels
                  <select value={labelMode} onChange={(e) => updatePrefs({ labelMode: e.target.value as LabelMode })}>
                    <option value="auto">Auto (by zoom)</option>
                    <option value="names">Name + due date</option>
                    <option value="dates">Due date only</option>
                    <option value="dots">Dots only</option>
                  </select>
                </label>
              </div>
              {progress && (
                <div className="progress" aria-live="polite">
                  <span>
                    Locating addresses… {progress.done}/{progress.total}
                  </span>
                  <span className="bar">
                    <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                  </span>
                </div>
              )}
            </div>
          )}

          {dataset && selectedSite ? (
            <SiteDetail
              site={selectedSite}
              point={pointOf(selectedSite.key)}
              neighbours={neighbours}
              radius={radius}
              placing={placing}
              onRadius={(r) => {
                updatePrefs({ radius: r });
                setFocusSignal((n) => n + 1);
              }}
              onSelect={(key) => select(key)}
              onHover={setHoverKey}
              onBack={() => select(null)}
              onStartPlacing={() => setPlacing(true)}
              onCancelPlacing={() => setPlacing(false)}
              onResetPin={resetPin}
            />
          ) : dataset ? (
            <InViewList entries={inView} unplaced={unplaced} totalShown={inViewCount} onSelect={(key) => select(key)} onHover={setHoverKey} />
          ) : (
            <div className="panel-body intro">
              <h1>Find inspections near you</h1>
              <ol>
                <li>Export the <b>I&amp;T Master</b> list from Microsoft Lists as CSV.</li>
                <li>Upload it here (or drop it anywhere on this page).</li>
                <li>Search a company or click any pin to see what else is due nearby.</li>
              </ol>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => fileInput.current?.click()}>
                Upload CSV
              </button>
              <p className="muted small">
                The file stays in this browser. Only street addresses are sent to the US Census and OpenStreetMap geocoders to place
                the pins.
              </p>
            </div>
          )}

          {dataset && (
            <footer className="panel-foot">
              <span>Saved in this browser only.</span>
              {confirmClear ? (
                <span>
                  Remove the CSV and pins from this browser?{' '}
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => {
                      clearSavedData();
                      setDataset(null);
                      setGeo({});
                      setPins({});
                      setSelectedKey(null);
                      setConfirmClear(false);
                    }}
                  >
                    Remove
                  </button>{' '}
                  <button type="button" className="link" onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="link" onClick={() => setConfirmClear(true)}>
                  Clear saved data
                </button>
              )}
            </footer>
          )}
        </aside>

        <section className="map-area">
          <MapView
            items={items}
            selectedKey={selectedKey}
            hoverKey={hoverKey}
            radiusMiles={radius}
            labelMode={labelMode}
            placing={placing}
            fitSignal={fitSignal}
            focusSignal={focusSignal}
            onSelect={(key) => select(key, false)}
            onPlace={placePin}
            onBoundsChange={setBounds}
          />
          {dataset && (
            <div className="legend" aria-label="Legend">
              {LEGEND.map((u) => (
                <span key={u} className="legend-item">
                  <span className={`swatch u-${u}`} />
                  {URGENCY_LABEL[u]} <b>{legendCounts[u]}</b>
                </span>
              ))}
            </div>
          )}
          {dataset && (
            <button type="button" className="btn fit" onClick={() => setFitSignal((n) => n + 1)} title="Zoom to show every inspection">
              Show all
            </button>
          )}
          {placing && <div className="placing-tip">Click the map to place the pin · Esc to cancel</div>}
        </section>
      </main>

      {dragging && (
        <div className="drop">
          <div>Drop the I&amp;T Master CSV to load it</div>
        </div>
      )}
    </div>
  );
}
