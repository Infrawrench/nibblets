import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_MACHINE,
  GUEST_NAMES,
  type MachineBackend,
  type MachineCapabilities,
  type MachineChoice,
  type MachineGuest,
} from "@nibblet/protocol";
import type { ServerConnection } from "./connection.ts";
import { keys } from "./servers.tsx";

/** One place a new nibblet could run: a plugin and a guest it offers. */
export interface MachineOption {
  key: string;
  choice: MachineChoice;
  backend: MachineBackend;
  guest: MachineGuest;
  label: string;
  /** False when its image needs making by hand first (a Windows installer). */
  ready: boolean;
  /** What's worth knowing before choosing it, if anything. */
  notes: string[];
}

export const machineKey = (choice: MachineChoice): string => `${choice.backend}:${choice.guest}`;

/** What to call a nibblet's machine: "Container", or "Linux VM (Apple Virtualization)". */
export function machineLabel(choice: MachineChoice, backends: readonly MachineBackend[]): string {
  const backend = backends.find((b) => b.id === choice.backend);
  if (choice.backend === DEFAULT_MACHINE.backend) return "Container";
  return `${GUEST_NAMES[choice.guest]} VM${backend ? ` (${backend.name})` : ""}`;
}

/** How a guest's image stands, in a sentence, or null when there's nothing to say. */
export function imageNote(guest: MachineGuest): string | null {
  const { image } = guest;
  const name = GUEST_NAMES[guest.os];
  switch (image.state) {
    case "ready":
      return null;
    case "preparing":
      return `Its ${name} image is being made${image.progress === null ? "" : ` (${Math.round(image.progress * 100)}%)`}${image.detail ? `: ${image.detail}` : ""}.`;
    case "error":
      return `Making its ${name} image failed: ${image.detail ?? "no reason given"}.`;
    case "missing":
      return image.source === "none"
        ? `Its ${name} image is made the first time one starts, which takes a few minutes.`
        : `Make the ${name} image in Settings first: it needs an installer.`;
  }
}

function options(backends: readonly MachineBackend[]): MachineOption[] {
  return backends
    .filter((b) => b.available)
    .flatMap((backend) =>
      backend.guests.map((guest) => {
        const choice = { backend: backend.id, guest: guest.os };
        const container = backend.kind === "container";
        const notes = container
          ? []
          : [
              imageNote(guest),
              "A virtual machine is a stronger wall than a container, but starts slower and keeps its memory whether it needs it or not.",
              guest.capabilities.browser
                ? null
                : `No browser or desktop on ${GUEST_NAMES[guest.os]} yet.`,
              guest.capabilities.tailscale ? null : "It can't join your tailnet.",
            ].filter((n) => n !== null);
        return {
          key: machineKey(choice),
          choice,
          backend,
          guest,
          label: container
            ? `Container${backend.recommended ? " (recommended)" : ""}`
            : `${GUEST_NAMES[guest.os]} VM, ${backend.name}`,
          ready: guest.image.state === "ready" || guest.image.source === "none",
          notes,
        };
      }),
    );
}

/** Where nibblets can run on a server, refreshed while an image is being made. */
export function useMachines(connection: ServerConnection | null | undefined) {
  const query = useQuery({
    queryKey: keys.machines(connection?.id ?? "none"),
    queryFn: () => {
      if (!connection) throw new Error("No server");
      return connection.client.machines.list({});
    },
    enabled: Boolean(connection),
    staleTime: 30_000,
    refetchInterval: (q) =>
      q.state.data?.some((b) => b.guests.some((g) => g.image.state === "preparing")) ? 3000 : false,
  });
  const backends = query.data ?? [];
  return { backends, options: options(backends), loading: query.isLoading, refetch: query.refetch };
}

/** A container can do everything, so that's assumed while the machines load. */
const CONTAINER_CAPABILITIES: MachineCapabilities = {
  browser: true,
  tailscale: true,
  sshAgent: true,
  liveResources: true,
  localSignIn: true,
};

/** What a nibblet's machine can do. */
export function useCapabilities(
  connection: ServerConnection,
  nibblet: { machine: MachineChoice },
): MachineCapabilities {
  const { backends } = useMachines(connection);
  return (
    backends
      .find((b) => b.id === nibblet.machine.backend)
      ?.guests.find((g) => g.os === nibblet.machine.guest)?.capabilities ?? CONTAINER_CAPABILITIES
  );
}
