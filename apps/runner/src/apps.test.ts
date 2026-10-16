import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopApps,
  dataDirs,
  entryKeys,
  execArgv,
  iconFinder,
  readEntry,
  scanApps,
} from "./apps.ts";

const noIcon = async () => null;

describe("desktop entries", () => {
  it("reads the [Desktop Entry] group and nothing after it", () => {
    const keys = entryKeys(
      "# a comment\n[Desktop Entry]\nName=Mousepad\nName[fr]=Mousepad (fr)\nExec=mousepad %U\n\n[Desktop Action new-window]\nName=New Window\nExec=mousepad --new\n",
    );
    expect(keys.get("Name")).toBe("Mousepad");
    expect(keys.get("Exec")).toBe("mousepad %U");
    expect(keys.has("Name[fr]")).toBe(true);
  });

  it("turns Exec into argv, without field codes", () => {
    expect(execArgv("mousepad %U")).toEqual(["mousepad"]);
    expect(execArgv("foot --app-id=foot %f")).toEqual(["foot", "--app-id=foot"]);
    expect(execArgv('"/opt/My App/app" --name "a \\"b\\"" %%done')).toEqual([
      "/opt/My App/app",
      "--name",
      'a "b"',
      "%done",
    ]);
    expect(execArgv('env "" GDK_BACKEND=x11 app')).toEqual(["env", "", "GDK_BACKEND=x11", "app"]);
  });

  it("puts files where the Exec line takes them", () => {
    const files = ["/a.txt", "/b.txt"];
    expect(execArgv("app --open %f --readonly", files)).toEqual([
      "app",
      "--open",
      "/a.txt",
      "--readonly",
    ]);
    expect(execArgv("app %U --new-window", files)).toEqual([
      "app",
      "/a.txt",
      "/b.txt",
      "--new-window",
    ]);
    expect(execArgv("app --file=%f", files)).toEqual(["app", "--file=/a.txt"]);
    expect(execArgv("app --icon %i %c", files)).toEqual(["app", "--icon", "/a.txt", "/b.txt"]);
    // Nowhere to put them: at the end.
    expect(execArgv("app --x", files)).toEqual(["app", "--x", "/a.txt", "/b.txt"]);
  });

  it("makes an app of an entry it can open", async () => {
    const app = await readEntry(
      "org.xfce.mousepad",
      "[Desktop Entry]\nType=Application\nName=Mousepad\nComment=Simple Text Editor\nExec=mousepad %U\nIcon=org.xfce.mousepad\nCategories=Utility;TextEditor;\n",
      async (name) => `icon:${name}`,
    );
    expect(app).toEqual({
      id: "org.xfce.mousepad",
      name: "Mousepad",
      comment: "Simple Text Editor",
      icon: "icon:org.xfce.mousepad",
      command: "mousepad",
      args: [],
      categories: ["Utility", "TextEditor"],
      exec: "mousepad %U",
    });
  });

  it("leaves out what the launcher shouldn't offer", async () => {
    const entry = (extra: string) =>
      readEntry("x", `[Desktop Entry]\nType=Application\nName=X\nExec=x\n${extra}`, noIcon, {
        PATH: "/nowhere",
      });
    expect(await entry("NoDisplay=true")).toBeNull();
    expect(await entry("Hidden=true")).toBeNull();
    // Needs a terminal (python3's), or only one desktop shows it.
    expect(await entry("Terminal=true")).toBeNull();
    expect(await entry("OnlyShowIn=GNOME;")).toBeNull();
    // Not installed.
    expect(await entry("TryExec=x")).toBeNull();
    expect(await readEntry("l", "[Desktop Entry]\nType=Link\nName=L\nURL=x", noIcon)).toBeNull();
    // The browser has a panel of its own.
    expect(
      await readEntry(
        "chromium",
        "[Desktop Entry]\nType=Application\nName=Chromium\nExec=/usr/bin/chromium %U",
        noIcon,
      ),
    ).toBeNull();
  });
});

describe("scanning for apps", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function entry(dir: string, file: string, text: string) {
    await mkdir(path.dirname(path.join(dir, "applications", file)), { recursive: true });
    await writeFile(path.join(dir, "applications", file), text);
  }

  it("puts the user's folder first, and lets it hide the system's entries", () => {
    expect(dataDirs({ XDG_DATA_DIRS: "/usr/share:/usr/local/share" }, "/home/n")).toEqual([
      "/home/n/.local/share",
      "/usr/share",
      "/usr/local/share",
    ]);
    expect(dataDirs({}, "/home/n")).toEqual([
      "/home/n/.local/share",
      "/usr/local/share",
      "/usr/share",
    ]);
  });

  it("finds entries, their icons, and the user's own", async () => {
    root = await mkdtemp(path.join(tmpdir(), "nibblet-apps-"));
    const own = path.join(root, "home");
    const system = path.join(root, "usr");
    const app = (name: string, extra = "") =>
      `[Desktop Entry]\nType=Application\nName=${name}\nExec=${name.toLowerCase()}\n${extra}`;
    await entry(system, "foot.desktop", app("Foot", "Icon=foot\n"));
    await entry(system, "kde/editor.desktop", app("Editor", "Icon=/nowhere/editor.png\n"));
    await entry(system, "gone.desktop", app("Gone"));
    // The user's own app, and their entry hiding one of the system's.
    await entry(own, "game.desktop", app("Game", "Icon=game\n"));
    await entry(own, "gone.desktop", app("Gone", "Hidden=true\n"));
    const icons = path.join(system, "icons", "hicolor", "48x48", "apps");
    await mkdir(icons, { recursive: true });
    await writeFile(path.join(icons, "foot.svg"), "<svg/>");
    await mkdir(path.join(system, "pixmaps"), { recursive: true });
    await writeFile(path.join(system, "pixmaps", "game.png"), Buffer.alloc(2 * 1024 * 1024));

    const apps = await scanApps([own, system]);

    expect(apps.map((a) => [a.id, a.name])).toEqual([
      ["kde-editor", "Editor"],
      ["foot", "Foot"],
      ["game", "Game"],
    ]);
    expect(apps[1]?.icon).toBe(
      `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    );
    // Missing, and too big to send.
    expect(apps[0]?.icon).toBeNull();
    expect(apps[2]?.icon).toBeNull();
  });
});

describe("finding icons", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("keeps what it found, and looks again for what it didn't after a while", async () => {
    root = await mkdtemp(path.join(tmpdir(), "nibblet-icons-"));
    let now = 0;
    const find = iconFinder([root], path.join(root, "home"), () => now);
    expect(await find("game")).toBeNull();
    await mkdir(path.join(root, "pixmaps"), { recursive: true });
    await writeFile(path.join(root, "pixmaps", "game.svg"), "<svg/>");
    // Not found a moment ago, so not looked for yet.
    expect(await find("game")).toBeNull();
    now = 61_000;
    const found = await find("game");
    expect(found).toMatch(/^data:image\/svg\+xml;base64,/);
    await rm(path.join(root, "pixmaps", "game.svg"));
    now = 1_000_000;
    expect(await find("game")).toBe(found);
  });
});

describe("DesktopApps", () => {
  const foot = {
    id: "foot",
    name: "Foot",
    comment: null,
    icon: null,
    command: "foot",
    args: ["--title=x"],
    categories: [],
    exec: "foot --title=x %f",
  };
  const { exec: _, ...shownFoot } = foot;

  it("says when the list changes, and only then", async () => {
    let list = [foot];
    const seen: unknown[] = [];
    const apps = new DesktopApps({
      viewUrl: "http://127.0.0.1:1",
      token: "t",
      scan: async () => list,
      onChange: (l) => seen.push(l),
    });
    await apps.scan();
    await apps.scan();
    list = [];
    await apps.scan();
    expect(seen).toEqual([[shownFoot], []]);
  });

  it("keeps the newest scan's list when an older one finishes after it", async () => {
    const finish: ((list: (typeof foot)[]) => void)[] = [];
    const seen: unknown[] = [];
    const apps = new DesktopApps({
      viewUrl: "http://127.0.0.1:1",
      token: "t",
      scan: () => new Promise((done) => finish.push(done)),
      onChange: (l) => seen.push(l),
    });
    const older = apps.scan();
    const newer = apps.scan();
    finish[1]!([foot]);
    await newer;
    finish[0]!([]);
    await older;
    expect(apps.list()).toEqual([shownFoot]);
    expect(seen).toEqual([[shownFoot]]);
  });

  it("opens an app on the desktop's view server, files where it takes them, from the last scan", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ session_id: "s1-abc", windows: [{ id: 3, title: "foot" }] }),
        { status: 201 },
      );
    }) as typeof fetch;
    try {
      let scans = 0;
      const apps = new DesktopApps({
        viewUrl: "http://127.0.0.1:7901",
        token: "t",
        scan: async () => (scans++, [foot]),
      });
      await apps.scan();
      const opened = await apps.launch("foot", ["notes.txt"]);
      expect(opened.session_id).toBe("s1-abc");
      expect(opened.app).toEqual(shownFoot);
      // The last scan had it: no need to look again.
      expect(scans).toBe(1);
      expect(calls[0]?.url).toBe("http://127.0.0.1:7901/sessions");
      expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer t");
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
        app: "foot",
        args: ["--title=x", "notes.txt"],
        display: "wayland",
      });
      await expect(apps.launch("nope")).rejects.toThrow("No app nope");
      expect(scans).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});
