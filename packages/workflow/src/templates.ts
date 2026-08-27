import type { WorkflowDefinition } from './schema.js';

/**
 * Workflow templates a firm starts from.
 *
 * The first is the example from the original brief, implemented end to end:
 * bank information arrives, transactions are analysed, declared and observed
 * expenditure are compared, material differences are flagged, an adviser task
 * is raised, and approval is required before any regulated case information
 * changes. That last clause is the interesting one, and the engine enforces it
 * rather than trusting the template to be configured correctly.
 */

export const BANK_DATA_RECEIVED: WorkflowDefinition = {
  key: 'bank-data-received',
  name: 'Bank information received',
  description:
    'Analyses newly received Open Banking data, compares it against the declared financial ' +
    'statement, and puts any material differences in front of the adviser for a decision.',
  triggerEvent: 'open-banking.data-received',
  caseTypes: [],
  startStep: 'analyse',
  maxSteps: 20,
  steps: [
    {
      type: 'ai-capability',
      key: 'analyse',
      name: 'Compare declared against observed',
      capability: 'ie-discrepancy',
      createProposals: true,
      next: 'material-differences',
      maxAttempts: 3,
      onError: 'notify-failure',
    },
    {
      type: 'branch',
      key: 'material-differences',
      name: 'Are any differences material?',
      branches: [
        {
          when: { gte: [{ fact: 'analyse.proposalCount' }, { const: 1 }] },
          next: 'raise-task',
          label: 'material differences found',
        },
      ],
      default: 'no-action',
      next: null,
      maxAttempts: 1,
      onError: null,
    },
    {
      type: 'create-task',
      key: 'raise-task',
      name: 'Task the adviser to review the differences',
      title: 'Review differences between declared and observed expenditure',
      detail:
        'Bank data has been analysed and differs materially from the declared statement. ' +
        'The suggestions are questions to put to the client, not corrections. Nothing has ' +
        'been changed on the case.',
      priority: 'high',
      assignTo: 'case-owner',
      dueInHours: 48,
      next: 'await-decision',
      maxAttempts: 3,
      onError: null,
    },
    {
      type: 'approval',
      key: 'await-decision',
      name: 'Adviser approves any change to the statement',
      title: 'Approve changes to the financial statement',
      detail:
        'The financial statement carries regulatory weight. Confirm which, if any, of the ' +
        'observed figures should be reflected after speaking to the client.',
      // A regulated permission, so the authorisation engine will only ever let
      // a person resolve this.
      requiredPermission: 'ai:accept_proposal',
      assignTo: 'case-owner',
      dueInHours: 72,
      escalateToTeam: 'compliance',
      onReject: 'record-no-change',
      next: 'record-change',
      maxAttempts: 1,
      onError: null,
    },
    {
      type: 'emit-event',
      key: 'record-change',
      name: 'Record that the statement was revisited',
      eventType: 'financial-statement.reviewed',
      payload: { trigger: 'bank-data-discrepancy', outcome: 'adviser-approved' },
      next: 'done',
      maxAttempts: 3,
      onError: null,
    },
    {
      type: 'emit-event',
      key: 'record-no-change',
      name: 'Record that the adviser kept the declared figures',
      eventType: 'financial-statement.reviewed',
      payload: { trigger: 'bank-data-discrepancy', outcome: 'declared-figures-retained' },
      next: 'done',
      maxAttempts: 3,
      onError: null,
    },
    {
      type: 'create-task',
      key: 'notify-failure',
      name: 'Tell someone the analysis did not run',
      title: 'Bank data analysis failed - review manually',
      detail: 'The automated comparison could not be completed. Review the bank data by hand.',
      priority: 'normal',
      assignTo: 'case-owner',
      dueInHours: 24,
      next: 'done',
      maxAttempts: 3,
      onError: null,
    },
    {
      type: 'end', key: 'no-action', name: 'Nothing material found',
      outcome: 'no-material-differences', next: null, maxAttempts: 1, onError: null,
    },
    {
      type: 'end', key: 'done', name: 'Complete',
      outcome: 'completed', next: null, maxAttempts: 1, onError: null,
    },
  ],
};

export const REVIEW_DUE: WorkflowDefinition = {
  key: 'annual-review-due',
  name: 'Annual review falling due',
  description:
    'Starts the review process ahead of the due date, chases the client, and escalates ' +
    'when the review goes overdue.',
  triggerEvent: 'case.review-due-soon',
  caseTypes: ['dmp', 'iva', 'trust-deed', 'das-dpp'],
  startStep: 'invite',
  maxSteps: 30,
  steps: [
    {
      type: 'send-communication', key: 'invite', name: 'Invite the client to complete their review',
      channel: 'email', templateKey: 'review-invitation', to: 'client',
      next: 'wait-a-week', maxAttempts: 3, onError: 'raise-manual-task',
    },
    {
      type: 'delay', key: 'wait-a-week', name: 'Wait a week', forHours: 168,
      next: 'check-response', maxAttempts: 1, onError: null,
    },
    {
      type: 'branch', key: 'check-response', name: 'Has the client responded?',
      branches: [
        { when: { eq: [{ fact: 'trigger.reviewStarted' }, { const: true }] },
          next: 'done', label: 'review under way' },
      ],
      default: 'remind', next: null, maxAttempts: 1, onError: null,
    },
    {
      type: 'send-communication', key: 'remind', name: 'Remind by text',
      channel: 'sms', templateKey: 'review-reminder', to: 'client',
      next: 'wait-again', maxAttempts: 3, onError: 'raise-manual-task',
    },
    {
      type: 'delay', key: 'wait-again', name: 'Wait another week', forHours: 168,
      next: 'raise-manual-task', maxAttempts: 1, onError: null,
    },
    {
      type: 'create-task', key: 'raise-manual-task', name: 'Adviser to make contact',
      title: 'Client has not engaged with their annual review',
      detail:
        'Two automated approaches have gone unanswered. Disengagement can itself indicate ' +
        'difficulty; consider a different channel and check recorded support needs.',
      priority: 'high', assignTo: 'case-owner', dueInHours: 72,
      next: 'done', maxAttempts: 3, onError: null,
    },
    { type: 'end', key: 'done', name: 'Complete', outcome: 'completed',
      next: null, maxAttempts: 1, onError: null },
  ],
};

export const WORKFLOW_TEMPLATES: readonly WorkflowDefinition[] = [
  BANK_DATA_RECEIVED,
  REVIEW_DUE,
];
