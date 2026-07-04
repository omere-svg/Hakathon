// The MilestoneQueue: the engine's strictly-ordered plan. The local model decomposes the
// lesson goal into Milestones (init); the engine walks them one at a time. Each milestone
// owns its OWN conversation context — the model never sees another milestone's messages
// (strict context isolation). "Remaining" always means the milestones AFTER the current one.

export type MilestoneStatus = 'pending' | 'active' | 'achieved';

export interface MilestoneTurn {
  role: 'student' | 'tutor';
  text: string;
}

export interface Milestone {
  id: string;
  /** short title for the dev panel. */
  title: string;
  /** what the student must demonstrate to achieve this milestone. */
  description: string;
  status: MilestoneStatus;
  /** ISOLATED context: only the messages exchanged while teaching THIS milestone. */
  context: MilestoneTurn[];
  /** failed assessments on this milestone — drives the escalating scaffold and the
   *  force-advance cap so a student can never be trapped in an impasse loop. */
  attempts?: number;
}

/** Bounded window of a milestone's isolated context handed to the model each call. */
export const CONTEXT_WINDOW = 8;

/** Serializable snapshot of a queue (for localStorage session persistence). */
export interface QueueSnapshot {
  items: Milestone[];
  index: number;
}

export class MilestoneQueue {
  private items: Milestone[];
  private index = 0;

  constructor(items: Milestone[]) {
    if (!items.length) throw new Error('MilestoneQueue requires at least one milestone.');
    this.items = items;
    this.items[0].status = 'active';
  }

  /** Snapshot for persistence — plain data, safe to JSON.stringify. */
  snapshot(): QueueSnapshot {
    return { items: this.items.map((m) => ({ ...m, context: [...m.context] })), index: this.index };
  }

  /** Rebuild a queue exactly as it was saved (statuses and position preserved). */
  static restore(snap: QueueSnapshot): MilestoneQueue {
    const q = new MilestoneQueue(snap.items.map((m) => ({ ...m, context: [...m.context] })));
    // The constructor activates item 0; put the SAVED statuses and position back.
    snap.items.forEach((m, i) => { q.items[i].status = m.status; });
    q.index = Math.min(Math.max(0, snap.index), snap.items.length);
    return q;
  }

  /** The milestone currently being taught (undefined once the queue is complete). */
  current(): Milestone | undefined {
    return this.items[this.index];
  }

  /** Milestones strictly AFTER the current one that are not yet achieved. */
  remaining(): Milestone[] {
    return this.items.slice(this.index + 1).filter((m) => m.status !== 'achieved');
  }

  /** All milestones, in order (for display). */
  all(): readonly Milestone[] {
    return this.items;
  }

  isComplete(): boolean {
    return this.index >= this.items.length;
  }

  /** 1-based position of the current milestone, for status lines. */
  position(): number {
    return Math.min(this.index + 1, this.items.length);
  }

  size(): number {
    return this.items.length;
  }

  /** Mark the current milestone achieved (does not advance). */
  achieveCurrent(): void {
    const cur = this.current();
    if (cur) cur.status = 'achieved';
  }

  /** Milestone Sync result: mark any remaining milestones the cross-check found already met. */
  markAchieved(ids: string[]): Milestone[] {
    const set = new Set(ids);
    const marked: Milestone[] = [];
    for (const m of this.remaining()) {
      if (set.has(m.id)) {
        m.status = 'achieved';
        marked.push(m);
      }
    }
    return marked;
  }

  /** Advance to the next milestone that is still pending, activating it. Skips any that a
   *  sync already marked achieved. Leaves the queue "complete" when none remain. */
  advance(): Milestone | undefined {
    this.index++;
    while (this.index < this.items.length && this.items[this.index].status === 'achieved') {
      this.index++;
    }
    const next = this.current();
    if (next) next.status = 'active';
    return next;
  }
}
