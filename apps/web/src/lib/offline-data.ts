import { z } from "zod";
import { HamsterLook, HarnessId, type Nibblet, type StoredItem } from "@nibblet/protocol";

export const OfflineConversation = z.object({
  server: z.string(),
  host: z.string(),
  systemName: z.string(),
  id: z.string(),
  name: z.string(),
  look: HamsterLook,
  harness: HarnessId,
  model: z.string(),
  savedAt: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(["user", "assistant"]),
      text: z.string(),
      at: z.string(),
    }),
  ),
});
export type OfflineConversation = z.infer<typeof OfflineConversation>;

export const OutgoingMessage = z.object({
  id: z.string(),
  server: z.string(),
  conversation: z.string(),
  text: z.string(),
  attachments: z.array(z.string()),
  createdAt: z.string(),
  state: z.enum(["queued", "uncertain", "accepted", "rejected"]),
  attempted: z.boolean(),
  retrySafe: z.boolean().optional(),
  detail: z.string().optional(),
});
export type OutgoingMessage = z.infer<typeof OutgoingMessage>;

/**
 * Everything the vault holds. Saved chats are only a cache, so one this
 * version can't read is dropped rather than locking the vault; queued
 * messages are never dropped.
 */
export const OfflinePayload = z.object({
  bindings: z.record(z.string(), z.string()),
  conversations: z.array(z.json()).transform((saved) =>
    saved.flatMap((entry) => {
      const parsed = OfflineConversation.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  outbox: z.array(OutgoingMessage),
});
export type OfflinePayload = z.infer<typeof OfflinePayload>;

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
