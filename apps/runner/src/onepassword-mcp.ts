/**
 * The `onepassword` MCP server: a nibblet's shared 1Password vaults as
 * tools, run over stdio inside its container. It drives the `op` CLI with the
 * nibblet's own service account (OP_SERVICE_ACCOUNT_TOKEN), which can only
 * see the vaults the user ticked, and it never shows a concealed field unless
 * asked for that one secret by reference. `fill_login` types a login into the
 * browser through OpenComputerUse, so the password never passes through the
 * agent at all.
 */
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ONEPASSWORD_VAULTS_ENV, SharedVault } from "@nibblets/protocol";
import { z } from "zod";
import { addressBar, hostOf, parseTree, sameSite, usernameField } from "./onepassword-sites.ts";

const vaults = z.array(SharedVault).parse(JSON.parse(process.env[ONEPASSWORD_VAULTS_ENV] ?? "[]"));

function op(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("op", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err
        ? reject(new Error(String(stderr).trim().split("\n").at(-1) || "op failed"))
        : resolve(String(stdout)),
    );
  });
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

function vaultNamed(name: string | undefined): SharedVault | null {
  if (!name) return null;
  return vaults.find((v) => v.name.toLowerCase() === name.toLowerCase()) ?? null;
}

const ItemSummary = z.looseObject({
  id: z.string(),
  title: z.string(),
  category: z.string().optional(),
  vault: z.looseObject({ name: z.string() }).optional(),
  urls: z.array(z.looseObject({ href: z.string() })).optional(),
});
type ItemSummary = z.infer<typeof ItemSummary>;

const Field = z.looseObject({
  id: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
  purpose: z.string().optional(),
  value: z.string().optional(),
  reference: z.string().optional(),
});
const Item = ItemSummary.extend({ fields: z.array(Field).optional() });

async function search(query: string | undefined, url: string | undefined, vault?: string) {
  const host = url ? hostOf(url) : null;
  const pool = vault ? [vaultNamed(vault)].filter((v) => v !== null) : vaults;
  const found: ItemSummary[] = [];
  for (const v of pool) {
    const items = z
      .array(ItemSummary)
      .parse(JSON.parse(await op(["item", "list", "--vault", v.name, "--format", "json"])));
    for (const item of items) {
      const titleMatch = !query || item.title.toLowerCase().includes(query.toLowerCase());
      const urlMatch = !host || (item.urls ?? []).some((u) => sameSite(hostOf(u.href), host));
      if (titleMatch && urlMatch) found.push(item);
    }
  }
  return found;
}

async function getItem(item: string, vault: string | undefined) {
  const args = ["item", "get", item, "--format", "json"];
  const v = vaultNamed(vault);
  if (v) args.push("--vault", v.name);
  return Item.parse(JSON.parse(await op(args)));
}

const server = new McpServer({ name: "onepassword", version: "0.1.0" });

server.registerTool(
  "vault_list",
  {
    description: "The 1Password vaults shared with you, and whether you can change them.",
    inputSchema: {},
  },
  async () => text(JSON.stringify(vaults, null, 2)),
);

server.registerTool(
  "item_search",
  {
    description:
      "Find items in your shared vaults by title and/or website. Returns ids, titles, vaults and websites; no secrets.",
    inputSchema: {
      query: z.string().optional().describe("Part of the item's title"),
      url: z.string().optional().describe("A website the login is for, e.g. github.com"),
      vault: z.string().optional(),
    },
  },
  async ({ query, url, vault }) => {
    const items = await search(query, url, vault);
    return text(
      JSON.stringify(
        items.map((i) => ({
          id: i.id,
          title: i.title,
          vault: i.vault?.name,
          category: i.category,
          urls: (i.urls ?? []).map((u) => u.href),
        })),
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "item_get",
  {
    description:
      "An item's fields. Ordinary fields come with their values; concealed ones (passwords, keys) only with a reference to pass to read_secret.",
    inputSchema: { item: z.string().describe("Id or title"), vault: z.string().optional() },
  },
  async ({ item, vault }) => {
    const found = await getItem(item, vault);
    return text(
      JSON.stringify(
        {
          id: found.id,
          title: found.title,
          vault: found.vault?.name,
          urls: (found.urls ?? []).map((u) => u.href),
          fields: (found.fields ?? []).map((f) =>
            f.type === "CONCEALED"
              ? { label: f.label ?? f.id, concealed: true, reference: f.reference }
              : { label: f.label ?? f.id, value: f.value ?? "" },
          ),
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "read_secret",
  {
    description:
      "Reveal one secret by its op:// reference (from item_get). Use it only where it's needed; never repeat it in chat, memory or files.",
    inputSchema: { reference: z.string().startsWith("op://") },
  },
  async ({ reference }) => text((await op(["read", reference])).replace(/\n$/, "")),
);

server.registerTool(
  "item_create",
  {
    description: "Create a login in a vault you can write to.",
    inputSchema: {
      vault: z.string(),
      title: z.string().min(1),
      url: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional().describe("Leave out to have 1Password generate one"),
    },
  },
  async ({ vault, title, url, username, password }) => {
    const v = vaultNamed(vault);
    if (v?.access !== "write") return failure(`You can't add items to ${vault}.`);
    const args = ["item", "create", "--vault", v.name, "--category", "login", "--title", title];
    if (url) args.push("--url", url);
    if (!password) args.push("--generate-password");
    if (username) args.push(`username=${username}`);
    if (password) args.push(`password=${password}`);
    const created = Item.parse(JSON.parse(await op([...args, "--format", "json"])));
    return text(`Created "${created.title}" (${created.id}) in ${v.name}.`);
  },
);

server.registerTool(
  "item_edit",
  {
    description: "Change fields on an item in a vault you can write to.",
    inputSchema: {
      item: z.string(),
      vault: z.string(),
      fields: z.record(z.string(), z.string()).describe("Field label to new value"),
    },
  },
  async ({ item, vault, fields }) => {
    const v = vaultNamed(vault);
    if (v?.access !== "write") return failure(`You can't change items in ${vault}.`);
    const assignments = Object.entries(fields).map(([label, value]) => `${label}=${value}`);
    await op(["item", "edit", item, "--vault", v.name, ...assignments]);
    return text(`Updated ${Object.keys(fields).join(", ")}.`);
  },
);

/** The browser's MCP endpoint, when it runs in serve mode. */
async function computer(): Promise<Client | null> {
  const url = process.env.OCU_MCP_URL;
  if (!url) return null;
  const client = new Client({ name: "onepassword", version: "0.1.0" });
  const auth = process.env.OCU_MCP_AUTH;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: auth ? { authorization: auth } : {} },
    }),
  );
  return client;
}

const Sessions = z.looseObject({ sessions: z.array(z.looseObject({ session_id: z.string() })) });

server.registerTool(
  "fill_login",
  {
    description:
      "Sign in with a saved login without seeing the password. It opens the login's own website (the one saved in 1Password, or `page` if that's on the same site, like github.com/login), finds the username field, types the username, presses Tab, types the password, and presses Enter if submit is true. It never types into a page you opened yourself.",
    inputSchema: {
      item: z.string().optional().describe("Id or title; or give url"),
      url: z.string().optional().describe("The site, e.g. github.com, to look the login up by"),
      page: z
        .string()
        .optional()
        .describe("The sign-in page to open, on the login's own site; its saved address otherwise"),
      vault: z.string().optional(),
      session_id: z.string().optional().describe("The browser session; the first one by default"),
      submit: z.boolean().default(false),
    },
  },
  async ({ item, url, page, vault, session_id, submit }) => {
    let id = item;
    if (!id) {
      if (!url) return failure("Give an item or a url.");
      const matches = (await search(undefined, url, vault)).filter(
        (i) => !i.category || i.category === "LOGIN",
      );
      if (matches.length === 0)
        return failure(`No login for ${hostOf(url)} in your shared vaults.`);
      if (matches.length > 1) {
        return failure(
          `Several logins match: ${matches.map((m) => `${m.title} (${m.id})`).join(", ")}. Pass one as item.`,
        );
      }
      id = matches[0]?.id;
    }
    if (!id) return failure("No login found.");
    const found = await getItem(id, vault);
    const username = found.fields?.find((f) => f.purpose === "USERNAME")?.value;
    const password = found.fields?.find((f) => f.purpose === "PASSWORD")?.value;
    if (!username || !password)
      return failure(`${found.title} has no username and password to fill.`);
    // A login is only typed into its own site, which this tool opens itself.
    const saved = (found.urls ?? []).map((u) => u.href).filter((href) => hostOf(href));
    const sites = saved.map(hostOf);
    if (saved.length === 0) {
      return failure(
        `${found.title} has no website saved, so there's nowhere safe to type it. Add the site to the item in 1Password first.`,
      );
    }
    const target = page ?? saved[0] ?? "";
    if (!sites.some((site) => sameSite(hostOf(target), site))) {
      return failure(`${hostOf(target)} isn't ${found.title}'s site (${sites.join(", ")}).`);
    }

    const browser = await computer().catch(() => null);
    if (!browser) {
      return failure("The browser isn't reachable from here, so the login can't be filled.");
    }
    try {
      let session = session_id;
      if (!session) {
        const listed = await browser.callTool({ name: "list_sessions", arguments: {} });
        const first = Array.isArray(listed.content) ? listed.content[0] : undefined;
        const body = first && "text" in first && typeof first.text === "string" ? first.text : "{}";
        session = Sessions.safeParse(JSON.parse(body)).data?.sessions[0]?.session_id;
      }
      if (!session) return failure("No browser is open.");
      const act = (name: string, args: Record<string, unknown>) =>
        browser.callTool({ name, arguments: { session_id: session, screenshot: false, ...args } });
      const tree = async () => {
        const result = await act("get_ui_tree", {});
        return parseTree(
          (Array.isArray(result.content) ? result.content : [])
            .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
            .join("\n"),
        );
      };

      // Open the site itself, so the page is the one 1Password knows, not one the agent picked.
      const bar = addressBar(await tree());
      if (!bar) return failure("Couldn't find the browser's address bar.");
      await act("click", { element: bar.id });
      await act("press_key", { keys: "ctrl+a" });
      await act("type_text", { text: target.includes("://") ? target : `https://${target}` });
      await act("press_key", { keys: "enter" });

      // Wait for it to land, then check where it landed: redirects can go elsewhere.
      let field = null;
      let landed = "";
      for (let attempt = 0; attempt < 20 && !field; attempt++) {
        await new Promise((r) => setTimeout(r, 750));
        const nodes = await tree();
        const now = addressBar(nodes);
        if (!now || now.focused) continue;
        landed = hostOf(now.value ?? "");
        if (!sites.some((site) => sameSite(landed, site))) continue;
        field = usernameField(nodes);
      }
      if (!sites.some((site) => sameSite(landed, site))) {
        return failure(
          `The browser ended up on ${landed || "an unknown page"}, not ${sites.join(", ")}. Nothing was filled.`,
        );
      }
      if (!field) {
        return failure(
          `Couldn't find a username field on ${landed}. Pass the sign-in page as page, like ${sites[0]}/login.`,
        );
      }
      await act("click", { element: field.id });
      await act("type_text", { text: username });
      await act("press_key", { keys: "tab" });
      await act("type_text", { text: password });
      if (submit) await act("press_key", { keys: "enter" });
      return text(
        `Filled the login for ${found.title} on ${landed}${submit ? " and submitted it" : ""}.`,
      );
    } finally {
      await browser.close().catch(() => undefined);
    }
  },
);

await server.connect(new StdioServerTransport());
