import type { Metadata } from 'next';
import { Claim, HonestSection } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Case Intelligence',
  description: 'Understand a case in seconds: health, advice readiness, what is missing, what to do next, and what changed — each traceable to source records.',
};

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Case Intelligence</p>
          <h1>Understand a case in seconds, not screens</h1>
          <p>An adviser opening a file should not have to reconstruct it. Case Intelligence composes what matters now — and names the records behind every element, so a number an adviser cannot take apart is a number they will stop trusting.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Computed from the record, not inferred</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Case health, advice readiness, missing information, next best action, affordability change, declared-versus-observed discrepancies, vulnerability, compliance risk, engagement, deadlines and payment issues are all computed from the case itself. The AI narrative sits on top and is labelled; if no model is configured, everything else is still there.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Vulnerability never lowers a case health score</h2>
          <p style={{ color: 'var(--ink-muted)' }}>It raises an urgent signal and surfaces the recorded support needs, but it does not make the case look unhealthy. Ranking cases by their clients’ difficulties would be exactly the wrong instinct to build into an operational queue.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>A divergence is a question, not a finding</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Where bank data and the declared statement differ materially, the platform writes the question for the adviser to put to the client. Irregular income, cash spending, a second account and a simple error look identical in the data, and a system that concludes rather than asks will be wrong in front of a client.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>The AI layer, in detail</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Each capability declares the case fields it may see; the payload is assembled from that allowlist and nothing else reaches the model. Free text is additionally scrubbed of NI numbers, card numbers, sort codes, emails and phone numbers. The invocation ledger stores which records were provided rather than a second copy of the data, with the model, prompt version, cost, and what the adviser did with the output.</p>
        </div>
      </section>


      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection title='Where the AI stops' items={['No automated principal can record a regulated decision, accept a proposal affecting regulated information, or issue advice. This is enforced in the authorisation engine and tested against every regulated permission in the catalogue.', 'Absent a configured model, capabilities fall back to a deterministic provider and output is labelled as simulated. The safety model behaves identically either way.', 'Call transcription, voice analysis and full QA sampling are specified but not connected to a live telephony provider.']} />
        </div>
      </section>
    </>
  );
}
