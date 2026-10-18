import type { HamsterLook, Nibblet, StoredItem } from "@nibblet/protocol";

export interface OfflineConversation {
  server: string;
  host: string;
  systemName: string;
  id: string;
  name: string;
  look: HamsterLook;
  harness: Nibblet["harness"];
  model: string;
  savedAt: string;
  messages: { id: string; role: "user" | "assistant"; text: string; at: string }[];
}

export interface OutgoingMessage {
  id: string;
  server: string;
  conversation: string;
  text: string;
  attachments: string[];
  createdAt: string;
  state: "queued" | "uncertain" | "accepted" | "rejected";
  attempted: boolean;
  retrySafe?: boolean;
  detail?: string;
}

export interface OfflinePayload {
  bindings: Record<string, string>;
  conversations: OfflineConversation[];
  outbox: OutgoingMessage[];
}

export const emptyOfflinePayload = (): OfflinePayload => ({
  bindings: {},
  conversations: [],
  outbox: [],
});
export const conversationKey = (server: string, id: string): string => JSON.stringify([server, id]);

export function saveConversation(
  payload: OfflinePayload,
  server: string,
  host: string,
  systemName: string,
  nibblet: Nibblet,
  items: StoredItem[],
): OfflinePayload {
  const conversation: OfflineConversation = {
    server,
    host,
    systemName,
    id: nibblet.id,
    name: nibblet.name,
    look: nibblet.look,
    harness: nibblet.harness,
    model: nibblet.model,
    savedAt: new Date().toISOString(),
    messages: items
      .flatMap(({ item }) =>
        item.type === "assistant_message" ||
        (item.type === "user_message" && item.source === "user")
          ? [
              {
                id: item.id,
                role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
                text: item.text,
                at: item.createdAt,
              },
            ]
          : [],
      )
      .slice(-100),
  };
  if (new TextEncoder().encode(JSON.stringify([conversation])).byteLength > 10 * 1024 * 1024)
    return payload;
  const conversations = [
    conversation,
    ...payload.conversations.filter((c) => c.server !== server || c.id !== nibblet.id),
  ].slice(0, 20);
  while (
    conversations.length &&
    new TextEncoder().encode(JSON.stringify(conversations)).byteLength > 10 * 1024 * 1024
  )
    conversations.pop();
  return { ...payload, conversations };
}

export function enqueueMessage(payload: OfflinePayload, message: OutgoingMessage): OfflinePayload {
  const pending = payload.outbox.filter(
    (m) =>
      m.server === message.server &&
      m.conversation === message.conversation &&
      m.state !== "accepted",
  );
  if (pending.length >= 5)
    throw new Error("Five messages are already waiting in this conversation.");
  if (new TextEncoder().encode(JSON.stringify([...pending, message])).byteLength > 128 * 1024)
    throw new Error("Queued messages must fit within 128 KiB per conversation.");
  return { ...payload, outbox: [...payload.outbox.filter((m) => m.state !== "accepted"), message] };
}

export function canRecall(
  event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    composing: boolean;
  },
  area: Pick<
    HTMLTextAreaElement,
    "value" | "selectionStart" | "selectionEnd" | "scrollTop" | "clientWidth"
  >,
  firstVisualLine: boolean,
): boolean {
  return (
    event.key === "ArrowUp" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.composing &&
    area.selectionStart === area.selectionEnd &&
    !area.value.slice(0, area.selectionStart).includes("\n") &&
    firstVisualLine
  );
}
