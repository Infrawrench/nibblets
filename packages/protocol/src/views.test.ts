import { describe, expect, it } from "vitest";
import { APP_VIEW_MIME, readAppView, toolView } from "./views.ts";

describe("toolView", () => {
  it("reads a tool's view from either form of its _meta", () => {
    expect(toolView({ ui: { resourceUri: "ui://a/view" } })).toEqual({
      uri: "ui://a/view",
      visibility: ["model", "app"],
    });
    expect(toolView({ "ui/resourceUri": "ui://a/old" }).uri).toBe("ui://a/old");
    expect(
      toolView({ ui: { resourceUri: "ui://a/new" }, "ui/resourceUri": "ui://a/old" }).uri,
    ).toBe("ui://a/new");
  });

  it("says who may see the tool", () => {
    expect(toolView({ ui: { visibility: ["app"] } })).toEqual({ uri: null, visibility: ["app"] });
    expect(toolView({ ui: { visibility: [] } }).visibility).toEqual(["model", "app"]);
  });

  it("has no view for a tool without one, or one that isn't ui://", () => {
    expect(toolView(undefined)).toEqual({ uri: null, visibility: ["model", "app"] });
    expect(toolView({ ui: { resourceUri: "https://evil.test/" } }).uri).toBeNull();
    expect(toolView({ ui: "nonsense" }).uri).toBeNull();
  });
});

describe("readAppView", () => {
  it("takes the first MCP App's HTML, with its settings", () => {
    expect(
      readAppView([
        { uri: "ui://a/x", mimeType: "text/html", text: "<p>not an app</p>" },
        {
          uri: "ui://a/view",
          mimeType: APP_VIEW_MIME,
          text: "<p>app</p>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.test"] },
              permissions: { clipboardWrite: {} },
              prefersBorder: true,
            },
          },
        },
      ]),
    ).toEqual({
      html: "<p>app</p>",
      csp: { connectDomains: ["https://api.test"] },
      permissions: { clipboardWrite: {} },
      prefersBorder: true,
    });
  });

  it("decodes a view sent as a blob", () => {
    const blob = btoa(String.fromCharCode(...new TextEncoder().encode("<p>café</p>")));
    expect(readAppView([{ mimeType: APP_VIEW_MIME, blob }])?.html).toBe("<p>café</p>");
  });

  it("ignores settings it can't read, and finds nothing where there's no app", () => {
    expect(
      readAppView([{ mimeType: APP_VIEW_MIME, text: "<p/>", _meta: { ui: { csp: "all" } } }]),
    ).toEqual({ html: "<p/>", csp: {}, permissions: {}, prefersBorder: null });
    expect(readAppView([{ mimeType: "text/plain", text: "hi" }])).toBeNull();
    expect(readAppView([])).toBeNull();
  });
});
