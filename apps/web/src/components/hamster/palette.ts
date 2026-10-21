import type { ColourBackground, HamsterLook } from "@nibblets/protocol";

export interface FurColours {
  base: string;
  shade: string;
  /** A lighter tint, for a muzzle when the belly matches the fur. */
  light: string;
}

export const furColours: Record<HamsterLook["fur"], FurColours> = {
  golden: { base: "#E9A95E", shade: "#C2803A", light: "#F5CF9C" },
  cream: { base: "#F3DDB4", shade: "#CDAE7F", light: "#FAEEDA" },
  cinnamon: { base: "#CB7841", shade: "#9E5527", light: "#E6AB80" },
  grey: { base: "#AAA7A4", shade: "#7F7C79", light: "#D2D0CE" },
  chocolate: { base: "#7B4F34", shade: "#55341F", light: "#A8826A" },
  black: { base: "#3B3634", shade: "#1F1B1A", light: "#6E6866" },
  white: { base: "#FBF8F3", shade: "#CFC8BC", light: "#FFFFFF" },
  lilac: { base: "#BDB0C6", shade: "#93849F", light: "#DDD4E3" },
};

export const bellyColours: Record<Exclude<HamsterLook["belly"], "same">, string> = {
  white: "#FFFDF8",
  cream: "#F7E7CB",
};

export const eyeColours: Record<HamsterLook["eyeColour"], string> = {
  black: "#1E1A19",
  ruby: "#8E1B2E",
  brown: "#4B2C1A",
  blue: "#2C507E",
};

export const accessoryColours: Record<HamsterLook["accessoryColour"], string> = {
  red: "#E5484D",
  orange: "#F08C2E",
  yellow: "#F2C230",
  green: "#46A758",
  teal: "#12A594",
  blue: "#3E7BD6",
  purple: "#8E4EC6",
  pink: "#E85A9C",
};

export const backgroundColours: Record<ColourBackground, string | null> = {
  sky: "#CFE5F7",
  mint: "#CDEEDF",
  peach: "#FBDCC7",
  lavender: "#E2D9F5",
  lemon: "#F7EDBC",
  rose: "#F7D2DB",
  slate: "#D2D8E0",
  none: null,
};

export const PINK = "#F4AFB4";
export const PINK_DEEP = "#E58B95";
export const LINE = "#4A2F25";

/** The belly colour actually drawn, resolving "same" against the fur. */
export function bellyFill(look: HamsterLook): string {
  return look.belly === "same" ? furColours[look.fur].light : bellyColours[look.belly];
}

/** Dark furs get light patches and speckles; light furs get dark ones. */
export function markingFill(look: HamsterLook): string {
  const dark = look.fur === "black" || look.fur === "chocolate";
  return dark ? bellyFill(look) : furColours[look.fur].shade;
}

export interface Metal {
  base: string;
  edge: string;
  shine: string;
}

export const metalColours: Record<HamsterLook["piercingMetal"], Metal> = {
  silver: { base: "#D7DCE2", edge: "#6F7A88", shine: "#FFFFFF" },
  gold: { base: "#E8C15A", edge: "#A9832A", shine: "#FFF3C4" },
  rose: { base: "#E9A898", edge: "#B06A5B", shine: "#FFE4DC" },
  black: { base: "#34343A", edge: "#111114", shine: "#8A8A94" },
};
