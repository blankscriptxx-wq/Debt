import type { Metadata } from 'next';
import { Claim, HonestSection } from '@/components/marketing/layout';

export const metadata: Metadata = {
  title: 'Integrations',
  description: 'An adapter framework with per-firm installs, encrypted credentials, and a recorded call log for every third-party request.',
};

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Integrations</p>
          <h1>A framework, not a folder of vendors</h1>
          <p>A category defines what the platform needs; a provider implements it; you install the one you have a contract with. Changing your Open Banking supplier should be your configuration change, not our release.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Every call is recorded</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Operation, request summary, outcome and duration, per firm and per case. When a client asks what was sent about them to a credit reference agency, there is an answer. Credit searches are soft only: a hard search leaves a footprint on the client’s file and is never appropriate for debt advice.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Credentials never sit in a column</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Secrets are encrypted with a per-tenant key. The audit entry records which secrets were supplied by name and never their values. A database dump without the master key yields ciphertext.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Categories the framework covers</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Open Banking (account information and payment initiation), credit reference, identity verification and AML, e-signature, payments including mandates, email, SMS, WhatsApp, telephony, accounting, document storage, creditor data, insolvency service submissions and Companies House.</p>
        </div>
      </section>


      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection title='The important caveat' items={['Every provider shipped today is a sandbox simulator. No live vendor credentials exist, and the product labels each simulated call — on the provider record, on the install and on every recorded call.', 'The simulators validate input and can fail, so the code around them is genuinely exercised. But they do not talk to anyone.', 'Connecting a real provider means implementing the adapter interface and holding a commercial relationship with that vendor. We can do that work; we have not done it yet.']} />
        </div>
      </section>
    </>
  );
}
