import { describe, expect, it } from 'vitest';
import {
  parseWorkflowDefinition, WorkflowValidationError,
  WORKFLOW_TEMPLATES, BANK_DATA_RECEIVED,
} from '@solvenda/workflow';
import { isRegulatedPermission } from '@solvenda/auth';

describe('shipped templates', () => {
  it.each(WORKFLOW_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s is a valid definition', (_key, template) => {
      expect(() => parseWorkflowDefinition(template)).not.toThrow();
    });

  it('implements the brief\'s example end to end', () => {
    const steps = BANK_DATA_RECEIVED.steps.map((s) => `${s.type}:${s.key}`);
    // bank data -> analyse -> compare -> flag -> task -> approval before any
    // regulated information changes.
    expect(BANK_DATA_RECEIVED.triggerEvent).toBe('open-banking.data-received');
    expect(steps).toContain('ai-capability:analyse');
    expect(steps).toContain('branch:material-differences');
    expect(steps).toContain('create-task:raise-task');
    expect(steps).toContain('approval:await-decision');
  });

  it('gates the regulated change behind a permission only a person can hold', () => {
    const approval = BANK_DATA_RECEIVED.steps.find((s) => s.key === 'await-decision')!;
    if (approval.type !== 'approval') throw new Error('expected an approval step');
    expect(isRegulatedPermission(approval.requiredPermission)).toBe(true);
  });

  it('records an outcome whichever way the adviser decides', () => {
    const approval = BANK_DATA_RECEIVED.steps.find((s) => s.key === 'await-decision')!;
    if (approval.type !== 'approval') throw new Error('expected an approval step');
    expect(approval.next).toBe('record-change');
    expect(approval.onReject).toBe('record-no-change');
  });
});

describe('validation', () => {
  const valid = BANK_DATA_RECEIVED;

  it('rejects a continuation to a step that does not exist', () => {
    const broken = { ...valid, steps: valid.steps.map((s) =>
      s.key === 'raise-task' ? { ...s, next: 'nowhere' } : s) };
    expect(() => parseWorkflowDefinition(broken)).toThrow(/continues to unknown step "nowhere"/);
  });

  it('rejects a branch to a step that does not exist', () => {
    const broken = { ...valid, steps: valid.steps.map((s) =>
      s.key === 'material-differences'
        ? { ...s, branches: [{ when: {}, next: 'imaginary', label: '' }] } : s) };
    expect(() => parseWorkflowDefinition(broken)).toThrow(/branches to unknown step "imaginary"/);
  });

  it('rejects a start step that does not exist', () => {
    expect(() => parseWorkflowDefinition({ ...valid, startStep: 'begin' }))
      .toThrow(/startStep "begin" is not a step/);
  });

  it('rejects an unreachable step', () => {
    // A step that silently never runs is worse than one that fails.
    const broken = {
      ...valid,
      steps: [...valid.steps, { type: 'end', key: 'orphan', name: 'Orphan',
                                outcome: 'x', next: null, maxAttempts: 1, onError: null }],
    };
    expect(() => parseWorkflowDefinition(broken)).toThrow(/step "orphan" is unreachable/);
  });

  it('rejects a definition with no end step', () => {
    const broken = { ...valid, steps: valid.steps.filter((s) => s.type !== 'end')
      .map((s) => ({ ...s, next: null })) };
    expect(() => parseWorkflowDefinition(broken)).toThrow(WorkflowValidationError);
  });

  it('rejects a delay with nothing to wait for', () => {
    expect(() => parseWorkflowDefinition({
      key: 'x', name: 'X', triggerEvent: 'e', startStep: 'wait',
      steps: [
        { type: 'delay', key: 'wait', name: 'Wait', next: 'done', maxAttempts: 1, onError: null },
        { type: 'end', key: 'done', name: 'Done', next: null, maxAttempts: 1, onError: null },
      ],
    })).toThrow(/needs either forHours or untilField/);
  });

  it('rejects duplicate step keys', () => {
    const step = valid.steps[0]!;
    expect(() => parseWorkflowDefinition({ ...valid, steps: [...valid.steps, { ...step }] }))
      .toThrow(/duplicate step key/);
  });

  it('caps the step budget so a looping definition cannot run away', () => {
    expect(() => parseWorkflowDefinition({ ...valid, maxSteps: 5000 }))
      .toThrow(WorkflowValidationError);
  });
});
