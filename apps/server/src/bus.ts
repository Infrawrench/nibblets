import type { LiveMessage } from "@nibblet/protocol";

type Listener = (message: LiveMessage) => void;

/** In-process fan-out of live updates to every connected UI. */
export class Bus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
