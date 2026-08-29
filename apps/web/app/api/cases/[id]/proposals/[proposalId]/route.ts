import { NextResponse } from 'next/server';
import { ProposalError } from '@solvenda/ai';
import { PermissionDeniedError } from '@solvenda/auth';
import { ConsentRequiredError } from '@solvenda/core';
import { currentSession } from '@/lib/console/session';
import { decideAndApply } from '@/lib/console/apply-proposal';

/**
 * Records a person's decision on an AI suggestion, and carries it out.
 *
 * The authorisation check lives in decideProposal, not here: a regulated
 * proposal requires `ai:accept_proposal`, which the authorisation engine grants
 * only to an authenticated person with a satisfied second factor. This route is
 * a thin edge over that.
 *
 * A 409 is not a failure. It means the decision was not recorded *because* it
 * could not be carried out — health information without a consent permitting it
 * — and the suggestion is still there to decide once it can be.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; proposalId: string }> },
) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { proposalId } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.decision !== 'string') {
    return NextResponse.json({ error: 'A decision is required' }, { status: 400 });
  }

  try {
    const outcome = await decideAndApply(session, proposalId, {
      decision: body.decision,
      appliedValue: body.appliedValue,
      note: body.note,
      consentId: body.consentId ?? null,
      severity: body.severity,
      detail: body.detail ?? null,
      supportNeeds: Array.isArray(body.supportNeeds) ? body.supportNeeds : undefined,
    });

    if (outcome.applied === false && outcome.needs === 'consent') {
      return NextResponse.json({
        error: outcome.because, needs: 'consent',
        clientId: outcome.clientId, driver: outcome.driver,
      }, { status: 409 });
    }
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ConsentRequiredError) {
      return NextResponse.json({ error: error.message, needs: 'consent' }, { status: 409 });
    }
    if (error instanceof ProposalError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Could not record that decision' }, { status: 500 });
  }
}
