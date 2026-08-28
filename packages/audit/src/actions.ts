/**
 * The vocabulary of auditable actions.
 *
 * Keeping this as a closed set (rather than free-text strings scattered through
 * the codebase) is what makes compliance reporting, QA sampling and retention
 * rules possible: a supervisor can ask "show me every advice decision recorded
 * by this adviser last month" and get a complete answer.
 */
export const AUDIT_ACTIONS = {
  // access and identity
  'auth.login.succeeded': { severity: 'notable' },
  'auth.login.failed': { severity: 'security' },
  'auth.login.locked': { severity: 'security' },
  'auth.mfa.enrolled': { severity: 'security' },
  'auth.mfa.failed': { severity: 'security' },
  'auth.session.revoked': { severity: 'security' },
  'auth.password.changed': { severity: 'security' },
  'access.role.granted': { severity: 'security' },
  'access.role.revoked': { severity: 'security' },
  'access.permission.denied': { severity: 'security' },
  'platform.impersonation.started': { severity: 'security' },
  'platform.impersonation.ended': { severity: 'security' },
  // Operator sign-in is tracked separately from tenant sign-in because the
  // blast radius differs: an operator reaches configuration for every firm.
  'platform.login.succeeded': { severity: 'notable' },
  'platform.login.failed': { severity: 'security' },
  'platform.login.locked': { severity: 'security' },
  'platform.session.revoked': { severity: 'security' },

  // client and case lifecycle
  'client.created': { severity: 'notable' },
  'client.updated': { severity: 'info' },
  'client.viewed': { severity: 'info' },
  'case.created': { severity: 'notable' },
  'case.stage.changed': { severity: 'notable' },
  'case.closed': { severity: 'notable' },
  'case.reopened': { severity: 'notable' },

  // regulated substance
  'consent.captured': { severity: 'regulated' },
  'consent.withdrawn': { severity: 'regulated' },
  'vulnerability.recorded': { severity: 'regulated' },
  'vulnerability.updated': { severity: 'regulated' },
  'sfs.statement.created': { severity: 'regulated' },
  'sfs.statement.superseded': { severity: 'regulated' },
  'debt.created': { severity: 'notable' },
  'debt.updated': { severity: 'notable' },
  'debt.removed': { severity: 'notable' },

  // The case file. Household composition and assets are notable rather than
  // info because both change what the client is eligible for: household size
  // bands the SFS trigger figures, and asset value decides whether a DRO is
  // available at all.
  'household.member.recorded': { severity: 'notable' },
  'household.member.removed': { severity: 'notable' },
  'employment.recorded': { severity: 'notable' },
  'employment.updated': { severity: 'info' },
  'asset.recorded': { severity: 'notable' },
  'asset.updated': { severity: 'notable' },
  'asset.removed': { severity: 'notable' },
  'appointment.scheduled': { severity: 'info' },
  'appointment.outcome.recorded': { severity: 'info' },
  'appointment.cancelled': { severity: 'info' },
  'verification.recorded': { severity: 'notable' },
  // A waived check is someone deciding evidence is not needed. That is a
  // compliance decision and is recorded as one.
  'verification.waived': { severity: 'security' },
  'affordability.assessed': { severity: 'regulated' },
  'eligibility.evaluated': { severity: 'regulated' },
  'advice.recommendation.generated': { severity: 'regulated' },
  'advice.decision.recorded': { severity: 'regulated' },
  'advice.decision.superseded': { severity: 'regulated' },
  'compliance.check.run': { severity: 'regulated' },
  'compliance.check.overridden': { severity: 'regulated' },

  // AI
  'ai.invocation.requested': { severity: 'info' },
  'ai.invocation.completed': { severity: 'info' },
  'ai.proposal.created': { severity: 'notable' },
  'ai.proposal.accepted': { severity: 'regulated' },
  'ai.proposal.modified': { severity: 'regulated' },
  'ai.proposal.rejected': { severity: 'notable' },

  // communications
  'comms.message.sent': { severity: 'notable' },
  'comms.message.received': { severity: 'info' },
  'comms.call.recorded': { severity: 'regulated' },
  'comms.note.added': { severity: 'info' },

  // documents
  'document.uploaded': { severity: 'notable' },
  'document.viewed': { severity: 'info' },
  'document.signed': { severity: 'regulated' },
  'document.deleted': { severity: 'security' },

  // workflow and automation
  'workflow.run.started': { severity: 'info' },
  'workflow.run.completed': { severity: 'info' },
  'workflow.run.failed': { severity: 'notable' },
  'workflow.approval.requested': { severity: 'notable' },
  'workflow.approval.decided': { severity: 'regulated' },

  // data protection
  'data.exported': { severity: 'security' },
  'data.retention.applied': { severity: 'security' },
  'data.subject_request.raised': { severity: 'regulated' },
  'data.erased': { severity: 'security' },
} as const satisfies Record<string, { severity: AuditSeverity }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export type AuditSeverity = 'info' | 'notable' | 'regulated' | 'security';

export function defaultSeverity(action: AuditAction): AuditSeverity {
  return AUDIT_ACTIONS[action].severity;
}

/** Actions whose severity marks them as carrying regulatory weight. */
export function isRegulatedAction(action: AuditAction): boolean {
  return AUDIT_ACTIONS[action].severity === 'regulated';
}
