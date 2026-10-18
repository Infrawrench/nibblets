import { RpcError } from "@nibblet/protocol";
import type { ServerConnection } from "./connection.ts";
import { RouteChangedError } from "./connection.ts";
import type { OfflineVault } from "./offline-vault.ts";
import type { OfflinePayload } from "./offline-data.ts";

export async function drainHead(
  vault: OfflineVault,
  connection: ServerConnection,
  id: string,
  reconnect: boolean,
  alive: () => boolean,
  mutate: (fn: (data: OfflinePayload) => OfflinePayload) => Promise<OfflinePayload>,
  onAttempt?: () => void,
): Promise<boolean> {
  if (!navigator.locks) throw new Error("Web Locks are required to send queued messages safely.");
  const client = connection.pinClient(() => {
    if (!alive() || !vault.unlocked)
      throw new Error("Queued sending stopped because offline messages were locked.");
  });
  return navigator.locks.request(
    `nibblets-outbox:${vault.id}:${JSON.stringify([connection.id, id])}`,
    async () => {
      if (!alive() || !vault.unlocked) return false;
      const payload = await vault.read<OfflinePayload>("payload");
      const head = payload?.outbox.find(
        (m) =>
          m.server === connection.id &&
          m.conversation === id &&
          (m.state === "queued" || m.state === "uncertain"),
      );
      if (!head || (head.attempted && (!head.retrySafe || !reconnect))) return false;
      const [info, nibblets] = await Promise.all([
        client.system.info({}),
        client.nibblets.list({}),
      ]);
      if (!alive() || !vault.unlocked) return false;
      if (!payload?.bindings[connection.id] || payload.bindings[connection.id] !== info.serverId)
        throw new Error("Host identity could not be verified. Waiting messages are paused.");
      const nibblet = nibblets.find((n) => n.id === id);
      if (
        !nibblet ||
        nibblet.status === "working" ||
        nibblet.status === "waiting" ||
        nibblet.status === "starting" ||
        nibblet.awaitingApproval
      )
        return false;
      if (info.capabilities?.durableSendV1 !== true)
        throw new Error("Update this host before sending queued messages safely.");
      await mutate((data) => ({
        ...data,
        outbox: data.outbox.map((m) =>
          m.id === head.id
            ? {
                ...m,
                state: "uncertain",
                attempted: true,
                retrySafe: true,
                detail: "Waiting for the host receipt",
              }
            : m,
        ),
      }));
      if (!alive() || !vault.unlocked) return false;
      onAttempt?.();
      try {
        const result = await client.nibblets.send({
          id,
          text: head.text,
          attachments: head.attachments,
          clientMessageId: head.id,
        });
        if (!alive() || !vault.unlocked) return false;
        const receipt = result.receipt;
        if (!receipt || receipt.clientMessageId !== head.id) {
          await mutate((data) => ({
            ...data,
            outbox: data.outbox.map((m) =>
              m.id === head.id
                ? {
                    ...m,
                    retrySafe: false,
                    detail:
                      "Host did not confirm retry support. Check the conversation before sending again.",
                  }
                : m,
            ),
          }));
          return false;
        }
        await mutate((data) => ({
          ...data,
          outbox: data.outbox.map((m) =>
            m.id === head.id
              ? {
                  ...m,
                  state:
                    receipt.state === "cancelled" || receipt.state === "interrupted"
                      ? "rejected"
                      : "accepted",
                  detail: receipt.state,
                }
              : m,
          ),
        }));
        return true;
      } catch (failure) {
        if (!alive() || !vault.unlocked) return false;
        if (failure instanceof RpcError) {
          await mutate((data) => ({
            ...data,
            outbox: data.outbox.map((m) =>
              m.id === head.id
                ? {
                    ...m,
                    state:
                      failure.code === "bad_request" ||
                      failure.code === "not_found" ||
                      failure.code === "conflict"
                        ? "rejected"
                        : "uncertain",
                    retrySafe: failure.code !== "unauthorized",
                    detail: failure.message,
                  }
                : m,
            ),
          }));
          return (
            failure.code === "bad_request" ||
            failure.code === "not_found" ||
            failure.code === "conflict"
          );
        }
        if (!(failure instanceof TypeError) && !(failure instanceof RouteChangedError)) {
          await mutate((data) => ({
            ...data,
            outbox: data.outbox.map((m) =>
              m.id === head.id
                ? {
                    ...m,
                    retrySafe: false,
                    detail: "Invalid host response. Automatic retry paused.",
                  }
                : m,
            ),
          }));
        }
        throw failure;
      }
    },
  );
}
