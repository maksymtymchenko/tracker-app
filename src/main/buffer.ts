import { BaseEvent } from '../types/events';

/** Simple in-memory buffer with batch threshold and manual flush */
export class EventBuffer {
  private events: BaseEvent[] = [];
  constructor(private readonly batchSize: number) {}

  add(event: BaseEvent): boolean {
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


