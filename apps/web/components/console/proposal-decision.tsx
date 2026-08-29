'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export interface ProposalView {
  id: string;
  proposalType: string;
  targetTable: string;
  targetField: string | null;
  currentValue: unknown;
  proposedValue: unknown;
  reasoning: string;
  confidence: number | null;
  touchesRegulatedField: boolean;
}

/** A vulnerability signal, as the capability returns it. */
interface Signal {
  driver?: string;
  signal?: string;
  evidenceQuote?: string;
  strength?: string;
  suggestedApproach?: string;
}

function asSignal(proposal: ProposalView): Signal | null {
  if (proposal.proposalType !== 'vulnerability-consideration') return null;
  const value = proposal.proposedValue;
  return value && typeof value === 'object' ? value as Signal : null;
}

/**
 * The decision control for an AI suggestion.
 *
 * Four deliberate choices in this component. Accept is not the primary action -
 * it sits alongside modify and reject, because a control that makes agreeing
 * the path of least resistance produces agreement rather than judgement.
 * Rejecting requires a reason, so the pattern can be reviewed later. A
 * suggestion touching regulated information is visually distinct, so it never
 * looks like ordinary housekeeping.
 *
 * And a vulnerability signal is rendered as what it is rather than as a value
 * change. The client's own words are the thing an adviser judges it by, and
 * they were previously reaching the screen inside a JSON blob. Where the
 * consent to hold health information is not on file, the accept button is
 * replaced by what to do about it - discovered before the click rather than as
 * a refusal after it.
 */
export function ProposalDecision({ caseId, proposal, consentOnFile = true }: {
  caseId: string;
  proposal: ProposalView;
  /** Only meaningful for a vulnerability signal; ignored elsewhere. */
  consentOnFile?: boolean;
}) {
  const [mode, setMode] = useState<'idle' | 'modify' | 'reject'>('idle');
  const [value, setValue] = useState(String(proposal.proposedValue ?? ''));
  const [driver, setDriver] = useState(
    (proposal.proposedValue as { driver?: string } | null)?.driver ?? 'life-event');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const signal = asSignal(proposal);
  // Health is Article 9 data. Without a consent naming a condition it cannot be
  // written down, so accepting is not offered rather than offered and refused.
  const blocked = Boolean(signal) && signal!.driver === 'health' && !consentOnFile;

  function decide(decision: 'accepted' | 'modified' | 'rejected') {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/cases/${caseId}/proposals/${proposal.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          appliedValue: decision !== 'modified' ? undefined
            : signal ? { ...signal, driver }
            : coerce(value, proposal.proposedValue),
          note: note || undefined,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Something went wrong' }));
        setError(body.error ?? 'Something went wrong');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className={`sv-proposal${proposal.touchesRegulatedField ? ' sv-proposal--regulated' : ''}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{humanise(proposal.proposalType)}</strong>
        {proposal.touchesRegulatedField && (
          <span className="sv-regulated-mark">Affects regulated information</span>
        )}
        {proposal.confidence !== null && (
          <span className="sv-badge sv-badge--neutral">
            {Math.round(proposal.confidence * 100)}% confidence
          </span>
        )}
      </div>

      <p style={{ margin: '8px 0 0', color: 'var(--ink-muted)' }}>
        {signal?.signal ?? proposal.reasoning}
      </p>

      {signal ? (
        <>
          {signal.evidenceQuote && (
            <blockquote className="sv-proposal__quote">“{signal.evidenceQuote}”</blockquote>
          )}
          <div className="sv-proposal__values">
            <span>{humanise(signal.driver ?? 'unknown')}</span>
            {signal.strength && (
              <span style={{ color: 'var(--ink-subtle)', fontSize: 'var(--text-xs)' }}>
                {signal.strength} signal
              </span>
            )}
          </div>
          {signal.suggestedApproach && (
            <p style={{ margin: '4px 0 0', color: 'var(--ink-subtle)',
                        fontSize: 'var(--text-xs)' }}>
              {signal.suggestedApproach}
            </p>
          )}
        </>
      ) : (
        <div className="sv-proposal__values">
          <span>{format(proposal.currentValue)}</span>
          <span className="sv-proposal__arrow" aria-label="would become">→</span>
          <strong>{format(proposal.proposedValue)}</strong>
          <span style={{ color: 'var(--ink-subtle)', fontSize: 'var(--text-xs)' }}>
            {proposal.targetTable}{proposal.targetField ? `.${proposal.targetField}` : ''}
          </span>
        </div>
      )}

      {error && <p className="sv-error">{error}</p>}

      {mode === 'idle' && blocked && (
        <p className="sv-proposal__blocked" role="note">
          This is health information. It can be recorded once the client’s explicit consent to
          hold it is on file — see below. Nothing has been written down.
        </p>
      )}

      {mode === 'idle' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!blocked && (
            <button className="sv-btn sv-btn--secondary sv-btn--sm" disabled={pending}
                    onClick={() => decide('accepted')}>
              Accept as suggested
            </button>
          )}
          <button className="sv-btn sv-btn--secondary sv-btn--sm" disabled={pending}
                  onClick={() => setMode('modify')}>
            {signal ? 'Record it differently' : 'Change the value'}
          </button>
          <button className="sv-btn sv-btn--ghost sv-btn--sm" disabled={pending}
                  onClick={() => setMode('reject')}>
            Reject
          </button>
        </div>
      )}

      {mode === 'modify' && (
        <div>
          {signal ? (
            <label className="sv-field">
              <span className="sv-field__label">Record this as</span>
              <span className="sv-field__hint">
                The same disclosure often supports a life event or resilience driver, neither of
                which is health information — and that is frequently the right answer.
              </span>
              <select className="sv-input" value={driver}
                      onChange={(e) => setDriver(e.target.value)}>
                {['health', 'life-event', 'resilience', 'capability'].map((d) => (
                  <option key={d} value={d}>{humanise(d)}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="sv-field">
              <span className="sv-field__label">What are you actually applying?</span>
              <input className="sv-input" value={value}
                     onChange={(e) => setValue(e.target.value)} />
            </label>
          )}
          <label className="sv-field">
            <span className="sv-field__label">Note (optional)</span>
            <input className="sv-input" value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="What the client told you" />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="sv-btn sv-btn--primary sv-btn--sm" disabled={pending}
                    onClick={() => decide('modified')}>Apply this value</button>
            <button className="sv-btn sv-btn--ghost sv-btn--sm"
                    onClick={() => setMode('idle')}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'reject' && (
        <div>
          <label className="sv-field">
            <span className="sv-field__label">Why are you rejecting this?</span>
            <span className="sv-field__hint">
              Recorded so recurring wrong suggestions can be found and the capability improved.
            </span>
            <input className="sv-input" value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="These are genuinely different creditors" />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="sv-btn sv-btn--secondary sv-btn--sm"
                    disabled={pending || note.trim().length === 0}
                    onClick={() => decide('rejected')}>Reject</button>
            <button className="sv-btn sv-btn--ghost sv-btn--sm"
                    onClick={() => setMode('idle')}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function humanise(value: string): string {
  const words = value.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'number') {
    return `£${(value / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function coerce(input: string, like: unknown): unknown {
  if (typeof like === 'number') {
    const cleaned = input.replace(/[£,\s]/g, '');
    const asPounds = Number(cleaned);
    if (Number.isNaN(asPounds)) return input;
    // The displayed figure is in pounds; the stored one is pence.
    return Math.round(asPounds * 100);
  }
  return input;
}
