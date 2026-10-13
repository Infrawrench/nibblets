import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import {
  findModel,
  harnesses,
  randomHamsterLook,
  type Effort,
  type HamsterLook,
  type Nibblet,
} from "@nibblet/protocol";
import { HamsterEditor } from "./hamster/HamsterEditor.tsx";
import { Hamster } from "./hamster/Hamster.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { EffortMenu } from "./EffortMenu.tsx";
import { Modal } from "./ui/Modal.tsx";
import { Button } from "./ui/Button.tsx";
import { FieldRow, Select, Textarea } from "./ui/Field.tsx";
import { Switch } from "./ui/Switch.tsx";
import { NibbletTools, type ToolsValue } from "./tools/NibbletTools.tsx";
import { keys, useServers } from "../lib/servers.tsx";
import { useServerNames } from "../lib/useServerNames.ts";
import { nextHamsterName } from "../lib/hamsterNames.ts";

export function CreateNibbletDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const servers = useServers();
  const names = useServerNames();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<"look" | "setup">("look");
  const [look, setLook] = useState<HamsterLook>(() => randomHamsterLook());
  const [name, setName] = useState("");
  const [server, setServer] = useState("local");
  const [choice, setChoice] = useState<ModelChoice>({
    harness: "claude",
    model: harnesses.claude.defaultModel,
  });
  const [effort, setEffort] = useState<Effort>("medium");
  const [browser, setBrowser] = useState(true);
  const [tools, setTools] = useState<ToolsValue>({
    hostTools: [],
    cliCredentials: [],
    mcpServers: [],
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("look");
    setLook(randomHamsterLook());
    const taken = qc
      .getQueriesData<Nibblet[]>({ queryKey: ["nibblets"] })
      .flatMap(([, list]) => list ?? [])
      .map((n) => n.name);
    setName(nextHamsterName(taken));
    setMessage("");
    setTools({ hostTools: [], cliCredentials: [], mcpServers: [] });
    setError(null);
  }, [open]);

  const target = servers.byId(server);

  const create = async () => {
    const connection = servers.byId(server);
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      const created = await connection.client.nibblets.create({
        name: name.trim(),
        look,
        harness: choice.harness,
        model: choice.model,
        effort,
        browser,
        ...tools,
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      await qc.invalidateQueries({ queryKey: keys.nibblets(server) });
      onOpenChange(false);
      void navigate({ to: "/n/$server/$id", params: { server, id: created.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={step === "look" ? "Make a nibblet" : `Set up ${name || "your nibblet"}`}
    >
      {step === "look" ? (
        <div className="p-4">
          <HamsterEditor look={look} onChange={setLook} name={name} onNameChange={setName} />
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 p-4">
          <div className="mb-1 flex items-center gap-3">
            <Hamster look={look} size={48} status="idle" />
            <div className="text-sm text-dim">
              <span className="font-medium text-text">{name}</span> lives in its own container,
              wakes on a heartbeat, and keeps its memory on the server.
            </div>
          </div>
          {servers.all.length > 1 ? (
            <FieldRow label="Runs on">
              <Select
                value={server}
                onChange={setServer}
                options={servers.all.map((c) => ({ value: c.id, label: names.get(c.id) ?? c.id }))}
              />
            </FieldRow>
          ) : null}
          <FieldRow label="Model">
            <div className="flex items-center gap-1">
              <ModelPicker
                value={choice}
                className="border border-edge bg-field"
                onChange={(c, option) => {
                  setChoice(c);
                  if (!option.efforts.includes(effort)) setEffort(option.defaultEffort);
                }}
              />
              <EffortMenu
                model={findModel(choice.harness, choice.model)}
                value={effort}
                onChange={setEffort}
              />
            </div>
          </FieldRow>
          <FieldRow label="Browser" hint="A Chromium it and you can both drive.">
            <Switch checked={browser} onChange={setBrowser} label="Browser" />
          </FieldRow>
          {target ? <NibbletTools connection={target} value={tools} onChange={setTools} /> : null}
          <FieldRow label="First message" top>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tell it what it's for, e.g. keep an eye on my inbox and tell me about anything urgent"
            />
          </FieldRow>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      )}
      <div className="sticky bottom-0 flex items-center justify-between gap-1.5 border-t border-line bg-panel px-4 py-2.5">
        {step === "setup" ? (
          <Button variant="ghost" onClick={() => setStep("look")}>
            <ArrowLeft />
            Back
          </Button>
        ) : (
          <span />
        )}
        {step === "look" ? (
          <Button variant="primary" disabled={!name.trim()} onClick={() => setStep("setup")}>
            Next
            <ArrowRight />
          </Button>
        ) : (
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Create {name.trim() || "nibblet"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
