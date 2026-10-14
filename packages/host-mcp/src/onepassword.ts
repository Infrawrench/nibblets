import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  OnePasswordStatus,
  type OnePasswordVault,
  type SharedVault,
  type VaultGrant,
} from "@nibblet/protocol";
import { z } from "zod";
import type { Run } from "./clis/cli.ts";

/**
 * 1Password on the host, through its CLI connected to the desktop app. A
 * nibblet given vaults gets its own service account scoped to exactly those
 * vaults; its token is kept on this computer and handed to the server only
 * when the nibblet's container is configured.
 *
 * The CLI can create service accounts but not delete them, so each one is
 * made to expire after `LIFETIME_DAYS` and is replaced before then. One that
 * stops being needed simply runs out; it can also be revoked by hand on
 * 1Password.com under Developer → Service accounts.
 */

const LIFETIME_DAYS = 30;
const RENEW_WITHIN_MS = 5 * 86_400_000;
/** The built-in vaults a service account can never be given. */
const UNSHAREABLE = new Set(["personal", "private", "employee"]);

const AccountList = z.array(
  z.looseObject({ email: z.string().optional(), url: z.string().optional() }),
);
const VaultList = z.array(
  z.looseObject({ id: z.string(), name: z.string(), type: z.string().optional() }),
);

export async function onePasswordStatus(run: Run): Promise<OnePasswordStatus> {
  const version = await run("op", ["--version"]);
  if (version.code !== 0) {
    return { state: "not_installed", account: null, vaults: [], detail: null };
  }
  const accounts = await run("op", ["account", "list", "--format", "json"]);
  const list = parseJson(AccountList, accounts.stdout) ?? [];
  if (accounts.code !== 0 || list.length === 0) {
    return {
      state: "not_connected",
      account: null,
      vaults: [],
      detail: "Turn on Settings → Developer → Integrate with 1Password CLI in the 1Password app.",
    };
  }
  const first = list[0];
  const account = first?.email ? `${first.email}${first.url ? ` on ${first.url}` : ""}` : null;
  const vaults = await run("op", ["vault", "list", "--format", "json"]);
  if (vaults.code !== 0) {
    // Usually the 1Password app asking to allow access, which was declined or timed out.
    return {
      state: "connected",
      account,
      vaults: [],
      detail: "1Password didn't allow access to the vault list. Unlock the app and try again.",
    };
  }
  return {
    state: "connected",
    account,
    vaults: (parseJson(VaultList, vaults.stdout) ?? []).map(toVault),
    detail: null,
  };
}

function toVault(v: z.infer<typeof VaultList>[number]): OnePasswordVault {
  const builtIn = v.type !== undefined && v.type !== "USER_CREATED";
  return {
    id: v.id,
    name: v.name,
    shareable: !UNSHAREABLE.has(v.name.toLowerCase()) && !(builtIn && v.type === "PERSONAL"),
  };
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What's kept per nibblet: the token and enough to renew it. */
const Stored = z.object({
  token: z.string(),
  fingerprint: z.string(),
  vaults: z.array(z.object({ name: z.string(), access: z.enum(["read", "write"]) })),
  label: z.string(),
  expiresAt: z.number(),
});
type Stored = z.infer<typeof Stored>;

export interface TokenStore {
  get(nibbletId: string): Promise<Stored | null>;
  set(nibbletId: string, value: Stored): Promise<void>;
  delete(nibbletId: string): Promise<void>;
}

/** A 0600 JSON file per nibblet under `~/.config/nibblet-secrets/1password`. */
export function fileTokenStore(
  dir = join(homedir(), ".config", "nibblet-secrets", "1password"),
): TokenStore {
  const path = (id: string) => join(dir, `${id.replace(/[^\w-]/g, "_")}.json`);
  return {
    async get(id) {
      try {
        return Stored.parse(JSON.parse(await readFile(path(id), "utf8")));
      } catch {
        return null;
      }
    },
    async set(id, value) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path(id), JSON.stringify(value), { mode: 0o600 });
    },
    async delete(id) {
      await rm(path(id), { force: true });
    },
  };
}

/**
 * Where tokens are kept: a private file per nibblet on every platform. Not
 * the macOS keychain: `security -i` silently truncates command lines over
 * about 4 KB, which a token plus its metadata, hex-encoded, can exceed.
 */
export function defaultTokenStore(): TokenStore {
  return fileTokenStore();
}

/** The `--vault` arguments for a set of grants. Names with `:` or `,` can't be expressed. */
export function vaultFlags(vaults: readonly SharedVault[]): string[] {
  return vaults.flatMap((v) => {
    if (/[:,]/.test(v.name)) throw new Error(`The vault name "${v.name}" can't contain : or ,`);
    return [
      "--vault",
      `${v.name}:${v.access === "write" ? "read_items,write_items" : "read_items"}`,
    ];
  });
}

export function fingerprint(vaults: readonly SharedVault[]): string {
  const sorted = [...vaults].sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export class OnePasswordGrantsManager {
  private readonly run: Run;
  private readonly store: TokenStore;
  private readonly now: () => number;

  constructor(run: Run, store: TokenStore, now: () => number = Date.now) {
    this.run = run;
    this.store = store;
    this.now = now;
  }

  /**
   * Gives a nibblet exactly these vaults: a new service account if the set
   * changed or the old one is near its expiry, nothing if it's unchanged,
   * and forgetting the token if there are none left.
   */
  async grant(nibbletId: string, label: string, grants: readonly VaultGrant[]): Promise<void> {
    if (grants.length === 0) {
      await this.store.delete(nibbletId);
      return;
    }
    const status = await onePasswordStatus(this.run);
    if (status.state !== "connected") {
      throw new Error(status.detail ?? "1Password isn't connected on this computer");
    }
    const vaults: SharedVault[] = grants.map((g) => {
      const vault = status.vaults.find((v) => v.id === g.vaultId);
      if (!vault) throw new Error("One of those vaults isn't in this 1Password account");
      if (!vault.shareable) throw new Error(`The ${vault.name} vault can't be shared`);
      return { name: vault.name, access: g.access };
    });
    const existing = await this.store.get(nibbletId);
    if (existing && existing.fingerprint === fingerprint(vaults) && !this.dueForRenewal(existing)) {
      return;
    }
    await this.create(nibbletId, label, vaults);
  }

  /** The token and vault names for a nibblet, renewing the account first if it's about to expire. */
  async token(nibbletId: string): Promise<{ token: string; vaults: SharedVault[] } | null> {
    let stored = await this.store.get(nibbletId);
    if (!stored) return null;
    if (this.dueForRenewal(stored)) {
      stored = await this.create(nibbletId, stored.label, stored.vaults).catch(() => stored);
    }
    if (!stored || stored.expiresAt <= this.now()) return null;
    return { token: stored.token, vaults: stored.vaults };
  }

  private dueForRenewal(stored: Stored): boolean {
    return stored.expiresAt - this.now() < RENEW_WITHIN_MS;
  }

  private async create(nibbletId: string, label: string, vaults: SharedVault[]): Promise<Stored> {
    const name = `Nibblet: ${label}`.slice(0, 60);
    const created = await this.run("op", [
      "service-account",
      "create",
      name,
      "--expires-in",
      `${LIFETIME_DAYS}d`,
      ...vaultFlags(vaults),
      "--raw",
    ]);
    const token = created.stdout.trim();
    if (created.code !== 0 || !token.startsWith("ops_")) {
      // The CLI's message, never its output, which on success is the token.
      throw new Error(
        created.stderr.trim().split("\n").at(-1) ||
          "1Password didn't create the access. Check the 1Password app for a prompt.",
      );
    }
    const stored: Stored = {
      token,
      fingerprint: fingerprint(vaults),
      vaults,
      label,
      expiresAt: this.now() + LIFETIME_DAYS * 86_400_000,
    };
    await this.store.set(nibbletId, stored);
    return stored;
  }
}

export const GrantRequest = z.object({
  label: z.string().min(1).max(80),
  grants: z.array(z.object({ vaultId: z.string(), access: z.enum(["read", "write"]) })),
});

export { OnePasswordStatus };
