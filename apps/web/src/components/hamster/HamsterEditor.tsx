import { useState, type ReactNode } from "react";
import { Crown, Dices, Ear, Heart, Image, Palette, Shapes, Smile } from "lucide-react";
import { HamsterLook, randomHamsterLook } from "@nibblet/protocol";
import { Hamster } from "./Hamster.tsx";
import {
  accessoryColours,
  backgroundColours,
  bellyColours,
  eyeColours,
  furColours,
} from "./palette.ts";
import { Button } from "../ui/Button.tsx";
import { Input } from "../ui/Field.tsx";
import { Switch } from "../ui/Switch.tsx";
import { cn } from "../../lib/cn.ts";

type EnumField = {
  [K in keyof HamsterLook]: HamsterLook[K] extends string ? K : never;
}[keyof HamsterLook];

const s = HamsterLook.shape;
const options: { [K in EnumField]: readonly HamsterLook[K][] } = {
  fur: s.fur.options,
  pattern: s.pattern.options,
  belly: s.belly.options,
  ears: s.ears.options,
  eyes: s.eyes.options,
  eyeColour: s.eyeColour.options,
  mouth: s.mouth.options,
  cheeks: s.cheeks.options,
  accessory: s.accessory.options,
  accessoryColour: s.accessoryColour.options,
  background: s.background.options,
};

/** Swatch colours for the fields chosen by colour rather than by picture. */
const swatches: { [K in EnumField]?: (value: HamsterLook[K], look: HamsterLook) => string | null } =
  {
    fur: (v) => furColours[v].base,
    belly: (v, look) => (v === "same" ? furColours[look.fur].light : bellyColours[v]),
    eyeColour: (v) => eyeColours[v],
    accessoryColour: (v) => accessoryColours[v],
    background: (v) => backgroundColours[v],
  };

export function withField<K extends keyof HamsterLook>(
  look: HamsterLook,
  field: K,
  value: HamsterLook[K],
): HamsterLook {
  const next = { ...look };
  next[field] = value;
  return next;
}

export function optionLabel(value: string): string {
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Category = "fur" | "pattern" | "face" | "ears" | "cheeks" | "accessories" | "background";

const categories: { id: Category; label: string; icon: ReactNode }[] = [
  { id: "fur", label: "Fur", icon: <Palette /> },
  { id: "pattern", label: "Pattern", icon: <Shapes /> },
  { id: "face", label: "Face", icon: <Smile /> },
  { id: "ears", label: "Ears", icon: <Ear /> },
  { id: "cheeks", label: "Cheeks", icon: <Heart /> },
  { id: "accessories", label: "Accessories", icon: <Crown /> },
  { id: "background", label: "Background", icon: <Image /> },
];

/**
 * A Mii-editor-style hamster maker: a big live preview, a category bar, and
 * for each category a grid of tiles, each one the current hamster with just
 * that one choice changed.
 */
export function HamsterEditor({
  look,
  onChange,
  name,
  onNameChange,
}: {
  look: HamsterLook;
  onChange: (look: HamsterLook) => void;
  name?: string;
  onNameChange?: (name: string) => void;
}) {
  const [category, setCategory] = useState<Category>("fur");

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div className="flex shrink-0 flex-col items-center gap-3 sm:w-48">
        <div className="rounded-full bg-deep p-2 shadow-inner">
          <Hamster look={look} size={160} status="idle" title={name || "Your hamster"} />
        </div>
        {onNameChange ? (
          <Input
            value={name ?? ""}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Name your nibblet"
            className="text-center font-medium"
            maxLength={80}
          />
        ) : null}
        <Button onClick={() => onChange(randomHamsterLook())} className="w-full justify-center">
          <Dices />
          Randomise
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap gap-1" role="tablist">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={category === c.id}
              onClick={() => setCategory(c.id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
                category === c.id
                  ? "border-transparent bg-accent text-accent-text"
                  : "border-edge bg-surface text-dim hover:text-text",
              )}
            >
              {c.icon}
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex min-h-72 flex-col gap-4">
          <CategoryBody category={category} look={look} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

function CategoryBody({
  category,
  look,
  onChange,
}: {
  category: Category;
  look: HamsterLook;
  onChange: (look: HamsterLook) => void;
}) {
  const grid = <K extends EnumField>(field: K, label: string) => (
    <OptionGroup key={field} field={field} label={label} look={look} onChange={onChange} />
  );
  switch (category) {
    case "fur":
      return (
        <>
          {grid("fur", "Colour")}
          {grid("belly", "Belly")}
        </>
      );
    case "pattern":
      return grid("pattern", "Markings");
    case "face":
      return (
        <>
          {grid("eyes", "Eyes")}
          {grid("eyeColour", "Eye colour")}
          {grid("mouth", "Mouth")}
        </>
      );
    case "ears":
      return grid("ears", "Ears");
    case "cheeks":
      return (
        <>
          {grid("cheeks", "Cheeks")}
          <label className="flex items-center gap-2 text-sm text-dim">
            <Switch
              checked={look.whiskers}
              onChange={(whiskers) => onChange({ ...look, whiskers })}
              label="Whiskers"
            />
            Whiskers
          </label>
        </>
      );
    case "accessories":
      return (
        <>
          {grid("accessory", "Accessory")}
          {look.accessory !== "none" ? grid("accessoryColour", "Colour") : null}
        </>
      );
    case "background":
      return grid("background", "Background");
  }
}

function OptionGroup<K extends EnumField>({
  field,
  label,
  look,
  onChange,
}: {
  field: K;
  label: string;
  look: HamsterLook;
  onChange: (look: HamsterLook) => void;
}) {
  const swatch = swatches[field];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-2xs font-semibold tracking-wider text-faint uppercase">{label}</div>
      <div
        className={cn(
          "grid gap-1.5",
          swatch
            ? "grid-cols-[repeat(auto-fill,minmax(36px,1fr))]"
            : "grid-cols-[repeat(auto-fill,minmax(68px,1fr))]",
        )}
      >
        {options[field].map((value) => {
          const selected = look[field] === value;
          const preview = previewFor(withField(look, field, value), field);
          const colour = swatch?.(value, look);
          return swatch ? (
            <button
              key={value}
              type="button"
              title={optionLabel(value)}
              aria-label={optionLabel(value)}
              aria-pressed={selected}
              onClick={() => onChange(withField(look, field, value))}
              className={cn(
                "flex size-9 items-center justify-center rounded-full border-2 transition-transform hover:scale-105",
                selected ? "border-accent" : "border-transparent",
              )}
            >
              <span
                className="size-7 rounded-full border border-black/10"
                style={
                  colour
                    ? { background: colour }
                    : {
                        background:
                          "repeating-linear-gradient(45deg, var(--deep) 0 4px, var(--line) 4px 8px)",
                      }
                }
              />
            </button>
          ) : (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(withField(look, field, value))}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-lg border p-1 transition-colors hover:bg-hover",
                selected ? "border-accent bg-accent-soft/50" : "border-line bg-surface",
              )}
            >
              <Hamster look={preview} size={56} decorative />
              <span className="text-2xs text-dim">{optionLabel(value)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Tiles show the feature clearly: a beanie would hide the ears being chosen. */
function previewFor(look: HamsterLook, field: EnumField): HamsterLook {
  if (field === "ears" && look.accessory === "beanie") return { ...look, accessory: "none" };
  return look;
}
