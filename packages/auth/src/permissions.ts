/**
 * The permission catalogue.
 *
 * `regulated: true` marks an action that carries advice or compliance weight.
 * Those permissions can only ever be exercised by an authenticated human -
 * never by an API key, a workflow step or an AI capability. That rule is
 * enforced in `authorize()` and tested; it is the mechanism that keeps
 * automation on the correct side of the line between assisting an adviser and
 * issuing regulated advice.
 *
 * `competencies` names the sign-off a person must hold in addition to the
 * permission. A firm decides who is competent; the platform records and
 * enforces the decision.
 */
export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
  regulated?: boolean;
  competencies?: string[];
}

export const PERMISSIONS = [
  // client and case access
  p('client', 'read', 'View client records'),
  p('client', 'write', 'Create and amend client records'),
  p('client', 'delete', 'Delete a client record'),
  p('case', 'read', 'View cases'),
  p('case', 'write', 'Create and amend cases'),
  p('case', 'assign', 'Assign cases to advisers'),
  p('case', 'close', 'Close a case'),

  // financial position
  p('sfs', 'read', 'View income and expenditure statements'),
  p('sfs', 'write', 'Create and amend income and expenditure statements'),
  p('debt', 'read', 'View debts and creditors'),
  p('debt', 'write', 'Create and amend debts and creditors'),

  // regulated substance
  p('advice', 'recommend', 'Produce a solution recommendation for adviser review', {
    regulated: true, competencies: ['debt-advice'],
  }),
  p('advice', 'decide', 'Record the regulated advice decision given to a client', {
    regulated: true, competencies: ['debt-advice'],
  }),
  p('advice', 'supersede', 'Supersede a previously recorded advice decision', {
    regulated: true, competencies: ['debt-advice'],
  }),
  p('compliance', 'override', 'Override a failing compliance check with a recorded rationale', {
    regulated: true, competencies: ['compliance'],
  }),
  p('vulnerability', 'read', 'View recorded vulnerability information'),
  p('vulnerability', 'write', 'Record or amend vulnerability information', { regulated: true }),
  p('consent', 'capture', 'Capture or withdraw a client consent', { regulated: true }),

  // insolvency-specific
  p('insolvency', 'propose', 'Issue a proposal to creditors', {
    regulated: true, competencies: ['insolvency'],
  }),
  p('insolvency', 'certify', 'Certify an insolvency appointment or statutory document', {
    regulated: true, competencies: ['insolvency-practitioner'],
  }),

  // documents and communications
  p('document', 'read', 'View documents'),
  p('document', 'write', 'Upload and amend documents'),
  p('document', 'send_for_signature', 'Send a document for electronic signature'),
  p('comms', 'read', 'View communications'),
  p('comms', 'send', 'Send communications to clients and third parties'),
  p('comms', 'call', 'Place and receive calls through the platform'),
  p('comms', 'recording_access', 'Listen to call recordings'),

  // automation and AI
  p('workflow', 'read', 'View workflows and their run history'),
  p('workflow', 'write', 'Create and amend workflows'),
  p('workflow', 'approve', 'Approve a workflow step awaiting human sign-off'),
  p('ai', 'invoke', 'Run AI capabilities'),
  p('ai', 'accept_proposal', 'Accept, modify or reject an AI proposal', { regulated: true }),
  p('ai', 'configure', 'Change AI capability configuration and policies'),

  // oversight
  p('qa', 'read', 'View quality assurance reviews'),
  p('qa', 'perform', 'Complete a quality assurance review', { competencies: ['qa'] }),
  p('complaint', 'read', 'View complaints'),
  p('complaint', 'write', 'Record and progress complaints'),
  p('audit', 'read', 'View the audit ledger'),
  p('report', 'read', 'View reports and dashboards'),
  p('report', 'export', 'Export data out of the platform'),

  // administration
  p('user', 'read', 'View users'),
  p('user', 'write', 'Invite, amend and suspend users'),
  p('role', 'write', 'Create roles and change permission assignments'),
  p('tenant', 'configure', 'Change firm-level configuration'),
  p('integration', 'configure', 'Enable and configure integrations'),
  p('retention', 'configure', 'Change data retention policy'),
  p('data', 'erase', 'Action an erasure request'),
] as const satisfies readonly PermissionDefinition[];

function p(
  resource: string,
  action: string,
  description: string,
  extra: { regulated?: boolean; competencies?: string[] } = {},
): PermissionDefinition {
  return { key: `${resource}:${action}`, resource, action, description, ...extra };
}

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

const BY_KEY = new Map(PERMISSIONS.map((d) => [d.key, d]));

export function permissionDefinition(key: string): PermissionDefinition | undefined {
  return BY_KEY.get(key);
}

export function isRegulatedPermission(key: string): boolean {
  return BY_KEY.get(key)?.regulated === true;
}

export function requiredCompetencies(key: string): string[] {
  return BY_KEY.get(key)?.competencies ?? [];
}

/**
 * Role templates a firm starts from. They are copied into the tenant on
 * provisioning and can then be edited; the templates themselves are read-only
 * global reference data.
 */
export const ROLE_TEMPLATES = [
  {
    key: 'adviser',
    name: 'Debt Adviser',
    description: 'Works cases end to end and records regulated advice decisions.',
    permissions: [
      'client:read', 'client:write', 'case:read', 'case:write', 'case:close',
      'sfs:read', 'sfs:write', 'debt:read', 'debt:write',
      'advice:recommend', 'advice:decide',
      'vulnerability:read', 'vulnerability:write', 'consent:capture',
      'document:read', 'document:write', 'document:send_for_signature',
      'comms:read', 'comms:send', 'comms:call',
      'ai:invoke', 'ai:accept_proposal',
      'workflow:read', 'report:read',
    ],
  },
  {
    key: 'case-administrator',
    name: 'Case Administrator',
    description: 'Progresses cases and handles administration, without giving advice.',
    permissions: [
      'client:read', 'client:write', 'case:read', 'case:write',
      'sfs:read', 'debt:read', 'debt:write',
      'vulnerability:read',
      'document:read', 'document:write', 'comms:read', 'comms:send',
      'ai:invoke', 'workflow:read', 'report:read',
    ],
  },
  {
    key: 'team-leader',
    name: 'Team Leader',
    description: 'Adviser permissions plus assignment, approvals and team reporting.',
    permissions: [
      'client:read', 'client:write', 'case:read', 'case:write', 'case:assign', 'case:close',
      'sfs:read', 'sfs:write', 'debt:read', 'debt:write',
      'advice:recommend', 'advice:decide', 'advice:supersede',
      'vulnerability:read', 'vulnerability:write', 'consent:capture',
      'document:read', 'document:write', 'document:send_for_signature',
      'comms:read', 'comms:send', 'comms:call', 'comms:recording_access',
      'ai:invoke', 'ai:accept_proposal',
      'workflow:read', 'workflow:approve', 'qa:read', 'report:read', 'user:read',
    ],
  },
  {
    key: 'compliance-officer',
    name: 'Compliance Officer',
    description: 'Oversight across the firm: QA, complaints, audit and compliance overrides.',
    permissions: [
      'client:read', 'case:read', 'sfs:read', 'debt:read',
      'vulnerability:read', 'document:read',
      'comms:read', 'comms:recording_access',
      'compliance:override', 'qa:read', 'qa:perform',
      'complaint:read', 'complaint:write',
      'audit:read', 'report:read', 'report:export',
      'workflow:read', 'workflow:approve', 'ai:configure',
      'retention:configure',
    ],
  },
  {
    key: 'insolvency-practitioner',
    name: 'Insolvency Practitioner',
    description: 'Appointment-taking practitioner: proposals and statutory certification.',
    permissions: [
      'client:read', 'case:read', 'case:write', 'case:close',
      'sfs:read', 'sfs:write', 'debt:read', 'debt:write',
      'advice:recommend', 'advice:decide',
      'insolvency:propose', 'insolvency:certify',
      'vulnerability:read', 'document:read', 'document:write',
      'document:send_for_signature', 'comms:read', 'comms:send',
      'ai:invoke', 'ai:accept_proposal', 'audit:read', 'report:read',
    ],
  },
  {
    key: 'firm-administrator',
    name: 'Firm Administrator',
    description: 'Configures the firm: users, roles, workflows, integrations, branding.',
    permissions: [
      'user:read', 'user:write', 'role:write', 'tenant:configure',
      'integration:configure', 'workflow:read', 'workflow:write',
      'ai:configure', 'report:read', 'audit:read', 'case:read', 'client:read',
    ],
  },
  {
    key: 'client',
    name: 'Client',
    description: 'The consumer, in their own portal. Sees only their own case.',
    permissions: ['case:read', 'sfs:read', 'debt:read', 'document:read', 'comms:read'],
  },
  {
    key: 'creditor',
    name: 'Creditor Contact',
    description: 'External creditor: proposals, votes and balance updates on their own accounts.',
    permissions: ['case:read', 'debt:read', 'document:read', 'comms:read', 'comms:send'],
  },
  {
    key: 'introducer',
    name: 'Introducer',
    description: 'External referral partner: submits referrals and sees their own outcomes.',
    permissions: ['case:read', 'report:read'],
  },
] as const;
