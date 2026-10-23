import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppGrant, AppLink, AppLinkKind, Nibblet } from "@nibblets/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { grantDraftChanged, grantDraftOf, ticked, type GrantDraft } from "../../lib/appLinks.ts";
import { keys } from "../../lib/servers.tsx";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Check } from "../tools/NibbletTools.tsx";
import { AppIcon, useAppLinks } from "./AppLinksSection.tsx";

/**
 * A nibblet's identities in the apps this server is linked to: per link, a
 * switch, and the scopes it may have, as the app groups and names them.
 * Saving asks the app for a credential of the nibblet's own, which only
 * its guard is given.
 */
export function NibbletAppLinks({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const { plugins, links } = useAppLinks(connection);
  const grants = useQuery({
    queryKey: keys.appGrants(connection.id, nibblet.id),
    queryFn: () => connection.client.nibblets.appGrants({ id: nibblet.id }),
  });
  const list = (links.data?.links ?? []).filter(
    (l) => l.state === "linked" || grants.data?.some((g) => g.linkId === l.id),
  );
  if (list.length === 0) return null;
  return (
    <>
      <SectionHeading>Linked apps</SectionHeading>
      {nibblet.parentId ? (
        <p className="text-xs text-faint">
          A sub-agent acts in linked apps as its parent, with its parent's scopes:{" "}
          {grants.data?.filter((g) => g.state === "active").length
            ? list
                .filter((l) => grants.data?.some((g) => g.linkId === l.id && g.state === "active"))
                .map((l) => l.account)
                .join(", ")
            : "none so far"}
          .
        </p>
      ) : (
        list.map((link) => (
          <GrantRow
            key={link.id}
            connection={connection}
            nibblet={nibblet}
            link={link}
            kind={plugins.data?.find((k) => k.id === link.plugin)}
            grant={grants.data?.find((g) => g.linkId === link.id)}
          />
        ))
      )}
    </>
  );
}

function GrantRow({
  connection,
  nibblet,
  link,
  kind,
  grant,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
  link: AppLink;
  kind: AppLinkKind | undefined;
  grant: AppGrant | undefined;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<GrantDraft>(() => grantDraftOf(grant));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Take what the server says once it's saved, or changed elsewhere.
  useEffect(() => setDraft(grantDraftOf(grant)), [grant?.updatedAt, grant?.state]);
  const usable = link.state === "linked";
  const description = useQuery({
    queryKey: keys.appLinkDescription(connection.id, link.id),
    queryFn: () => connection.client.appLinks.describe({ id: link.id }),
    enabled: draft.on && usable,
    staleTime: 60_000,
  });
  const dirty = grantDraftChanged(draft, grant);
  const name = kind?.name ?? link.plugin;
  const refetch = () =>
    qc.invalidateQueries({ queryKey: keys.appGrants(connection.id, nibblet.id) });

  const run = async (work: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await work();
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (on: boolean) => {
    if (on) {
      setDraft({ ...draft, on: true });
      return;
    }
    setDraft(grantDraftOf(undefined));
    // Turned off, it's revoked in the app straight away.
    if (grant) {
      void run(() =>
        connection.client.nibblets.removeAppGrant({ id: nibblet.id, linkId: link.id }),
      );
    }
  };

  const state =
    grant?.state === "revoked"
      ? {
          text: `${grant.detail ?? `Revoked in ${name}`}. Save to give it a new identity.`,
          tone: "text-warning",
        }
      : grant?.state === "revoking"
        ? { text: grant.detail ?? `Being revoked in ${name}`, tone: "text-faint" }
        : grant?.state === "active"
          ? { text: `Its own identity in ${link.account}`, tone: "text-faint" }
          : null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
      <div className="flex items-center gap-2.5">
        <AppIcon kind={kind} size={20} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{link.account}</span>
          {state ? <span className={`text-2xs ${state.tone}`}>{state.text}</span> : null}
          {!usable ? (
            <span className="text-2xs text-danger">{link.detail ?? "This link doesn't work"}</span>
          ) : null}
        </div>
        <Switch
          checked={draft.on}
          onChange={toggle}
          label={`${name} for ${nibblet.name}`}
          disabled={saving || (!usable && !grant)}
        />
      </div>
      {draft.on && usable ? (
        description.isPending ? (
          <p className="text-xs text-faint">Asking {name} what it may grant…</p>
        ) : description.error ? (
          <p className="text-xs text-danger">{description.error.message}</p>
        ) : description.data ? (
          <>
            {description.data.scopeGroups.map((group) => (
              <div key={group.title} className="flex flex-col">
                <span className="px-1.5 text-2xs font-medium text-faint">{group.title}</span>
                {group.scopes.map((scope) => (
                  <Check
                    key={scope.value}
                    checked={draft.scopes.includes(scope.value)}
                    disabled={saving}
                    onChange={(on) =>
                      setDraft({ ...draft, scopes: ticked(draft.scopes, scope.value, on) })
                    }
                  >
                    {scope.label}
                    <span className="font-mono text-2xs text-faint">{scope.value}</span>
                  </Check>
                ))}
              </div>
            ))}
            {description.data.providers?.length ? (
              <div className="flex flex-col">
                <span className="px-1.5 text-2xs font-medium text-faint">
                  Only for these (none ticked: all of them)
                </span>
                {description.data.providers.map((provider) => (
                  <Check
                    key={provider.id}
                    checked={draft.providers.includes(provider.id)}
                    disabled={saving}
                    onChange={(on) =>
                      setDraft({ ...draft, providers: ticked(draft.providers, provider.id, on) })
                    }
                  >
                    {provider.name}
                  </Check>
                ))}
              </div>
            ) : null}
          </>
        ) : null
      ) : null}
      {dirty ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span className="mr-auto text-xs text-faint">
            {draft.scopes.length === 0 ? "Tick at least one" : "Unsaved changes"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(grantDraftOf(grant))}
            disabled={saving}
          >
            Undo
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || draft.scopes.length === 0}
            onClick={() =>
              void run(() =>
                connection.client.nibblets.setAppGrant({
                  id: nibblet.id,
                  linkId: link.id,
                  scopes: draft.scopes,
                  providers: draft.providers,
                }),
              )
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
