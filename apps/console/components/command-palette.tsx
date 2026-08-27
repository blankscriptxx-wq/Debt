'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Result {
  id: string;
  label: string;
  hint: string;
  href: string;
}

/**
 * Global search and command palette.
 *
 * Keyboard-first because the people using this spend all day in it: cmd-K from
 * anywhere, arrows to move, enter to open, escape to leave. Search covers cases,
 * clients and commands in one list rather than making someone choose a category
 * before they have typed anything.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);
      }
      if (event.key === 'Escape') setOpen(false);
      // Plain "/" opens search, as long as the person is not already typing.
      if (event.key === '/' && !isTyping(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else { setTerm(''); setResults([]); setSelected(0); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = term.trim();
    if (query.length < 2) {
      setResults(COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())));
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data: { results: Result[] }) => {
          setResults([
            ...data.results,
            ...COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
          ]);
          setSelected(0);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, results.length - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    }
    if (event.key === 'Enter' && results[selected]) {
      event.preventDefault();
      router.push(results[selected]!.href);
      setOpen(false);
    }
  }

  return (
    <>
      <button className="sv-search" onClick={() => setOpen(true)}
              aria-label="Search cases, clients and commands">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span style={{ flex: 1 }}>Search cases, clients, commands</span>
        <span className="sv-kbd">⌘K</span>
      </button>

      {open && (
        <div className="sv-palette-backdrop" onClick={() => setOpen(false)} role="presentation">
          <div className="sv-palette" onClick={(e) => e.stopPropagation()}
               role="dialog" aria-modal="true" aria-label="Search">
            <input
              ref={inputRef}
              className="sv-palette__input"
              placeholder="Search by case reference, client name, postcode, or type a command"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onKeyDown}
              aria-controls="sv-palette-results"
              aria-activedescendant={results[selected] ? `sv-result-${results[selected]!.id}` : undefined}
            />
            <ul className="sv-palette__list" id="sv-palette-results" role="listbox">
              {loading && <li className="sv-palette__hint" style={{ padding: 12 }}>Searching…</li>}
              {!loading && results.length === 0 && (
                <li className="sv-palette__hint" style={{ padding: 12 }}>
                  {term.length < 2 ? 'Type at least two characters' : 'Nothing found'}
                </li>
              )}
              {results.map((result, index) => (
                <li key={result.id} id={`sv-result-${result.id}`} role="option"
                    aria-selected={index === selected}
                    className="sv-palette__item"
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => { router.push(result.href); setOpen(false); }}>
                  <span>{result.label}</span>
                  <span className="sv-palette__hint">{result.hint}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

const COMMANDS: Result[] = [
  { id: 'cmd-cases', label: 'Go to cases', hint: 'Command', href: '/cases' },
  { id: 'cmd-tasks', label: 'Go to tasks', hint: 'Command', href: '/tasks' },
  { id: 'cmd-approvals', label: 'Go to approvals', hint: 'Command', href: '/approvals' },
  { id: 'cmd-compliance', label: 'Go to compliance', hint: 'Command', href: '/compliance' },
  { id: 'cmd-analytics', label: 'Go to analytics', hint: 'Command', href: '/analytics' },
  { id: 'cmd-workflows', label: 'Go to workflows', hint: 'Command', href: '/workflows' },
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}
