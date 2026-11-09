import { useEffect, useMemo, useRef, useState } from 'react';
import { searchInspections, type Site } from '../lib/sites.ts';
import { DueChip } from './DueChip.tsx';

type Props = {
  sites: Site[];
  onPick: (siteKey: string) => void;
};

export function SearchBox({ sites, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchInspections(sites, query), [sites, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    onPick(hit.site.key);
    setQuery(hit.inspection.title);
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.5 3a5.5 5.5 0 014.38 8.82l3.65 3.65-1.06 1.06-3.65-3.65A5.5 5.5 0 118.5 3zm0 1.5a4 4 0 100 8 4 4 0 000-8z" />
      </svg>
      <input
        ref={input}
        type="search"
        placeholder="Search company, address or project #"
        title="Press / to jump here"
        aria-label="Search inspections"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            pick(active);
          } else if (e.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      {open && query.trim() && (
        <div className="search-results" role="listbox">
          {hits.length === 0 && <div className="search-empty">No inspections match “{query}”.</div>}
          {hits.map((hit, i) => (
            <button
              key={hit.inspection.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`search-hit${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="search-hit-main">
                <span className="search-hit-title">{hit.inspection.title}</span>
                <span className="search-hit-sub">{hit.inspection.address}</span>
              </span>
              <DueChip inspection={hit.inspection} compact />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
