import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';

/**
 * The diary.
 *
 * Outcomes are recorded rather than rows deleted. A missed appointment is an
 * engagement signal, and a repeatedly missed one may be a vulnerability
 * indicator under FG21/1 — a client whose circumstances have deteriorated
 * often stops turning up before they say anything. Deleting the row loses
 * exactly the pattern that matters.
 */

export interface AppointmentInput {
  caseId?: string | null;
  clientId: string;
  adviserId?: string | null;
  purpose?: 'fact-find' | 'advice' | 'review' | 'signing' | 'follow-up' | 'callback' | 'other';
  channel?: 'call' | 'video' | 'in-person' | 'home-visit';
  scheduledFor: string;
  durationMinutes?: number;
}

export interface Appointment extends AppointmentInput {
  id: string;
  purpose: NonNullable<AppointmentInput['purpose']>;
  channel: NonNullable<AppointmentInput['channel']>;
  durationMinutes: number;
  status: 'scheduled' | 'completed' | 'no-show' | 'cancelled' | 'rescheduled';
  outcomeNote: string | null;
  adviserName: string | null;
}

export class AppointmentValidationError extends Error {}

export async function listAppointments(
  db: Database, caseId: string,
): Promise<Appointment[]> {
  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT a.id, a.case_id, a.client_id, a.adviser_id, a.purpose, a.channel,
           a.scheduled_for::text, a.duration_minutes::text, a.status,
           a.outcome_note, u.full_name AS adviser_name
      FROM appointments a
      LEFT JOIN users u ON u.id = a.adviser_id
     WHERE a.case_id = ${caseId}
     ORDER BY a.scheduled_for DESC`);
  return res.rows.map((r) => ({
    id: r['id']!, caseId: r['case_id'] ?? null, clientId: r['client_id']!,
    adviserId: r['adviser_id'] ?? null,
    purpose: r['purpose'] as Appointment['purpose'],
    channel: r['channel'] as Appointment['channel'],
    scheduledFor: r['scheduled_for']!,
    durationMinutes: Number(r['duration_minutes']),
    status: r['status'] as Appointment['status'],
    outcomeNote: r['outcome_note'] ?? null,
    adviserName: r['adviser_name'] ?? null,
  }));
}

export async function scheduleAppointment(
  db: Database, ctx: TenantContext, principal: Principal, input: AppointmentInput,
): Promise<string> {
  requirePermission(principal, 'case:write');
  if (Number.isNaN(Date.parse(input.scheduledFor))) {
    throw new AppointmentValidationError('That is not a valid date and time.');
  }

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO appointments
      (case_id, client_id, adviser_id, purpose, channel, scheduled_for,
       duration_minutes, created_by)
    VALUES (${input.caseId ?? null}, ${input.clientId}, ${input.adviserId ?? null},
            ${input.purpose ?? 'fact-find'}, ${input.channel ?? 'call'},
            ${input.scheduledFor}, ${input.durationMinutes ?? 30},
            ${ctx.userId ?? null})
    RETURNING id`);
  const id = res.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'appointment.scheduled',
    resourceType: 'appointment',
    resourceId: id,
    caseId: input.caseId ?? null,
    reason: `${input.purpose ?? 'fact-find'} by ${input.channel ?? 'call'}`,
    source: 'console',
    after: { ...input } as Record<string, unknown>,
  });
  return id;
}

export async function recordOutcome(
  db: Database, ctx: TenantContext, principal: Principal,
  id: string,
  status: 'completed' | 'no-show' | 'cancelled',
  note: string,
): Promise<void> {
  requirePermission(principal, 'case:write');
  if (status !== 'completed' && !note.trim()) {
    throw new AppointmentValidationError(
      'A missed or cancelled appointment needs a note: it is an engagement signal, '
      + 'and the reason is what makes it readable later.',
    );
  }

  const before = await db.execute(sql`SELECT * FROM appointments WHERE id = ${id}`);
  await db.execute(sql`
    UPDATE appointments
       SET status = ${status},
           outcome_note = ${note || null},
           cancelled_reason = ${status === 'cancelled' ? note : null}
     WHERE id = ${id}`);

  await recordAudit(db, ctx, {
    action: status === 'cancelled' ? 'appointment.cancelled' : 'appointment.outcome.recorded',
    resourceType: 'appointment',
    resourceId: id,
    reason: note || status,
    source: 'console',
    before: (before.rows[0] ?? null) as Record<string, unknown> | null,
    after: { status, outcomeNote: note },
  });
}
