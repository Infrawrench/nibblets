import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Moon, Pencil, Power, Trash2 } from "lucide-react";
import { findModel, type Heartbeat, type Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { Hamster } from "../hamster/Hamster.tsx";
import { HamsterDialog } from "../hamster/HamsterDialog.tsx";
import { ModelPicker } from "../ModelPicker.tsx";
import { EffortMenu } from "../EffortMenu.tsx";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading, Textarea } from "../ui/Field.tsx";
import { Switch } from "../ui/Switch.tsx";
import { NibbletTools } from "../tools/NibbletTools.tsx";

export function NibbletSettings({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(nibblet.name);
  const [instructions, setInstructions] = useState(nibblet.instructions);
  const [heartbeat, setHeartbeat] = useState<Heartbeat>(nibblet.heartbeat);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Take server-side changes when this is a different nibblet.
  useEffect(() => {
    setName(nibblet.name);
    setInstructions(nibblet.instructions);
    setHeartbeat(nibblet.heartbeat);
  }, [nibblet.id]);

  const dirty =
    name !== nibblet.name ||
    instructions !== nibblet.instructions ||
    JSON.stringify(heartbeat) !== JSON.stringify(nibblet.heartbeat);
  const update = connection.client.nibblets.update;
  const hours = heartbeat.activeHours;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-2.5">
        <Hamster look={nibblet.look} size={56} status={nibblet.status} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{nibblet.name}</span>
          <span className="text-2xs text-faint">
            {findModel(nibblet.harness, nibblet.model)?.label ?? nibblet.model}
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
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </FieldRow>
      <FieldRow
        label="Instructions"
        top
        hint="It keeps these up to date from your chats. Edit them if you like."
      >
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          className="min-h-24"
        />
      </FieldRow>

      <SectionHeading>Model</SectionHeading>
      <FieldRow label="Model">
        <div className="flex items-center gap-1">
          <ModelPicker
            value={{ harness: nibblet.harness, model: nibblet.model }}
            className="border border-edge bg-field"
            onChange={(choice, option) =>
              void update({
                id: nibblet.id,
                ...choice,
                effort: option.efforts.includes(nibblet.effort)
                  ? nibblet.effort
                  : option.defaultEffort,
              })
            }
          />
          <EffortMenu
            model={findModel(nibblet.harness, nibblet.model)}
            value={nibblet.effort}
            onChange={(effort) => void update({ id: nibblet.id, effort })}
          />
        </div>
      </FieldRow>
      <FieldRow label="Browser" hint="A Chromium it and you can both drive.">
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
        }}
        onChange={(tools) => void update({ id: nibblet.id, ...tools })}
      />

      <SectionHeading>Heartbeat</SectionHeading>
      <FieldRow label="Enabled">
        <Switch
          checked={heartbeat.enabled}
          onChange={(enabled) => setHeartbeat({ ...heartbeat, enabled })}
          label="Heartbeat"
        />
      </FieldRow>
      <FieldRow label="Every" hint="Minutes between check-ins.">
        <Input
          type="number"
          min={1}
          max={1440}
          value={heartbeat.everyMinutes}
          onChange={(e) =>
            setHeartbeat({ ...heartbeat, everyMinutes: Math.max(1, Number(e.target.value) || 1) })
          }
          className="w-24"
        />
      </FieldRow>
      <FieldRow label="Active hours" hint={hours ? `In ${hours.timezone}` : "Around the clock"}>
        <div className="flex items-center gap-1.5">
          <Switch
            checked={hours !== null}
            onChange={(on) =>
              setHeartbeat({
                ...heartbeat,
                activeHours: on ? { start: "08:00", end: "22:00", timezone } : null,
              })
            }
            label="Limit to active hours"
          />
          {hours ? (
            <>
              <Input
                type="time"
                value={hours.start}
                onChange={(e) =>
                  setHeartbeat({ ...heartbeat, activeHours: { ...hours, start: e.target.value } })
                }
                className="w-24"
              />
              <span className="text-faint">to</span>
              <Input
                type="time"
                value={hours.end}
                onChange={(e) =>
                  setHeartbeat({ ...heartbeat, activeHours: { ...hours, end: e.target.value } })
                }
                className="w-24"
              />
            </>
          ) : null}
        </div>
      </FieldRow>
      <FieldRow
        label="Checklist"
        top
        hint="What to look at on each heartbeat. Empty uses the default."
      >
        <Textarea
          value={heartbeat.prompt ?? ""}
          onChange={(e) => setHeartbeat({ ...heartbeat, prompt: e.target.value || null })}
          placeholder="Check my inbox for anything urgent…"
        />
      </FieldRow>

      <div className="flex justify-end gap-1.5 pt-1">
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || saving || !name.trim()}
          onClick={async () => {
            setSaving(true);
            try {
              await update({ id: nibblet.id, name: name.trim(), instructions, heartbeat });
            } finally {
              setSaving(false);
            }
          }}
        >
          Save changes
        </Button>
      </div>

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
