import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ChevronRight, Laptop, Loader2 } from "lucide-react";
import {
  harnesses,
  randomHamsterLook,
  type Effort,
  type HamsterLook,
  type Nibblet,
  type VaultGrant,
} from "@nibblet/protocol";
import { HamsterEditor } from "./hamster/HamsterEditor.tsx";
import { Hamster } from "./hamster/Hamster.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { EffortMenu } from "./EffortMenu.tsx";
import { Modal } from "./ui/Modal.tsx";
import { Button } from "./ui/Button.tsx";
import { FieldRow, Textarea } from "./ui/Field.tsx";
import { Switch } from "./ui/Switch.tsx";
import { NibbletTools, type ToolsValue } from "./tools/NibbletTools.tsx";
import { NewNibbletVaults } from "./onepassword/OnePasswordSection.tsx";
import { keys, useServers, type System } from "../lib/servers.tsx";
import { nextHamsterName } from "../lib/hamsterNames.ts";
import { useModels } from "../lib/models.ts";
import { cn } from "../lib/cn.ts";

export function CreateNibbletDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const servers = useServers();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // With more than one computer, which one comes first: it shapes what's on offer later.
  const choosing = servers.systems.length > 1;
  const [step, setStep] = useState<"computer" | "look" | "setup">("look");
  const [look, setLook] = useState<HamsterLook>(() => randomHamsterLook());
  const [name, setName] = useState("");
  const [server, setServer] = useState(() => servers.all[0]?.id ?? "local");
  const [choice, setChoice] = useState<ModelChoice>({
    harness: "claude",
    model: harnesses.claude.defaultModel,
  });
  const [effort, setEffort] = useState<Effort>("medium");
  const [browser, setBrowser] = useState(true);
  const [vaults, setVaults] = useState<VaultGrant[]>([]);
  const [tools, setTools] = useState<ToolsValue>({
    hostTools: [],
    cliCredentials: [],
    mcpServers: [],
    toolApprovals: [],
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(choosing ? "computer" : "look");
    // The list may have loaded since this mounted; start on the first one reachable, this computer's if any.
    if (!servers.byId(server)) setServer(servers.all[0]?.id ?? "local");
    setLook(randomHamsterLook());
    const taken = qc
      .getQueriesData<Nibblet[]>({ queryKey: ["nibblets"] })
      .flatMap(([, list]) => list ?? [])
      .map((n) => n.name);
    setName(nextHamsterName(taken));
    setMessage("");
    setTools({ hostTools: [], cliCredentials: [], mcpServers: [], toolApprovals: [] });
    setError(null);
  }, [open]);

  const target = servers.byId(server);
  const catalogue = useModels(target);

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
      if (vaults.length > 0) {
        // Its own 1Password access is made once it exists; failing that isn't a reason to stop.
        await connection.client.onePassword
          .setGrants({ nibbletId: created.id, grants: vaults })
          .catch(() => undefined);
      }
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
      title={
        step === "computer"
          ? "Which computer should it live on?"
          : step === "look"
            ? "Make a nibblet"
            : `Set up ${name || "your nibblet"}`
      }
    >
      {step === "computer" ? (
        <ComputerList
          systems={servers.systems}
          chosen={server}
          onChoose={(id) => {
            setServer(id);
            setStep("look");
          }}
        />
      ) : step === "look" ? (
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
          {choosing ? (
            <FieldRow label="Runs on">
              <button
                type="button"
                onClick={() => setStep("computer")}
                className="flex items-center gap-1.5 text-sm text-dim hover:text-text"
              >
                <Laptop className="size-3.5" />
                {servers.system(server)?.name ?? server}
              </button>
            </FieldRow>
          ) : null}
          <FieldRow label="Model">
            <div className="flex items-center gap-1">
              <ModelPicker
                value={choice}
                catalogue={catalogue}
                className="border border-edge bg-field"
                onChange={(c, option) => {
                  setChoice(c);
                  if (option.efforts.length > 0 && !option.efforts.includes(effort))
                    setEffort(option.defaultEffort);
                }}
              />
              <EffortMenu
                model={catalogue.find(choice.harness, choice.model)}
                value={effort}
                onChange={setEffort}
              />
            </div>
          </FieldRow>
          <FieldRow label="Browser" hint="A Chromium it and you can both drive.">
            <Switch checked={browser} onChange={setBrowser} label="Browser" />
          </FieldRow>
          {target ? (
            <>
              <NibbletTools
                connection={target}
                value={tools}
                onChange={setTools}
                browser={browser}
              />
              <NewNibbletVaults connection={target} value={vaults} onChange={setVaults} />
            </>
          ) : null}
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
        {step === "setup" || (step === "look" && choosing) ? (
          <Button variant="ghost" onClick={() => setStep(step === "setup" ? "look" : "computer")}>
            <ArrowLeft />
            Back
          </Button>
        ) : (
          <span />
        )}
        {step === "computer" ? null : step === "look" ? (
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

/** The computers a nibblet could live on; ones that can't be reached are shown but can't be picked. */
function ComputerList({
  systems,
  chosen,
  onChoose,
}: {
  systems: System[];
  chosen: string;
  onChoose: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 p-3">
      {systems.map((system) => {
        const reachable = system.connection !== null;
        return (
          <button
            key={system.id}
            type="button"
            disabled={!reachable}
            onClick={() => onChoose(system.id)}
            className={cn(
              "flex items-center gap-3 rounded-lg border border-edge px-3 py-2.5 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
              system.id === chosen && reachable && "border-accent",
            )}
          >
            <Laptop className="size-5 shrink-0 text-dim" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{system.name}</span>
              <span className="text-2xs text-faint">
                {reachable
                  ? [system.local ? "This computer" : null, platformName(system.platform)]
                      .filter((part) => part !== null)
                      .join(" · ") || "Ready"
                  : "Offline"}
              </span>
            </span>
            {reachable ? <ChevronRight className="size-4 text-faint" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function platformName(platform: string | null): string | null {
  switch (platform) {
    case "darwin":
      return "Mac";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return null;
  }
}
