import { BaseEvent } from '../types/events';

/** Simple in-memory buffer with batch threshold and manual flush */
export class EventBuffer {
  private events: BaseEvent[] = [];
  constructor(
    private readonly batchSize: number,
    private readonly maxSize = 1000
  ) {}

  add(event: BaseEvent): boolean {
    if (this.events.length >= this.maxSize) {
      // Drop oldest to avoid unbounded growth
      this.events.shift();
    }
    this.events.push(event);
    return this.events.length >= this.batchSize;
  }

  drain(): BaseEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  size(): number {
    return this.events.length;
  }
}


