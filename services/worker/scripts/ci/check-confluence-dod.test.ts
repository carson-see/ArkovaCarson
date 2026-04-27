/**
 * Unit tests for check-confluence-dod.ts (R0-5 / SCRUM-1251).
 *
 * Locks the parser semantics so future Confluence body shapes don't silently
 * regress the DoD-checkbox detection.
 */

import { describe, it, expect } from 'vitest';
import { findUntickedDoDCheckboxes } from './check-confluence-dod.js';

describe('findUntickedDoDCheckboxes (R0-5)', () => {
  it('returns empty when no DoD section exists', () => {
    const body = '<h1>Other Section</h1><p>No DoD here.</p>';
    expect(findUntickedDoDCheckboxes(body)).toEqual([]);
  });

  it('detects a single unticked Confluence task in the DoD section', () => {
    const body = `
      <h2>Definition of Done</h2>
      <ac:task-list>
        <ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>
        <ac:task-body>Coverage thresholds met</ac:task-body></ac:task>
      </ac:task-list>
    `;
    const result = findUntickedDoDCheckboxes(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Coverage thresholds met');
  });

  it('ignores ticked tasks (status=complete)', () => {
    const body = `
      <h2>Definition of Done</h2>
      <ac:task-list>
        <ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status>
        <ac:task-body>Already done</ac:task-body></ac:task>
      </ac:task-list>
    `;
    expect(findUntickedDoDCheckboxes(body)).toEqual([]);
  });

  it('ignores tasks in other sections (DoD scope only)', () => {
    const body = `
      <h2>DoD</h2>
      <ac:task-list>
        <ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status>
        <ac:task-body>Done item</ac:task-body></ac:task>
      </ac:task-list>
      <h2>Acceptance Criteria</h2>
      <ac:task-list>
        <ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status>
        <ac:task-body>AC item — not in DoD scope</ac:task-body></ac:task>
      </ac:task-list>
    `;
    expect(findUntickedDoDCheckboxes(body)).toEqual([]);
  });

  it('also catches raw markdown-style "- [ ]" inside imported pages', () => {
    const body = `
      <h2>Definition of Done</h2>
      <p>- [ ] Manual checklist item</p>
      <p>- [x] Completed item</p>
    `;
    const result = findUntickedDoDCheckboxes(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Manual checklist item');
  });

  it('handles "Definition of Done" wrapped in nested formatting', () => {
    const body = `
      <h3><strong>Definition of Done</strong></h3>
      <ac:task-list>
        <ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>
        <ac:task-body>Wrapped heading still detected</ac:task-body></ac:task>
      </ac:task-list>
    `;
    expect(findUntickedDoDCheckboxes(body)).toHaveLength(1);
  });

  it('counts multiple unticked tasks separately', () => {
    const body = `
      <h2>Definition of Done</h2>
      <ac:task-list>
        <ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>
        <ac:task-body>First</ac:task-body></ac:task>
        <ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status>
        <ac:task-body>Second</ac:task-body></ac:task>
        <ac:task><ac:task-id>3</ac:task-id><ac:task-status>complete</ac:task-status>
        <ac:task-body>Third (done)</ac:task-body></ac:task>
      </ac:task-list>
    `;
    const result = findUntickedDoDCheckboxes(body);
    expect(result.map((r) => r.text)).toEqual(['First', 'Second']);
  });
});
