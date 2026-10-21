import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Moon, Pencil, Power, Trash2 } from "lucide-react";
import type { Heartbeat, Nibblet } from "@nibblet/protocol";
import { HeartPulse } from "lucide-react";
import { modelLabel, useModels } from "../../lib/models.ts";
import type { ServerConnection } from "../../lib/connection.ts";
import { Hamster } from "../hamster/Hamster.tsx";
import { HamsterDialog } from "../hamster/HamsterDialog.tsx";
import { ModelPicker } from "../ModelPicker.tsx";
import { EffortMenu } from "../EffortMenu.tsx";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading, Textarea } from "../ui/Field.tsx";
import { Switch } from "../ui/Switch.tsx";
import { NibbletTools } from "../tools/NibbletTools.tsx";
import { PromptNameField } from "../PromptNameField.tsx";
import { NibbletVaults } from "../onepassword/OnePasswordSection.tsx";
import { ResourcesSection } from "./ResourcesSection.tsx";
import { TailscaleSection } from "./TailscaleSection.tsx";

export function NibbletSettings({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const navigate = useNavigate();
  const catalogue = useModels(connection);
  const [name, setName] = useState(nibblet.name);
  const [instructions, setInstructions] = useState(nibblet.instructions);
  const [promptName, setPromptName] = useState(nibblet.promptName);
  // Bumped to start the name field over from what's saved.
  const [resets, setResets] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Take server-side changes when this is a different nibblet.
  useEffect(() => {
    setName(nibblet.name);
    setInstructions(nibblet.instructions);
    setPromptName(nibblet.promptName);
    setSaveError(null);
  }, [nibblet.id]);

  const promptNameTrimmed = promptName?.trim() ?? null;
  const dirty =
    name !== nibblet.name ||
    instructions !== nibblet.instructions ||
    promptNameTrimmed !== nibblet.promptName;
  const update = connection.client.nibblets.update;

  const save = async () => {
    if (!dirty || saving || !name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update({
        id: nibblet.id,
        name: name.trim(),
        instructions,
        promptName: promptNameTrimmed,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const undo = () => {
    setName(nibblet.name);
    setInstructions(nibblet.instructions);
    setPromptName(nibblet.promptName);
    setResets((n) => n + 1);
    setSaveError(null);
  };
  // ⌘↩ (or Ctrl+Enter) saves from either field.
  const saveOnShortcut = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-2.5">
        <Hamster look={nibblet.look} size={56} status={nibblet.status} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{nibblet.name}</span>
          <span className="text-2xs text-faint">
            {modelLabel(catalogue.find(nibblet.harness, nibblet.model), nibblet.model)}
          </span>
        </div>
        <Button size="sm" onClick={() => setEditing(true)}>
          <Pencil />
          Edit look
        </Button>
      </div>
      <HamsterDialog
        open={editing}
        onOpenChange={setEditing}
        initial={nibblet.look}
        title={`Dress up ${nibblet.name}`}
        onSave={(look) => void update({ id: nibblet.id, look })}
      />

      <SectionHeading>Identity</SectionHeading>
      <FieldRow label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={saveOnShortcut}
          maxLength={80}
        />
      </FieldRow>
      <PromptNameField
        key={`${nibblet.id}:${resets}`}
        value={promptName}
        onChange={setPromptName}
        onKeyDown={saveOnShortcut}
      />
      <FieldRow
        label="Instructions"
        top
        hint="It keeps these up to date from your chats. Edit them if you like."
      >
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={saveOnShortcut}
          className="min-h-24"
        />
      </FieldRow>
      {dirty || saveError ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:pl-[7.75rem]">
          {saveError ? (
            <span className="mr-auto text-xs text-danger">Couldn't save: {saveError}</span>
          ) : (
            <span className="mr-auto text-xs text-faint">Unsaved changes</span>
          )}
          <Button size="sm" variant="ghost" onClick={undo} disabled={saving}>
            Undo
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || saving || !name.trim()}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
      <FieldRow
        label="Plain"
        hint="It isn't told it's a hamster, and keeps emoji and cute stuff out of its replies."
      >
        <Switch
          checked={nibblet.plain}
          onChange={(plain) => void update({ id: nibblet.id, plain })}
          label="Plain"
        />
      </FieldRow>

      <SectionHeading>Model</SectionHeading>
      <FieldRow label="Model">
        <div className="flex items-center gap-1">
          <ModelPicker
            catalogue={catalogue}
            value={{ harness: nibblet.harness, model: nibblet.model }}
            className="border border-edge bg-field"
            onChange={(choice, option) =>
              void update({
                id: nibblet.id,
                ...choice,
                effort:
                  option.efforts.length === 0 || option.efforts.includes(nibblet.effort)
                    ? nibblet.effort
                    : option.defaultEffort,
              })
            }
          />
          <EffortMenu
            model={catalogue.find(nibblet.harness, nibblet.model)}
            value={nibblet.effort}
            onChange={(effort) => void update({ id: nibblet.id, effort })}
          />
        </div>
      </FieldRow>
      <FieldRow
        label="Browser"
        hint="A Chromium, and a desktop for other apps, that it and you can both drive."
      >
        <Switch
          checked={nibblet.browser}
          onChange={(browser) => void update({ id: nibblet.id, browser })}
          label="Browser"
        />
      </FieldRow>

      <NibbletTools
        connection={connection}
        value={{
          hostTools: nibblet.hostTools,
          cliCredentials: nibblet.cliCredentials,
          mcpServers: nibblet.mcpServers,
          toolApprovals: nibblet.toolApprovals,
        }}
        browser={nibblet.browser}
        onChange={(tools) => void update({ id: nibblet.id, ...tools })}
      />

      <NibbletVaults connection={connection} nibblet={nibblet} />

      <TailscaleSection connection={connection} nibblet={nibblet} />

      <ResourcesSection connection={connection} nibblet={nibblet} />

      <SectionHeading>Heartbeats</SectionHeading>
      <HeartbeatSummary
        nibblet={nibblet}
        onWake={() => void connection.client.nibblets.wake({ id: nibblet.id })}
      />

      <SectionHeading>Lifecycle</SectionHeading>
      <div className="flex flex-wrap gap-1.5">
        {nibblet.status === "stopped" ? (
          <Button
            size="sm"
            onClick={() => void connection.client.nibblets.start({ id: nibblet.id })}
          >
            <Power />
            Wake up
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void connection.client.nibblets.stop({ id: nibblet.id })}
          >
            <Moon />
            Put to sleep
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          onClick={async () => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            await connection.client.nibblets.delete({ id: nibblet.id });
            void navigate({ to: "/" });
          }}
          onBlur={() => setConfirmDelete(false)}
        >
          <Trash2 />
          {confirmDelete ? "Really delete?" : "Delete"}
        </Button>
      </div>
    </div>
  );
}

function every(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} min`;
}

function when(h: Heartbeat): string {
  const hours = h.activeHours
    ? `, ${h.activeHours.start} to ${h.activeHours.end} (${h.activeHours.timezone})`
    : "";
  return `${every(h.everyMinutes)}${hours}`;
}

/**
 * The heartbeats are the nibblet's to run: it adds one per thing it's
 * keeping an eye on, each with its own interval, hours and checklist, using
 * the `heartbeat_*` tools. Here they're shown, not edited.
 */
function HeartbeatSummary({ nibblet, onWake }: { nibblet: Nibblet; onWake: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5 text-xs">
      {nibblet.heartbeats.length === 0 ? (
        <div className="flex items-center gap-2">
          <HeartPulse className="size-3.5 text-faint" />
          <span className="flex-1 text-dim">None yet</span>
        </div>
      ) : (
        nibblet.heartbeats.map((h) => (
          <div key={h.name} className="flex gap-2">
            <HeartPulse className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div>
                <span className="font-medium">{h.name}</span>
                <span className="text-dim"> · {when(h)}</span>
              </div>
              {h.checklist ? <p className="whitespace-pre-wrap text-dim">{h.checklist}</p> : null}
            </div>
          </div>
        ))
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <p className="flex-1 text-faint">
          {nibblet.name} sets these itself as it learns what to keep an eye on. Ask it in the chat
          to change them.
        </p>
        <Button size="sm" variant="ghost" onClick={onWake} title="Run a check-in now">
          Check in now
        </Button>
      </div>
    </div>
  );
}
