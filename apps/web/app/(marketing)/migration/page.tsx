import type { Metadata } from 'next';
import { Claim, HonestSection } from '@/components/marketing/layout';

export const metadata: Metadata = {
  title: 'Migration',
  description: 'Dry runs that write nothing, reconciliation that counts what did not come across, and a report naming every unmapped field.',
};

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Migration</p>
          <h1>The reason firms stay where they are</h1>
          <p>It is rarely the software. It is fifteen years of case history in a system you cannot leave. A migration that loses a note, a consent record or a historic advice decision is not a migration, it is a compliance incident.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Dry run until the report is clean</h2>
          <p style={{ color: 'var(--ink-muted)' }}>A dry run writes nothing and produces the same report as a live run. You iterate on the mapping until it comes back clean, before anything touches your data.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Every record produces a row</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Including the ones skipped and the ones that failed, each with a reason. A migration that quietly drops 300 notes looks identical to one that migrated everything, unless the skipped records are counted.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Unmapped fields are named</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Data loss in a migration is almost never a crash; it is a column nobody mapped. The report lists every source field that carried no data into the platform.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Reconciliation answers the real question</h2>
          <p style={{ color: 'var(--ink-muted)' }}>"Did everything come across" is answered by counting what did not. You supply the source counts, and the reconciliation shows migrated, skipped and failed per entity, and whether they add up.</p>
        </div>
      </section>


      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection title='About the profiles' items={['The shipped migration profile is an informed guess at the shape of an export, not a certified connector. We have not seen an export from any incumbent system.', 'Column names will differ and the mapping is edited against your real extract.', 'Consent records rarely survive a CSV export intact — and consent is exactly what a file review asks about. Plan for re-papering rather than assuming.']} />
        </div>
      </section>
    </>
  );
}
