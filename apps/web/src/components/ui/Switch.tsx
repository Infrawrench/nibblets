import { Switch as BaseSwitch } from "@base-ui/react/switch";

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(c) => onChange(c)}
      aria-label={label}
      disabled={disabled}
      className="relative data-[disabled]:opacity-40 inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-edge bg-deep transition-colors data-[checked]:border-transparent data-[checked]:bg-accent"
    >
      <BaseSwitch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[checked]:translate-x-3.5" />
    </BaseSwitch.Root>
  );
}
