import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Copy, CreditCard, KeyRound, Wallet } from "lucide-react";
import type { BankField, BankInstrument, BankKind, BankStatus } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import {
  bankDraftChanged,
  bankDraftOf,
  bankSettingsOf,
  missingField,
  newPrivateKey,
  secretSaved,
  type BankDraft,
} from "../../lib/bank.ts";
import { keys } from "../../lib/servers.tsx";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, Select } from "../ui/Field.tsx";
import { Modal } from "../ui/Modal.tsx";

export const instrumentIcons: Record<BankInstrument, typeof CreditCard> = {
  card: CreditCard,
  wallet: Wallet,
};

/**
 * Setting a bank up, or changing one: a choice of the banks the server
 * knows, then the form its plugin describes. Nothing here knows one bank
 * from another; each plugin says what it needs (`BankKind.fields`).
 */
export function BankDialog({
  connection,
  kinds,
  chosen,
  onClose,
}: {
  connection: ServerConnection;
  kinds: readonly BankKind[];
  /** A bank's id to open its form, null to choose one to add, undefined when closed. */
  chosen: string | null | undefined;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [chosen]);
  const id = chosen ?? picked;
  const kind = kinds.find((k) => k.id === id) ?? null;
  const title = kind ? (kind.source ? kind.name : `Set up ${kind.name}`) : "Add a bank";
  return (
    <Modal
      open={chosen !== undefined}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={title}
      className="w-[min(94vw,560px)]"
    >
      {kind ? (
        <BankForm
          key={kind.id}
          connection={connection}
          kind={kind}
          onBack={chosen === null ? () => setPicked(null) : null}
          onDone={onClose}
        />
      ) : (
        <BankChoice kinds={kinds.filter((k) => k.source === null)} onChoose={setPicked} />
      )}
    </Modal>
  );
}

function BankChoice({
  kinds,
  onChoose,
}: {
  kinds: readonly BankKind[];
  onChoose: (id: string) => void;
}) {
  if (kinds.length === 0) {
    return <p className="p-4 text-sm text-dim">Every bank this server knows is set up.</p>;
  }
  return (
    <div className="flex flex-col gap-1 p-3">
      {kinds.map((kind) => {
        const Icon = instrumentIcons[kind.instrument];
        return (
          <button
            key={kind.id}
            type="button"
            onClick={() => onChoose(kind.id)}
            className="flex items-center gap-3 rounded-lg border border-edge px-3 py-2.5 text-left hover:bg-hover"
          >
            <Icon className="size-5 shrink-0 text-dim" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{kind.name}</span>
              <span className="text-xs text-faint">{kind.about}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-faint" />
          </button>
        );
      })}
    </div>
  );
}

function BankForm({
  connection,
  kind,
  onBack,
  onDone,
}: {
  connection: ServerConnection;
  kind: BankKind;
  onBack: (() => void) | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<BankDraft>(() => bankDraftOf(kind));
  /** Keys the form made, shown in the clear so they can be copied before they're saved. */
  const [generated, setGenerated] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = missingField(kind, draft);
  const changed = kind.source === null || bankDraftChanged(kind, draft);
  const locked = (field: BankField) =>
    field.lockedByCards && kind.source !== null && kind.liveCards > 0;

  const run = async (call: () => Promise<BankStatus>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(keys.bank(connection.id), await call());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() =>
      connection.client.bank.configure({ id: kind.id, settings: bankSettingsOf(kind, draft) }),
    );
  const remove = () => run(() => connection.client.bank.remove({ id: kind.id }));

  return (
    <>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-dim">
          {kind.about}
          {kind.source === "env"
            ? " It's set up from the server's environment now; saving here takes over from that."
            : null}
        </p>
        {kind.fields.map((field) => (
          <FieldRow
            key={field.key}
            label={field.label}
            top
            hint={
              locked(field)
                ? `Can't change while ${kind.name} has cards that aren't closed.`
                : (field.hint ?? undefined)
            }
          >
            <FieldInput
              field={field}
              value={draft[field.key] ?? ""}
              saved={secretSaved(kind, field)}
              shown={generated.has(field.key)}
              disabled={busy || locked(field)}
              onChange={(value) => setDraft({ ...draft, [field.key]: value })}
              onGenerate={() => {
                setDraft({ ...draft, [field.key]: newPrivateKey() });
                setGenerated(new Set([...generated, field.key]));
              }}
            />
          </FieldRow>
        ))}
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-1.5 border-t border-line bg-panel px-4 py-2.5">
        {onBack ? (
          <Button variant="ghost" disabled={busy} onClick={onBack}>
            <ArrowLeft />
            Back
          </Button>
        ) : null}
        {kind.source === "saved" ? (
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        ) : null}
        <span className={`mr-auto min-w-0 flex-1 text-xs ${error ? "text-danger" : "text-faint"}`}>
          {error
            ? error
            : missing
              ? `${missing.label} is needed.`
              : `It's checked with ${kind.name} when you save.`}
        </span>
        <Button
          variant="primary"
          disabled={busy || missing !== null || !changed}
          onClick={() => void save()}
        >
          {busy ? "Checking…" : kind.source ? "Save" : `Set up ${kind.name}`}
        </Button>
      </div>
    </>
  );
}

function FieldInput({
  field,
  value,
  saved,
  shown,
  disabled,
  onChange,
  onGenerate,
}: {
  field: BankField;
  value: string;
  /** A secret's saved, so empty keeps it. */
  saved: boolean;
  /** A secret made here, shown so it can be copied. */
  shown: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onGenerate: () => void;
}) {
  if (field.options) {
    const options =
      value === "" ? [{ value: "", label: "Choose…" }, ...field.options] : field.options;
    return <Select options={options} value={value} disabled={disabled} onChange={onChange} />;
  }
  const input = (
    <Input
      type={field.secret && !shown ? "password" : "text"}
      autoComplete="off"
      spellCheck={false}
      value={value}
      disabled={disabled}
      className={shown ? "font-mono text-xs" : undefined}
      placeholder={
        saved ? "Saved. Paste a new one to replace it" : (field.placeholder ?? undefined)
      }
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (!field.generate) return input;
  return (
    <span className="flex gap-1.5">
      {input}
      {shown ? (
        <Button
          title="Copy"
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard.writeText(value);
          }}
        >
          <Copy />
          Copy
        </Button>
      ) : (
        <Button
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            onGenerate();
          }}
        >
          <KeyRound />
          Make one
        </Button>
      )}
    </span>
  );
}
