import { useState } from 'react';
import { formatDate, relativeDue, type Inspection } from '../lib/inspections.ts';
import type { GeoPoint } from '../lib/geocode.ts';
import type { Neighbour, Site } from '../lib/sites.ts';
import { DueChip } from './DueChip.tsx';

export const RADIUS_OPTIONS = [2, 5, 10, 15, 25, 50];

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={async () => {
        setDone((await copyText(text)) ? 'ok' : 'fail');
        setTimeout(() => setDone('idle'), 1500);
      }}
    >
      {done === 'ok' ? 'Copied' : done === 'fail' ? 'Copy blocked' : label}
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  if (!value || (value === '0' && label === 'Techs')) return null;
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function InspectionCard({ insp }: { insp: Inspection }) {
  const emails = insp.email.split(/[;,\s]+/).filter((e) => e.includes('@'));
  return (
    <article className="card">
      <header className="card-head">
        <div>
          <h3>{insp.title}</h3>
          {insp.client && insp.client !== insp.title && <p className="muted">{insp.client}</p>}
        </div>
        <DueChip inspection={insp} />
      </header>
      <p className="due-line">
        {insp.scheduled
          ? `Already scheduled${insp.scheduledDate ? ' for ' + formatDate(insp.scheduledDate) : ''}`
          : relativeDue(insp.due).replace(/^./, (c) => c.toUpperCase())}
      </p>
      <dl className="facts">
        <Fact label="Frequency" value={insp.frequency} />
        <Fact label="System" value={insp.systemType} />
        <Fact label="Progress" value={insp.progress} />
        <Fact label="Project #" value={insp.projectNumber} />
        <Fact label="Quoted hrs" value={insp.quotedHours} />
        <Fact label="Techs" value={insp.techs} />
        <Fact label="Inspector" value={insp.preferredInspector} />
        <Fact label="Panel" value={insp.panelType} />
        <Fact label="Last done" value={insp.lastInspection} />
        <Fact label="Contract end" value={insp.contractEnd} />
      </dl>
      {(insp.contact || emails.length > 0) && (
        <div className="contact">
          {insp.contact && <p className="pre">{insp.contact}</p>}
          {emails.map((e) => (
            <a key={e} href={`mailto:${e}`}>
              {e}
            </a>
          ))}
        </div>
      )}
      {insp.notes && (
        <details className="notes">
          <summary>Notes</summary>
          <p className="pre">{insp.notes}</p>
        </details>
      )}
    </article>
  );
}

type DetailProps = {
  site: Site;
  point: GeoPoint | null;
  neighbours: Neighbour[];
  radius: number;
  placing: boolean;
  onRadius: (r: number) => void;
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
  onBack: () => void;
  onStartPlacing: () => void;
  onCancelPlacing: () => void;
  onResetPin: () => void;
};

export function SiteDetail(p: DetailProps) {
  const city = (s: Site) => s.address.split(',').slice(-2, -1)[0]?.trim() ?? '';
  const copy = [
    `Near ${p.site.inspections[0]?.title ?? ''} (${p.site.address}) — within ${p.radius} mi`,
    ...p.neighbours.map(
      (n) => `${n.miles.toFixed(1)} mi · ${n.list.map((i) => `${i.title} — due ${formatDate(i.due, 'short')}`).join('; ')} · ${n.site.address}`,
    ),
  ].join('\n');

  return (
    <div className="panel-body">
      <button type="button" className="back" onClick={p.onBack}>
        ← All inspections in view
      </button>

      <section className="site-head">
        <p className="site-address">{p.site.address || 'No address in the CSV'}</p>
        {p.point?.approx && (
          <p className="warn">
            Approximate pin: {p.point.source === 'street' ? 'the street was found but not the building' : 'only the town could be found'}. Use “Move pin”
            to put it on the building.
          </p>
        )}
        {!p.point && !p.placing && p.site.address && <p className="warn">This address couldn’t be located automatically, so it isn’t on the map yet.</p>}
        {p.placing && <p className="hint">Click the map where this site is. <button type="button" className="link" onClick={p.onCancelPlacing}>Cancel</button></p>}
        <div className="actions">
          {p.site.address && (
            <a className="btn" href={mapsUrl(p.site.address)} target="_blank" rel="noreferrer">
              Directions
            </a>
          )}
          {p.site.address && <CopyButton text={p.site.address} label="Copy address" />}
          {!p.placing && (
            <button type="button" className="btn btn-ghost" onClick={p.onStartPlacing}>
              {p.point ? 'Move pin' : 'Place pin'}
            </button>
          )}
          {p.point?.source === 'manual' && (
            <button type="button" className="btn btn-ghost" onClick={p.onResetPin}>
              Reset pin
            </button>
          )}
        </div>
      </section>

      {p.site.inspections.map((insp) => (
        <InspectionCard key={insp.id} insp={insp} />
      ))}

      <section className="nearby">
        <div className="nearby-head">
          <h2>
            Nearby <span className="count">{p.neighbours.length}</span>
          </h2>
          <label className="radius">
            within
            <select value={p.radius} onChange={(e) => p.onRadius(Number(e.target.value))}>
              {RADIUS_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} mi
                </option>
              ))}
            </select>
          </label>
          {p.neighbours.length > 0 && <CopyButton text={copy} label="Copy list" />}
        </div>
        {!p.point && <p className="muted">Place this site on the map to see what’s nearby.</p>}
        {p.point && p.neighbours.length === 0 && <p className="muted">Nothing else matching the filters within {p.radius} miles.</p>}
        <ul className="rows">
          {p.neighbours.map((n) => (
            <li key={n.site.key}>
              <button
                type="button"
                className="row"
                onClick={() => p.onSelect(n.site.key)}
                onMouseEnter={() => p.onHover(n.site.key)}
                onMouseLeave={() => p.onHover(null)}
              >
                <span className="row-main">
                  <span className="row-title">
                    {n.list[0].title}
                    {n.list.length > 1 && <span className="more"> +{n.list.length - 1}</span>}
                  </span>
                  <span className="row-sub">
                    {n.miles.toFixed(1)} mi · {city(n.site) || n.site.address}
                  </span>
                </span>
                <DueChip inspection={n.list[0]} compact />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export type ListEntry = { site: Site; list: Inspection[] };

type ListProps = {
  entries: ListEntry[];
  unplaced: Site[];
  totalShown: number;
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
};

export function InViewList({ entries, unplaced, totalShown, onSelect, onHover }: ListProps) {
  const [showUnplaced, setShowUnplaced] = useState(false);
  return (
    <div className="panel-body">
      {unplaced.length > 0 && (
        <div className="notice">
          <button type="button" className="link" onClick={() => setShowUnplaced((v) => !v)}>
            {unplaced.length} {unplaced.length === 1 ? 'site isn’t' : 'sites aren’t'} on the map yet
          </button>
          {showUnplaced && (
            <ul className="rows">
              {unplaced.map((s) => (
                <li key={s.key}>
                  <button type="button" className="row" onClick={() => onSelect(s.key)}>
                    <span className="row-main">
                      <span className="row-title">{s.inspections[0].title}</span>
                      <span className="row-sub">{s.address || 'No address'}</span>
                    </span>
                    <DueChip inspection={s.inspections[0]} compact />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <h2 className="list-head">
        In this map view <span className="count">{totalShown}</span>
      </h2>
      {entries.length === 0 && <p className="muted">No inspections in this part of the map match the filters. Zoom out or change the due filter.</p>}
      <ul className="rows">
        {entries.map(({ site, list }) => (
          <li key={site.key}>
            <button
              type="button"
              className="row"
              onClick={() => onSelect(site.key)}
              onMouseEnter={() => onHover(site.key)}
              onMouseLeave={() => onHover(null)}
            >
              <span className="row-main">
                <span className="row-title">
                  {list[0].title}
                  {list.length > 1 && <span className="more"> +{list.length - 1}</span>}
                </span>
                <span className="row-sub">{site.address}</span>
              </span>
              <DueChip inspection={list[0]} compact />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
