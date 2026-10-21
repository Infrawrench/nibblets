import { useState, type KeyboardEvent } from "react";
import { FieldRow, Input, Select } from "./ui/Field.tsx";

type Mode = "own" | "other" | "none";

const modes: readonly { value: Mode; label: string }[] = [
  { value: "own", label: "Its name" },
  { value: "other", label: "Another name" },
  { value: "none", label: "No name" },
];

const hints: Record<Mode, string> = {
  own: "What it's told it's called.",
  other: "It's told it's called this instead, so its name never reaches the model.",
  none: "It isn't told a name at all, so its name never reaches the model.",
};

/**
 * What a nibblet is called in its own prompts: null for its name, empty for
 * none, or another name. Its mode is its own, so remount it (with a `key`)
 * to start over from `value`.
 */
export function PromptNameField({
  value,
  onChange,
  onKeyDown,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [mode, setMode] = useState<Mode>(value === null ? "own" : value ? "other" : "none");
  // Kept while switching modes, so switching back doesn't lose it.
  const [other, setOther] = useState(value ?? "");

  return (
    <FieldRow label="Name it knows" hint={hints[mode]}>
      <div className="flex items-center gap-1">
        <Select
          className="w-auto shrink-0"
          options={modes}
          value={mode}
          onChange={(m) => {
            const next = m as Mode;
            setMode(next);
            // Another name not typed yet is no name, never its own.
            onChange(next === "own" ? null : next === "none" ? "" : other);
          }}
        />
        {mode === "other" ? (
          <Input
            value={other}
            onChange={(e) => {
              setOther(e.target.value);
              onChange(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder="What it's called"
            maxLength={80}
          />
        ) : null}
      </div>
    </FieldRow>
  );
}
