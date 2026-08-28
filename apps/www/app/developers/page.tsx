import type { Metadata } from 'next';
import { Claim, HonestSection } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Developer platform',
  description: 'A versioned REST API, scoped keys, signed webhooks and a published OpenAPI description.',
};

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Developers</p>
          <h1>Build on it</h1>
          <p>A versioned REST API with cursor pagination, scoped API keys, rate limiting, signed webhooks and a generated OpenAPI description.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Keys carry permission scopes</h2>
          <p style={{ color: 'var(--ink-muted)' }}>And cannot carry a regulated one. The authorisation engine would refuse it at use, but key creation rejects it too — so the mistake surfaces while someone is looking at it rather than at three in the morning. The OpenAPI description publishes that list, so you can see what no key will ever do before you build against it.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Webhooks you can verify</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Deliveries are signed over a timestamp, so a receiver can prove a payload came from us and that it has not been replayed. Failures back off exponentially and an endpoint that keeps failing is disabled rather than retried into a dead URL forever.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Events you can poll</h2>
          <p style={{ color: 'var(--ink-muted)' }}>The same events webhooks deliver are available on an endpoint, for integrators who cannot receive one or who have missed some. Nobody should have to ask us to replay.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Money is integer pence</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Everywhere, in every payload, without exception. No decimals, no floats, no ambiguity about what 12.345 means.</p>
        </div>
      </section>


      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection title='Not yet built' items={['A hosted sandbox environment with seeded data. Keys carry a sandbox or live flag; the separate environment does not exist yet.', 'Published client libraries. The API is plain REST and the OpenAPI description is machine-readable, so generating one is straightforward.', 'Write endpoints beyond clients and cases. Regulated records are deliberately not writable through the API at all.']} />
        </div>
      </section>
    </>
  );
}
