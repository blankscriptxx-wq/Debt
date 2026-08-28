import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { recordEnquiry, throttle, enquirySchema, ENQUIRY_TYPES } from '@solvenda/core';
import { HonestSection } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Talk to us',
  description:
    'Get in touch about Solvenda: a demo, pricing, migration from an existing system, or a security and due-diligence review.',
};

const TYPE_LABELS: Record<(typeof ENQUIRY_TYPES)[number], string> = {
  general: 'Something else',
  demo: 'See the platform',
  pricing: 'Pricing and commercial terms',
  migration: 'Moving from an existing system',
  security: 'Security and due diligence',
  partnership: 'Partnership or integration',
  press: 'Press',
};

/**
 * The form actually writes to the database.
 *
 * It would have been easier to render a form that posts nowhere and show a
 * thank-you message. That is the exact class of thing this project treats as
 * not built: an interface that looks finished and does nothing. The write goes
 * through the unauthenticated database path, which holds INSERT on one table
 * and no other privilege at all.
 */
async function submit(form: FormData): Promise<void> {
  'use server';

  // A field a person never sees and a crawler fills in anyway.
  if (String(form.get('company_website') ?? '') !== '') redirect('/contact?sent=1');

  const head = await headers();
  const ip = head.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!throttle(`enquiry:${ip}`)) {
    redirect(fail('Too many enquiries from this connection in the last hour. Try again later.'));
  }

  const parsed = enquirySchema.safeParse({
    name: form.get('name'),
    organisation: form.get('organisation') ?? '',
    email: form.get('email'),
    message: form.get('message'),
    enquiryType: form.get('enquiryType') ?? 'general',
    sourcePath: '/contact',
  });
  if (!parsed.success) {
    redirect(fail(parsed.error.issues[0]?.message ?? 'Check the form and try again.'));
  }

  try {
    await recordEnquiry(parsed.data);
  } catch (error) {
    // Do not swallow this into a cheerful thank-you. If the write failed, the
    // person needs to know their message did not arrive.
    console.error('enquiry write failed', error);
    redirect(fail('We could not record that. Please try again shortly.'));
  }
  redirect('/contact?sent=1');
}

function fail(message: string): string {
  return `/contact?error=${encodeURIComponent(message)}`;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sent = params['sent'] === '1';
  const error = typeof params['error'] === 'string' ? params['error'] : null;

  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Talk to us</p>
          <h1>Tell us what you are trying to fix</h1>
          <p>
            The most useful first conversation is usually about the part of your current process
            that costs the most time and produces the least evidence. Say what that is and we can
            be specific rather than general.
          </p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          {sent ? (
            <div className="mk-honest">
              <h3>Received</h3>
              <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
                Your enquiry has been recorded and will be picked up by a person. Nothing about it
                is automated, and nothing was sent to a third party to handle it.
              </p>
            </div>
          ) : (
            <form action={submit} className="mk-form">
              {error ? (
                <p role="alert" className="mk-form__error">
                  {error}
                </p>
              ) : null}

              <label htmlFor="name">Your name</label>
              <input id="name" name="name" required maxLength={200} autoComplete="name" />

              <label htmlFor="organisation">Firm</label>
              <input
                id="organisation"
                name="organisation"
                maxLength={200}
                autoComplete="organization"
              />

              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                required
                maxLength={320}
                autoComplete="email"
              />

              <label htmlFor="enquiryType">What is this about</label>
              <select id="enquiryType" name="enquiryType" defaultValue="demo">
                {ENQUIRY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>

              <label htmlFor="message">Message</label>
              <textarea id="message" name="message" required rows={6} maxLength={5000} />

              {/* Not shown to anyone using the page; filled in by crawlers. */}
              <div className="mk-honeypot" aria-hidden="true">
                <label htmlFor="company_website">Company website</label>
                <input id="company_website" name="company_website" tabIndex={-1} autoComplete="off" />
              </div>

              <button type="submit" className="mk-btn mk-btn--primary">
                Send enquiry
              </button>
              <p className="mk-form__note">
                We keep your name, firm, email and message so we can reply, and nothing else. No
                tracking pixels, no advertising tags, no analytics scripts on this site.
              </p>
            </form>
          )}
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <h2>What to expect</h2>
          <div className="mk-contact">
            <div className="mk-contact__block">
              <h3>A demonstration</h3>
              <p>
                Run against seeded cases that are deliberately awkward — a deficit budget, an
                overdue review, a client who has never replied, a recorded vulnerability. Software
                looks good on an easy case.
              </p>
            </div>
            <div className="mk-contact__block">
              <h3>Due diligence</h3>
              <p>
                We would rather answer the hard questions early: how tenant isolation is enforced,
                what the AI can and cannot write, where data sits, and what has not been built
                yet. The last of those is on every page of this site.
              </p>
            </div>
            <div className="mk-contact__block">
              <h3>A migration conversation</h3>
              <p>
                Bring an export, or a description of the source system. We can tell you what maps
                cleanly, what needs a decision, and what will not survive the move — before anyone
                signs anything.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection
            title="About this form"
            items={[
              'It writes to the platform database. It is not a mock, and it does not post to a third-party form service.',
              'Solvenda has no published telephone number or postal address yet, and no registered domain for email, so this form is the only route. We would rather say that than print an address that bounces.',
              'The rate limit on this page is in-process, so it does not survive a restart or coordinate across instances. A public deployment needs an edge rate limit in front of it — that is recorded as a production-readiness item, not quietly assumed.',
              'Enquiries are readable only by a platform operator holding a live access grant, under the same audit as every other operator action.',
            ]}
          />
        </div>
      </section>
    </>
  );
}
