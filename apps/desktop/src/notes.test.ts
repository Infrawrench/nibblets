import { describe, expect, it } from "vitest";
import { formatNotes } from "./notes.ts";

const RELEASE = `## What's new

- Pull a release's published images instead of building them
- Name the Linux x64 downloads x64, like the others

## Install

- **Mac:** Nibblets-arm64.dmg (Apple Silicon) or Nibblets-x64.dmg (Intel)
- **Linux server or VM:** \`curl -fsSL https://nibblets.dev/install.sh | bash\`

Or get it from https://nibblets.dev`;

describe("formatNotes", () => {
  it("shows what's new as plain text, without the install instructions", () => {
    expect(formatNotes(RELEASE)).toBe(
      [
        "What's new",
        "• Pull a release's published images instead of building them",
        "• Name the Linux x64 downloads x64, like the others",
      ].join("\n"),
    );
  });

  it("drops emphasis, code and link marks", () => {
    expect(formatNotes("- **Bold**, _soft_, `code` and [a link](https://x.dev)")).toBe(
      "• Bold, soft, code and a link",
    );
    // Underscores inside words are left alone.
    expect(formatNotes("- snake_case_name")).toBe("• snake_case_name");
  });

  it("keeps long notes short", () => {
    const many = Array.from({ length: 14 }, (_, i) => `- Change ${i + 1}`).join("\n");
    const text = formatNotes(many, 10);
    expect(text.split("\n")).toHaveLength(11);
    expect(text.endsWith("• and 4 more")).toBe(true);
  });
});
