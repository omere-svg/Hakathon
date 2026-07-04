// Tests for MilestoneQueue — the engine's deterministic spine. Ordering, advancing,
// sync-skips, and completion must be exactly right: every lesson walks this state machine.

import { describe, expect, it } from 'vitest';
import { MilestoneQueue, type Milestone } from './types';

function ms(id: string, title = id): Milestone {
  return { id, title, description: `learn ${title}`, status: 'pending', context: [] };
}

describe('MilestoneQueue', () => {
  it('throws on an empty queue', () => {
    expect(() => new MilestoneQueue([])).toThrow();
  });

  it('activates the first milestone on construction', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2')]);
    expect(q.current()?.id).toBe('m1');
    expect(q.current()?.status).toBe('active');
    expect(q.position()).toBe(1);
    expect(q.size()).toBe(2);
    expect(q.isComplete()).toBe(false);
  });

  it('remaining() returns only milestones AFTER the current one', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2'), ms('m3')]);
    expect(q.remaining().map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('achieveCurrent marks but does not advance', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2')]);
    q.achieveCurrent();
    expect(q.current()?.id).toBe('m1');
    expect(q.current()?.status).toBe('achieved');
  });

  it('advance moves to the next pending milestone and activates it', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2')]);
    q.achieveCurrent();
    const next = q.advance();
    expect(next?.id).toBe('m2');
    expect(next?.status).toBe('active');
    expect(q.position()).toBe(2);
  });

  it('markAchieved only touches remaining milestones with matching ids', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2'), ms('m3')]);
    const marked = q.markAchieved(['m3', 'mX']);
    expect(marked.map((m) => m.id)).toEqual(['m3']);
    expect(q.all().find((m) => m.id === 'm3')?.status).toBe('achieved');
    // the current milestone is never marked by a sync
    expect(q.current()?.status).toBe('active');
  });

  it('advance skips milestones a sync already achieved', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2'), ms('m3')]);
    q.markAchieved(['m2']);
    q.achieveCurrent();
    const next = q.advance();
    expect(next?.id).toBe('m3');
  });

  it('completes when every milestone is achieved or passed', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2')]);
    q.markAchieved(['m2']);
    q.achieveCurrent();
    const next = q.advance();
    expect(next).toBeUndefined();
    expect(q.isComplete()).toBe(true);
    expect(q.current()).toBeUndefined();
    // position stays clamped for status lines
    expect(q.position()).toBe(2);
  });

  it('remaining() excludes already-achieved later milestones', () => {
    const q = new MilestoneQueue([ms('m1'), ms('m2'), ms('m3')]);
    q.markAchieved(['m2']);
    expect(q.remaining().map((m) => m.id)).toEqual(['m3']);
  });
});
