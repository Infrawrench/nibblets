import { storage } from "./storage.ts";

/** Names for new nibblets: small, round, and mostly edible. */
export const hamsterNames = [
  "Pip",
  "Biscuit",
  "Mochi",
  "Toffee",
  "Peanut",
  "Nugget",
  "Hazel",
  "Crumpet",
  "Bean",
  "Pudding",
  "Waffle",
  "Pickle",
  "Dumpling",
  "Muffin",
  "Truffle",
  "Nibbles",
  "Bramble",
  "Clementine",
  "Custard",
  "Fudge",
  "Gingersnap",
  "Honeybun",
  "Jellybean",
  "Kiwi",
  "Latte",
  "Marzipan",
  "Nutmeg",
  "Oatcake",
  "Pancake",
  "Quince",
  "Rolo",
  "Scone",
  "Teacake",
  "Wotsit",
  "Butterscotch",
  "Caramel",
  "Cashew",
  "Chestnut",
  "Cinnamon",
  "Cocoa",
  "Cookie",
  "Crouton",
  "Cupcake",
  "Doughnut",
  "Eclair",
  "Fig",
  "Flapjack",
  "Gnocchi",
  "Hobnob",
  "Jaffa",
  "Kipper",
  "Lentil",
  "Macaron",
  "Maple",
  "Meringue",
  "Noodle",
  "Olive",
  "Parsnip",
  "Pebble",
  "Pistachio",
  "Popcorn",
  "Praline",
  "Pretzel",
  "Pumpkin",
  "Raisin",
  "Ravioli",
  "Sesame",
  "Shortbread",
  "Sprout",
  "Sultana",
  "Sushi",
  "Tapioca",
  "Tater",
  "Tofu",
  "Trifle",
  "Turnip",
  "Wafer",
  "Walnut",
  "Bonbon",
  "Bourbon",
  "Brioche",
  "Bubbles",
  "Button",
  "Clover",
  "Conker",
  "Cosmo",
  "Daisy",
  "Dot",
  "Fluffy",
  "Gizmo",
  "Hopscotch",
  "Juniper",
  "Marble",
  "Mitten",
  "Moss",
  "Pebbles",
  "Pom Pom",
  "Puffin",
  "Pumpernickel",
  "Rascal",
  "Rusk",
  "Saffron",
  "Snickerdoodle",
  "Sorrel",
  "Squeak",
  "Sunny",
  "Tinsel",
  "Twiglet",
  "Whisker",
  "Wiggles",
  "Ziggy",
  "Acorn",
] as const;

const ORDER_KEY = "nibblet.names.order";
const NEXT_KEY = "nibblet.names.next";

function shuffled(random: () => number): number[] {
  const order = hamsterNames.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = order[i];
    const b = order[j];
    if (a === undefined || b === undefined) continue;
    order[i] = b;
    order[j] = a;
  }
  return order;
}

function savedOrder(): number[] | null {
  try {
    const parsed: unknown = JSON.parse(storage.get(ORDER_KEY) ?? "null");
    if (
      Array.isArray(parsed) &&
      parsed.length === hamsterNames.length &&
      parsed.every((n) => typeof n === "number" && n >= 0 && n < hamsterNames.length)
    ) {
      return parsed;
    }
  } catch {
    // Fall through to a fresh order.
  }
  return null;
}

/**
 * The next name to suggest. Works through the list in a shuffled order kept
 * per browser, so suggestions don't repeat until every name has been offered,
 * and skips names a nibblet already has.
 */
export function nextHamsterName(
  taken: Iterable<string>,
  random: () => number = Math.random,
): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  let order = savedOrder();
  let next = Number(storage.get(NEXT_KEY) ?? "0");
  if (!order || !Number.isInteger(next) || next < 0) {
    order = shuffled(random);
    next = 0;
  }
  for (let tries = 0; tries < order.length; tries++) {
    if (next >= order.length) {
      order = shuffled(random);
      next = 0;
    }
    const name = hamsterNames[order[next] ?? 0] ?? "Pip";
    next++;
    if (!used.has(name.toLowerCase())) {
      storage.set(ORDER_KEY, JSON.stringify(order));
      storage.set(NEXT_KEY, String(next));
      return name;
    }
  }
  // Every name is taken: add a number to one.
  const base = hamsterNames[Math.floor(random() * hamsterNames.length)] ?? "Pip";
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}
