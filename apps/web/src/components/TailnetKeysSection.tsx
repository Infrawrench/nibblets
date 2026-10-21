import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MASKED, TailnetTag, type TailnetOAuth } from "@nibblets/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import { keys } from "../lib/servers.tsx";
import { Button } from "./ui/Button.tsx";
import { FieldRow, Input, SectionHeading } from "./ui/Field.tsx";

const OAUTH_URL = "https://login.tailscale.com/admin/settings/oauth";

interface Draft {
  clientId: string;
  /** Empty keeps the saved secret. */
  clientSecret: string;
  tags: string;
}

const draftOf = (oauth: TailnetOAuth | null | undefined): Draft => ({
  clientId: oauth?.clientId ?? "",
  clientSecret: "",
  tags: oauth?.tags.join(", ") ?? "tag:nibblet",
});

/** The tags typed in, or what's wrong with them. */
export function parseTags(text: string): { tags: string[] } | { error: string } {
  const tags = text.split(/[\s,]+/).filter(Boolean);
  if (tags.length === 0) return { error: "Give at least one tag" };
  const bad = tags.find((t) => !TailnetTag.safeParse(t).success);
  return bad ? { error: `${bad}: tags look like tag:nibblet` } : { tags };
}

/**
 * A Tailscale OAuth client the server makes auth keys with, so nibblets can
 * join the tailnet without a key pasted into each. The secret stays on the
 * server; nibblets only get single-use keys made from it.
 */
export function TailnetKeysSection({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const key = keys.tailnetKeys(connection.id);
  const query = useQuery({ queryKey: key, queryFn: () => connection.client.tailscale.keys({}) });
  const saved = query.data?.oauth ?? null;
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(draftOf(saved)), [JSON.stringify(saved)]);

  const tags = parseTags(draft.tags);
  const dirty = !saved
    ? draft.clientId.trim() !== "" || draft.clientSecret.trim() !== ""
    : draft.clientId.trim() !== saved.clientId ||
      draft.clientSecret.trim() !== "" ||
      ("tags" in tags && tags.tags.join(",") !== saved.tags.join(","));

  const set = async (oauth: TailnetOAuth | null) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(key, await connection.client.tailscale.setKeys({ oauth }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!("tags" in tags)) return;
    void set({
      clientId: draft.clientId.trim(),
      clientSecret: draft.clientSecret.trim() || (saved ? MASKED : ""),
      tags: tags.tags,
    });
  };

  return (
    <>
      <SectionHeading>Tailscale for nibblets</SectionHeading>
      <p className="text-xs text-dim">
        With an OAuth client, a nibblet you put on your tailnet gets its own auth key when it joins,
        so you don't paste one into each. Make one in{" "}
        <a href={OAUTH_URL} target="_blank" rel="noreferrer" className="text-accent">
          Tailscale's admin console
        </a>{" "}
        with the Auth Keys write scope and the tags below. Its secret stays on this server.
      </p>
      <FieldRow label="Client ID">
        <Input
          value={draft.clientId}
          autoComplete="off"
          onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
          placeholder="k123AbCDEF11CNTRL"
        />
      </FieldRow>
      <FieldRow label="Client secret">
        <Input
          type="password"
          autoComplete="off"
          value={draft.clientSecret}
          onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
          placeholder={saved ? "Saved. Paste a new one to replace it" : "tskey-client-…"}
        />
      </FieldRow>
      <FieldRow
        label="Tags"
        hint="Keys made with an OAuth client must be tagged. The client has to own these."
      >
        <Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
      </FieldRow>
      {dirty || error || saved ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:pl-[7.75rem]">
          <span
            className={`mr-auto text-xs ${error || (dirty && "error" in tags) ? "text-danger" : "text-faint"}`}
          >
            {error
              ? `Couldn't save: ${error}`
              : dirty && "error" in tags
                ? tags.error
                : dirty
                  ? "It's checked with Tailscale when you save."
                  : "Set up: nibblets without a key of their own get one from it."}
          </span>
          {saved ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void set(null)}>
              Remove
            </Button>
          ) : null}
          {dirty ? (
            <Button
              variant="primary"
              size="sm"
              disabled={
                busy ||
                "error" in tags ||
                !draft.clientId.trim() ||
                (!saved && !draft.clientSecret.trim())
              }
              onClick={save}
            >
              {busy ? "Checking…" : "Save"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
