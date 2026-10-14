import type { LiveMessage, Nibblet, PushNote } from "@nibblet/protocol";

/** What it needs to know about a nibblet. */
export type Watched = Pick<
  Nibblet,
  "id" | "name" | "status" | "awaitingApproval" | "statusText" | "statusDetail"
>;
type Seen = Pick<Nibblet, "status" | "awaitingApproval">;

/**
 * Watches nibblets for the moments their person should hear about even
 * when the app is closed: asking to approve something, or stuck on an
 * error. Each fires once as it happens, not again until it's over and
 * happens anew; what was already so when the server started is left alone.
 */
export class Notifier {
  private readonly seen = new Map<string, Seen>();
  private readonly send: (note: PushNote) => void;

  constructor(send: (note: PushNote) => void) {
    this.send = send;
  }

  /** Follows the live updates the UI gets. */
  observe(message: LiveMessage): void {
    if (message.type === "nibblet") this.changed(message.nibblet);
    if (message.type === "nibblet_deleted") this.seen.delete(message.id);
  }

  changed(n: Watched): void {
    const before = this.seen.get(n.id);
    this.seen.set(n.id, { status: n.status, awaitingApproval: n.awaitingApproval });
    if (!before) return;
    if (n.awaitingApproval && !before.awaitingApproval) {
      this.send({
        nibbletId: n.id,
        title: `${n.name} needs your OK`,
        body: n.statusText ?? "It's waiting for you to approve something.",
        tag: `approval-${n.id}`,
      });
    }
    if (n.status === "error" && before.status !== "error") {
      this.send({
        nibbletId: n.id,
        title: `${n.name} needs help`,
        body: n.statusDetail ?? "Something went wrong and it's stopped.",
        tag: `error-${n.id}`,
      });
    }
  }

  /** The nibblet itself asking for its person, from its `ask_for_help` tool. */
  askForHelp(nibblet: Pick<Nibblet, "id" | "name">, message: string): void {
    this.send({
      nibbletId: nibblet.id,
      title: `${nibblet.name} needs you`,
      body: message,
      tag: `help-${nibblet.id}`,
    });
  }
}
