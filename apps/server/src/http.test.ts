import { openApiDocument } from "@nibblets/protocol/openapi";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Routes, type Auth } from "./http.ts";

const anyone: Auth = { security: [] };

function setup() {
  const app = new Hono();
  const routes = new Routes(app);
  routes.post(
    "/things/:id",
    {
      summary: "Renames a thing.",
      tags: ["things"],
      auth: anyone,
      params: { id: "The thing's id." },
      query: z.object({ dry: z.enum(["yes", "no"]).default("no") }),
      body: z.object({ name: z.string().min(1) }),
      responses: { 200: { description: "Done.", body: z.object({ name: z.string() }) } },
    },
    (c, { query, body }) => c.json({ id: c.req.param("id"), dry: query.dry, name: body.name }),
  );
  return { app, routes };
}

describe("Routes", () => {
  it("hands the handler its parsed query and body", async () => {
    const { app } = setup();
    const res = await app.request("/things/t1?dry=yes", {
      method: "POST",
      body: JSON.stringify({ name: "Scamp" }),
    });
    expect(await res.json()).toEqual({ id: "t1", dry: "yes", name: "Scamp" });
  });

  it("turns away what doesn't match, before the handler", async () => {
    const { app } = setup();
    const badBody = await app.request("/things/t1", { method: "POST", body: "{}" });
    expect(badBody.status).toBe(400);
    const badQuery = await app.request("/things/t1?dry=maybe", {
      method: "POST",
      body: JSON.stringify({ name: "Scamp" }),
    });
    expect(badQuery.status).toBe(400);
  });

  it("runs the auth check first", async () => {
    const app = new Hono();
    const routes = new Routes(app);
    const locked: Auth = {
      check: async (c) => c.json({ error: "no" }, 401),
      security: [{ bearer: [] }],
      rejects: { description: "Locked." },
    };
    routes.get(
      "/secret",
      { summary: "A secret.", tags: [], auth: locked, responses: { 200: { description: "It." } } },
      (c) => c.text("it"),
    );
    expect((await app.request("/secret")).status).toBe(401);
    expect(routes.described[0]?.responses[401]?.description).toBe("Locked.");
  });

  it("describes what it mounts", () => {
    const { routes } = setup();
    const doc = openApiDocument({ version: "1.0.0", routes: routes.described });
    const op = doc.paths["/things/{id}"]?.post as Record<string, unknown>;
    expect(op).toMatchObject({
      summary: "Renames a thing.",
      security: [],
      parameters: [
        { name: "id", in: "path", required: true, description: "The thing's id." },
        { name: "dry", in: "query", required: false },
      ],
      requestBody: { content: { "application/json": { schema: { required: ["name"] } } } },
    });
    expect(Object.keys(op.responses as object)).toEqual(["200", "400"]);
  });
});
