import Link from 'next/link';
import { requireClient, query } from '@/lib/session';
import { loadClientCase } from '@/lib/data';
import { ClientShell } from '@/components/shell';

export const dynamic = 'force-dynamic';

function money(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
}

export default async function ProgressPage() {
  const session = await requireClient();
  const view = await query(session, (db) => loadClientCase(db, session.clientId));

  return (
    <ClientShell firmName={session.firmName} firstName={session.firstName} current="progress">
      <h1 className="cp-h1">Hello {session.firstName}</h1>

      {!view ? (
        <p className="cp-lede">
          We do not have an open case for you at the moment. If you think that is wrong,
          send us a message and we will look into it.
        </p>
      ) : (
        <>
          <p className="cp-lede">
            Here is where things stand with your {view.caseTypeName.toLowerCase()}. Your
            reference is <strong>{view.reference}</strong>
            {view.adviserName ? <>, and {view.adviserName} is looking after it.</> : '.'}
          </p>

          {view.outstanding.length > 0 && (
            <div className="cp-card cp-card--action">
              <h2 className="cp-card__title">
                {view.outstanding.length === 1
                  ? 'There is one thing we still need'
                  : `There are ${view.outstanding.length} things we still need`}
              </h2>
              <ul style={{ margin: '0 0 var(--space-4)', paddingLeft: '1.2rem' }}>
                {view.outstanding.map((item) => (
                  <li key={item.key} style={{ marginBottom: 'var(--space-2)' }}>
                    <strong>{item.label}.</strong>{' '}
                    {item.description && (
                      <span style={{ color: 'var(--ink-muted)' }}>{item.description}</span>
                    )}
                  </li>
                ))}
              </ul>
              <Link className="cp-btn cp-btn--primary" href="/documents">
                Send us what you have
              </Link>
            </div>
          )}

          {view.otherOpenCases.length > 0 && (
            <div className="cp-card">
              <h2 className="cp-card__title">
                {view.otherOpenCases.length === 1
                  ? 'You have another case open too'
                  : 'You have other cases open too'}
              </h2>
              <p style={{ color: 'var(--ink-muted)', marginTop: 0 }}>
                This page shows your most recent one in full. Send us a message if you want an
                update on any of these.
              </p>
              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {view.otherOpenCases.map((other) => (
                  <li key={other.caseId} style={{ marginBottom: 'var(--space-2)' }}>
                    <strong>{other.caseTypeName}</strong> — {other.reference}, currently at{' '}
                    {other.stageName.toLowerCase()}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2 className="cp-card__title" style={{ marginBottom: 'var(--space-4)' }}>
            Your progress
          </h2>
          <ol className="cp-progress">
            {view.steps.map((step, index) => (
              <li key={step.key} className={`cp-step cp-step--${step.state}`}>
                <span className="cp-step__dot" aria-hidden="true">
                  {step.state === 'done' ? '✓' : index + 1}
                </span>
                <div>
                  <p className="cp-step__title">
                    {step.name}
                    {step.state === 'current' && (
                      <span style={{ color: 'var(--accent)', fontWeight: 500 }}> — where you are now</span>
                    )}
                  </p>
                  {step.description && <p className="cp-step__detail">{step.description}</p>}
                </div>
              </li>
            ))}
          </ol>

          <div className="cp-card">
            <h2 className="cp-card__title">Your figures</h2>
            <div className="cp-figure">
              <span className="cp-figure__label">Total you owe</span>
              <span className="cp-figure__value">{money(view.totalDebtPence)}</span>
            </div>
            {view.monthlyPaymentPence !== null && (
              <div className="cp-figure">
                <span className="cp-figure__label">Monthly payment</span>
                <span className="cp-figure__value">{money(view.monthlyPaymentPence)}</span>
              </div>
            )}
            {view.nextReviewDue && (
              <div className="cp-figure">
                <span className="cp-figure__label">Next review</span>
                <span className="cp-figure__value">
                  {/* A date already past reads as an error to a client. Say what
                      is actually happening instead. */}
                  {new Date(view.nextReviewDue) < new Date()
                    ? 'Due now'
                    : new Date(view.nextReviewDue).toLocaleDateString('en-GB',
                        { day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
              </div>
            )}
          </div>

          {view.nextReviewDue && new Date(view.nextReviewDue) < new Date() && (
            <div className="cp-card">
              <h2 className="cp-card__title">Your review is due</h2>
              <p style={{ margin: 0, lineHeight: 'var(--leading-relaxed)' }}>
                We check in once a year to make sure your payment is still right for you. If
                anything has changed - your income, your costs, your household - tell us and we
                will look at it again. Nothing bad happens because a review is late.
              </p>
            </div>
          )}

          <div className="cp-card">
            <h2 className="cp-card__title">What a {view.caseTypeName.toLowerCase()} means</h2>
            <p style={{ margin: 0, lineHeight: 'var(--leading-relaxed)' }}>
              {view.caseTypeExplanation}
            </p>
            <p style={{ marginBottom: 0, color: 'var(--ink-muted)' }}>
              If anything here is unclear, ask us. There is no such thing as a silly question
              about your own money.
            </p>
          </div>
        </>
      )}
    </ClientShell>
  );
}
