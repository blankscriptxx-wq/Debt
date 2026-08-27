import { isRegulatedPermission, permissionDefinition, requiredCompetencies } from './permissions.js';

/**
 * Who is asking.
 *
 * The distinction between a human principal and every other kind is the load
 * bearing part of this file. Automation is genuinely useful and genuinely
 * dangerous in a regulated advice context, so the platform lets it do a great
 * deal - gather, analyse, draft, flag, escalate - while making it structurally
 * incapable of exercising a regulated permission.
 */
export type Principal =
  | {
      kind: 'user';
      tenantId: string;
      userId: string;
      permissions: ReadonlySet<string>;
      competencies: readonly string[];
      mfaSatisfied: boolean;
      status: 'active' | 'invited' | 'suspended' | 'closed';
    }
  | { kind: 'api_key'; tenantId: string; keyId: string; scopes: ReadonlySet<string> }
  | { kind: 'workflow'; tenantId: string; runId: string; permissions: ReadonlySet<string> }
  | { kind: 'ai'; tenantId: string; capability: string; invocationId: string }
  | { kind: 'platform_operator'; operatorId: string; tenantId?: string };

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; code: DenialCode; message: string };

export type DenialCode =
  | 'unknown_permission'
  | 'not_granted'
  | 'account_not_active'
  | 'mfa_required'
  | 'regulated_action_requires_human'
  | 'missing_competency'
  | 'wrong_tenant'
  | 'platform_operator_cannot_act_in_tenant';

export class PermissionDeniedError extends Error {
  constructor(
    public readonly permission: string,
    public readonly code: DenialCode,
    message: string,
  ) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export function authorize(
  principal: Principal,
  permission: string,
  options: { tenantId?: string } = {},
): AuthorizationDecision {
  const definition = permissionDefinition(permission);
  if (!definition) {
    return deny('unknown_permission', `"${permission}" is not a known permission`);
  }

  if (options.tenantId && 'tenantId' in principal && principal.tenantId !== options.tenantId) {
    return deny('wrong_tenant', 'Principal belongs to a different firm');
  }

  const regulated = isRegulatedPermission(permission);

  switch (principal.kind) {
    case 'user': {
      if (principal.status !== 'active') {
        return deny('account_not_active', `Account status is ${principal.status}`);
      }
      if (!principal.permissions.has(permission)) {
        return deny('not_granted', `The role assignment does not include ${permission}`);
      }
      // Regulated work always requires a second factor, regardless of the
      // firm's general MFA posture.
      if (regulated && !principal.mfaSatisfied) {
        return deny('mfa_required', 'Regulated actions require a completed second factor');
      }
      const needed = requiredCompetencies(permission);
      const missing = needed.filter((c) => !principal.competencies.includes(c));
      if (missing.length) {
        return deny(
          'missing_competency',
          `Requires competency sign-off: ${missing.join(', ')}`,
        );
      }
      return { allowed: true };
    }

    case 'platform_operator':
      // Operators administer the platform. They never act inside a firm's
      // regulated process, whatever their support grant allows them to read.
      return deny(
        'platform_operator_cannot_act_in_tenant',
        'Platform operators cannot exercise tenant permissions',
      );

    case 'api_key':
    case 'workflow':
    case 'ai': {
      if (regulated) {
        return deny(
          'regulated_action_requires_human',
          `${permission} carries regulatory weight and can only be exercised by an ` +
            `authenticated person. Automation may propose the change for approval instead.`,
        );
      }
      const granted =
        principal.kind === 'api_key' ? principal.scopes
        : principal.kind === 'workflow' ? principal.permissions
        : AI_PERMISSIONS;
      if (!granted.has(permission)) {
        return deny('not_granted', `This principal is not granted ${permission}`);
      }
      return { allowed: true };
    }
  }
}

/** What an AI capability may do on its own account: read, analyse, propose. */
const AI_PERMISSIONS: ReadonlySet<string> = new Set([
  'client:read', 'case:read', 'sfs:read', 'debt:read',
  'document:read', 'comms:read', 'vulnerability:read',
  'ai:invoke', 'report:read', 'workflow:read', 'qa:read',
]);

export function requirePermission(
  principal: Principal,
  permission: string,
  options: { tenantId?: string } = {},
): void {
  const decision = authorize(principal, permission, options);
  if (!decision.allowed) {
    throw new PermissionDeniedError(permission, decision.code, decision.message);
  }
}

function deny(code: DenialCode, message: string): AuthorizationDecision {
  return { allowed: false, code, message };
}
