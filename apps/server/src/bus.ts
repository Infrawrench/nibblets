import type { LiveMessage } from "@nibblets/protocol";

type Listener = (message: LiveMessage) => void;

/** In-process fan-out of live updates to every connected UI. */
export class Bus {
  private readonly listeners = new Set<Listener>();
  private readonly uis = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribes an open UI's live socket, so `viewers` knows someone could answer. */
  subscribeUi(listener: Listener): () => void {
    this.uis.add(listener);
    const off = this.subscribe(listener);
    return () => {
      this.uis.delete(listener);
      off();
    };
  }

  /** How many UIs are open on this server right now. */
  get viewers(): number {
    return this.uis.size;
  }

  publish(message: LiveMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (err) {
        console.error("live listener failed", err);
      }
    }
  }
}
