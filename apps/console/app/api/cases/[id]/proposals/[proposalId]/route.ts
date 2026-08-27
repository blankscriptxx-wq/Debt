import { NextResponse } from 'next/server';
import { decideProposal, ProposalError } from '@solvenda/ai';
import { PermissionDeniedError } from '@solvenda/auth';
import { currentSession, query } from '@/lib/session';

/**
 * Records a person's decision on an AI suggestion.
 *
 * The authorisation check lives in decideProposal, not here: a regulated
 * proposal requires `ai:accept_proposal`, which the authorisation engine grants
 * only to an authenticated person with a satisfied second factor. This route is
 * a thin edge over that.
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
    const outcome = await query(session, (db) =>
      decideProposal(db, session.context, session.principal, {
        proposalId,
        decision: body.decision,
        appliedValue: body.appliedValue,
        note: body.note,
      }));
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ProposalError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Could not record that decision' }, { status: 500 });
  }
}
