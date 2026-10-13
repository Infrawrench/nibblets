import { useServers } from "./servers.tsx";

/** Display names for every system, by id. */
export function useServerNames(): Map<string, string> {
  const { systems } = useServers();
  return new Map(systems.map((s) => [s.id, s.name]));
}
