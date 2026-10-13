import { useQueries } from "@tanstack/react-query";
import { keys, useServers } from "./servers.tsx";

/** Display names for every connected server, from each one's own info. */
export function useServerNames(): Map<string, string> {
  const { all, peers } = useServers();
  const infos = useQueries({
    queries: all.map((c) => ({
      queryKey: keys.info(c.id),
      queryFn: () => c.client.system.info({}),
      staleTime: 60_000,
    })),
  });
  const names = new Map<string, string>();
  all.forEach((c, i) => {
    const fallback =
      c.id === "local" ? "This server" : (peers.find((p) => p.id === c.id)?.name ?? c.id);
    names.set(c.id, infos[i]?.data?.name ?? fallback);
  });
  return names;
}
