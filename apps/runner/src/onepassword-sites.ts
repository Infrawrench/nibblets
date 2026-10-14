/**
 * Which site a page or a login belongs to, and finding things in the
 * browser's accessibility tree, for the 1Password tools: a login is only
 * ever typed into a page on its own site, which the tool opens itself.
 */

/** The host of an address, lower-cased; `github.com` and `https://github.com/x` alike. */
export function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * The same host, or one inside the other (`login.example.com` and
 * `example.com`). Deliberately not "the last two labels", which would put
 * `x.co.uk` and `evil.co.uk` on one site.
 */
export function sameSite(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** One element of OpenComputerUse's tree: `[e9] TextField "Name" value="x" … focused`. */
export interface TreeNode {
  id: string;
  role: string;
  name: string;
  value: string | null;
  focused: boolean;
  depth: number;
}

export function parseTree(text: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\s*)\[(e\d+)\]\s+(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/.exec(line);
    if (!m?.[2] || !m[3]) continue;
    const rest = m[5] ?? "";
    nodes.push({
      id: m[2],
      role: m[3],
      name: m[4] ?? "",
      value: /\bvalue="((?:[^"\\]|\\.)*)"/.exec(rest)?.[1] ?? null,
      focused: /\bfocused\b/.test(rest),
      depth: (m[1] ?? "").length,
    });
  }
  return nodes;
}

/** Chromium's address bar. */
export function addressBar(nodes: readonly TreeNode[]): TreeNode | null {
  return (
    nodes.find((n) => n.role === "TextField" && /address and search bar/i.test(n.name)) ?? null
  );
}

/**
 * The page's username (or email) field: a text field inside the page whose
 * name says so, or else the page's first text field.
 */
export function usernameField(nodes: readonly TreeNode[]): TreeNode | null {
  const start = nodes.findIndex((n) => n.role === "WebArea");
  if (start < 0) return null;
  const page: TreeNode[] = [];
  const depth = nodes[start]?.depth ?? 0;
  for (const n of nodes.slice(start + 1)) {
    if (n.depth <= depth) break;
    page.push(n);
  }
  const fields = page.filter((n) => n.role === "TextField" || n.role === "ComboBox");
  return (
    fields.find((n) => /user|e-?mail|login|account|phone/i.test(n.name)) ??
    fields.find((n) => !/password|search/i.test(n.name)) ??
    null
  );
}
