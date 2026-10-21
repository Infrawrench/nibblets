import type { Nibblet } from "@nibblets/protocol";

/** Parents first (most recently active on top), each followed by its sub-agents. */
export function orderNibblets(nibblets: readonly Nibblet[]): { nibblet: Nibblet; depth: number }[] {
  const byParent = new Map<string | null, Nibblet[]>();
  const ids = new Set(nibblets.map((n) => n.id));
  for (const n of nibblets) {
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), n]);
  }
  const recent = (a: Nibblet, b: Nibblet) =>
    (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt);
  const out: { nibblet: Nibblet; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of [...(byParent.get(parent) ?? [])].sort(recent)) {
      out.push({ nibblet: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The nibblet whose container this one runs in: itself, or for a sub-agent the top of its tree. */
export function hostOf(nibblet: Nibblet, all: readonly Nibblet[]): Nibblet {
  let host = nibblet;
  for (let parent = all.find((n) => n.id === host.parentId); parent;) {
    host = parent;
    parent = all.find((n) => n.id === host.parentId);
  }
  return host;
}
