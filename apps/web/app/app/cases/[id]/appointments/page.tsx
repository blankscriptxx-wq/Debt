import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, listAppointments } from '@/lib/console/case-file';
import { scheduleAppointment, recordOutcome, AppointmentValidationError } from '@solvenda/core';
import {
  Badge, Card, DataTable, EmptyState, Field, Form, Grid, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const PURPOSES = ['fact-find', 'advice', 'review', 'signing', 'follow-up', 'callback', 'other'];
const CHANNELS = ['call', 'video', 'in-person', 'home-visit'];

const sentence = (v: string) => v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

const TONE: Record<string, 'positive' | 'attention' | 'critical' | 'neutral'> = {
  scheduled: 'neutral', completed: 'positive',
  'no-show': 'critical', cancelled: 'attention', rescheduled: 'neutral',
};

/**
 * The diary.
 *
 * Outcomes are recorded, never deleted. A missed appointment is an engagement
 * signal, and a pattern of them may be a vulnerability indicator — someone
 * whose circumstances have deteriorated often stops turning up before they say
 * anything. Removing the row loses exactly the pattern worth seeing.
 */
export default async function AppointmentsTab({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { saved, error } = await searchParams;

  const header = await query(session, (db) => loadCaseFileHeader(db, id));
  if (!header) redirect('/app/cases');
  const appointments = await query(session, (db) => listAppointments(db, id));

  const scheduled = appointments.filter((a) => a.status === 'scheduled').length;
  const missed = appointments.filter((a) => a.status === 'no-show').length;
  const next = appointments
    .filter((a) => a.status === 'scheduled' && new Date(a.scheduledFor) > new Date())
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];

  async function book(formData: FormData) {
    'use server';
    const active = await requireSession();
    try {
      await query(active, (db) => scheduleAppointment(db, active.context, active.principal, {
        caseId: header!.caseId,
        clientId: header!.clientId,
        adviserId: active.user.id,
        purpose: String(formData.get('purpose') ?? 'fact-find') as never,
        channel: String(formData.get('channel') ?? 'call') as never,
        scheduledFor: String(formData.get('scheduledFor') ?? ''),
        durationMinutes: Number(formData.get('duration') ?? 30),
      }));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof AppointmentValidationError
        ? cause.message : 'Could not book that appointment.';
      redirect(`/app/cases/${id}/appointments?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/appointments?saved=1`);
  }

  async function outcome(formData: FormData) {
    'use server';
    const active = await requireSession();
    try {
      await query(active, (db) => recordOutcome(db, active.context, active.principal,
        String(formData.get('appointmentId') ?? ''),
        String(formData.get('status') ?? 'completed') as never,
        String(formData.get('note') ?? '')));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof AppointmentValidationError
        ? cause.message : 'Could not record that outcome.';
      redirect(`/app/cases/${id}/appointments?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/appointments?saved=1`);
  }

  return (
    <Stack gap={5}>
      <Card title="Appointments" subtitle="Outcomes are recorded rather than rows deleted.">
        <DataTable
          rows={appointments}
          getKey={(a) => a.id}
          empty={<EmptyState title="Nothing booked."
                             detail="A fact-find appointment is usually the first thing on a new case." />}
          columns={[
            {
              key: 'when', header: 'When',
              render: (a) => new Date(a.scheduledFor).toLocaleString('en-GB', {
                dateStyle: 'medium', timeStyle: 'short',
              }),
            },
            { key: 'purpose', header: 'Purpose', render: (a) => sentence(a.purpose) },
            { key: 'channel', header: 'Channel', render: (a) => sentence(a.channel) },
            { key: 'adviser', header: 'Adviser', render: (a) => a.adviserName ?? '—' },
            {
              key: 'status', header: 'Status',
              render: (a) => <Badge tone={TONE[a.status] ?? 'neutral'}>{sentence(a.status)}</Badge>,
            },
            {
              key: 'note', header: 'Outcome',
              render: (a) => <span className="sv-muted">{a.outcomeNote ?? '—'}</span>,
            },
            {
              key: 'record', header: '',
              render: (a) => (a.status !== 'scheduled' ? null : (
                <form action={outcome} className="sv-inline-form">
                  <input type="hidden" name="appointmentId" value={a.id} />
                  <select className="sv-input sv-input--sm" name="status" aria-label="Outcome">
                    <option value="completed">Completed</option>
                    <option value="no-show">No show</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <input className="sv-input sv-input--sm" name="note"
                         placeholder="Note" aria-label="Outcome note" />
                  <button type="submit" className="sv-btn sv-btn--primary sv-btn--sm">
                    Record
                  </button>
                </form>
              )),
            },
          ]}
        />
      </Card>

      <Card title="Book an appointment">
        <Form action={book} submitLabel="Book"
              result={saved ? { ok: true, message: 'Diary updated.' }
                    : error ? { ok: false, message: error } : null}>
          <Grid min="220px">
            <Field label="Date and time" required>
              <input className="sv-input" name="scheduledFor" type="datetime-local" required />
            </Field>
            <Field label="Purpose" required>
              <select className="sv-input" name="purpose" defaultValue="fact-find">
                {PURPOSES.map((p) => <option key={p} value={p}>{sentence(p)}</option>)}
              </select>
            </Field>
            <Field label="Channel" required>
              <select className="sv-input" name="channel" defaultValue="call">
                {CHANNELS.map((c) => <option key={c} value={c}>{sentence(c)}</option>)}
              </select>
            </Field>
            <Field label="Minutes">
              <input className="sv-input" name="duration" type="number"
                     min="5" step="5" defaultValue="30" />
            </Field>
          </Grid>
        </Form>
      </Card>

      <SummaryBar figures={[
        { label: 'Scheduled', value: scheduled, tone: 'accent' },
        {
          label: 'Next',
          value: next ? new Date(next.scheduledFor).toLocaleDateString('en-GB') : '—',
          detail: next ? sentence(next.purpose) : 'Nothing booked',
        },
        {
          label: 'Missed', value: missed, tone: missed ? 'critical' : 'neutral',
          detail: missed > 1 ? 'A pattern worth asking about' : undefined,
        },
      ]} />
    </Stack>
  );
}
