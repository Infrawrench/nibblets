import { useEffect, useState } from "react";
import type { PaymentAccount, PaymentProviderInfo, SetupField } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, Select } from "../ui/Field.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Segmented } from "../ui/Segmented.tsx";

/**
 * Adding or changing a payment account, in two steps: credentials, which
 * the server checks with the provider, then the choices they unlock.
 */
export function AccountDialog({
  connection,
  providers,
  account,
  open,
  onOpenChange,
  onSaved,
}: {
  connection: ServerConnection;
  providers: PaymentProviderInfo[];
  /** The account to change; null to add one. */
  account: PaymentAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState(account?.provider ?? providers[0]?.id ?? "");
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const [label, setLabel] = useState(account?.label ?? "");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<SetupField[] | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start afresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setProviderId(account?.provider ?? providers[0]?.id ?? "");
    setLabel(account?.label ?? "");
    setCredentials({});
    setFields(null);
    setConfig(account?.config ?? {});
    setError(null);
    // An existing account's choices load straight away, with its saved credentials.
    if (account) void loadChoices(account.provider, {});
  }, [open, account?.id]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadChoices = (id: string, creds: Record<string, string>) =>
    run(async () => {
      const next = await connection.client.payments.setup({
        provider: id,
        accountId: account?.id,
        credentials: creds,
      });
      setFields(next);
      setConfig((old) => {
        const out: Record<string, string> = {};
        for (const f of next) {
          const value = old[f.key] ?? f.default;
          if (value) out[f.key] = value;
        }
        return out;
      });
      if (!label && provider) setLabel(provider.label);
    });

  const save = () =>
    run(async () => {
      if (account) {
        await connection.client.payments.updateAccount({
          id: account.id,
          label: label.trim() || account.label,
          ...(Object.values(credentials).some((v) => v.trim()) ? { credentials } : {}),
          config,
        });
      } else {
        await connection.client.payments.addAccount({
          provider: providerId,
          label: label.trim() || provider?.label || providerId,
          credentials,
          config,
        });
      }
      onSaved();
      onOpenChange(false);
    });

  const credentialsChanged = Object.values(credentials).some((v) => v.trim());

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={account ? `Change ${account.label}` : "Add a payment account"}
      className="w-[min(94vw,560px)]"
    >
      <div className="flex flex-col gap-2 p-4">
        {!account && providers.length > 1 ? (
          <FieldRow label="Provider">
            <Segmented
              className="self-start"
              value={providerId}
              onChange={(id) => {
                setProviderId(id);
                setFields(null);
                setCredentials({});
              }}
              options={providers.map((p) => ({ value: p.id, label: p.label }))}
            />
          </FieldRow>
        ) : null}
        {provider ? <p className="text-xs text-dim">{provider.description}</p> : null}

        {provider?.credentialFields.map((f) => (
          <SetupInput
            key={f.key}
            field={f}
            value={credentials[f.key] ?? (f.type === "select" && !account ? (f.default ?? "") : "")}
            placeholder={
              account && f.type === "secret" ? "Saved; type a new one to replace it" : undefined
            }
            keepSaved={Boolean(account)}
            onChange={(v) => {
              setCredentials((c) => ({ ...c, [f.key]: v }));
              // New credentials may unlock different choices: check them before saving.
              setFields(null);
            }}
          />
        ))}

        {fields === null ? (
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !provider}
              onClick={() => void loadChoices(providerId, credentials)}
            >
              {busy
                ? "Checking…"
                : account && credentialsChanged
                  ? "Check new credentials"
                  : "Connect"}
            </Button>
          </div>
        ) : null}

        {fields ? (
          <>
            <div className="mt-1 border-t border-line" />
            <FieldRow label="Name" hint="What you and your nibblets call this account.">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
            </FieldRow>
            {fields.map((f) => (
              <SetupInput
                key={f.key}
                field={f}
                value={config[f.key] ?? ""}
                onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
              />
            ))}
          </>
        ) : null}

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <div className="flex justify-end gap-1.5 pt-1">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || fields === null}
            onClick={() => void save()}
          >
            {account ? "Save" : "Add account"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SetupInput({
  field,
  value,
  onChange,
  placeholder,
  keepSaved,
}: {
  field: SetupField;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** For credentials on an account that has them: blank keeps what's saved. */
  keepSaved?: boolean;
}) {
  return (
    <FieldRow label={field.label} hint={field.help ?? undefined}>
      {field.type === "select" ? (
        <Select
          value={value}
          onChange={onChange}
          options={[
            ...(keepSaved
              ? [{ value: "", label: "Keep as saved" }]
              : value
                ? []
                : [{ value: "", label: "Choose…" }]),
            ...field.options,
          ]}
        />
      ) : (
        <Input
          type={field.type === "secret" ? "password" : "text"}
          autoComplete="off"
          value={value}
          placeholder={placeholder ?? (field.required ? undefined : "Optional")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FieldRow>
  );
}
