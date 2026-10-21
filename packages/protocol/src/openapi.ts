import { z } from "zod";
import * as protocol from "./index.ts";
import { contract } from "./contract.ts";
import { flatten, RpcErrorCode } from "./rpc.ts";

/**
 * An OpenAPI 3.1 description of the server's HTTP API, built from the
 * contract so it can't drift from it. `pnpm openapi` writes it to
 * `apps/server/openapi.json`, and the server serves it at `/api/openapi.json`.
 */

type JsonSchema = { [key: string]: unknown };

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** Every exported schema with a type-like name, so shared shapes become components. */
const registry = z.registry<{ id: string }>();
for (const [name, value] of Object.entries(protocol)) {
  if (/^[A-Z][a-z]/.test(name) && value instanceof z.ZodType && !registry.has(value)) {
    registry.add(value, { id: name });
  }
}

/** Rewrites Zod's `#/$defs/X` references, renaming each target with `rename`. */
function rewriteRefs(node: unknown, rename: (name: string) => string): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, rename));
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) =>
      key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")
        ? [key, ref(rename(value.slice("#/$defs/".length))).$ref]
        : [key, rewriteRefs(value, rename)],
    ),
  );
}

function convert(schema: z.ZodType, io: "input" | "output") {
  const {
    $schema: _,
    $defs = {},
    ...root
  } = z.toJSONSchema(schema, {
    metadata: registry,
    io,
    target: "draft-2020-12",
  }) as JsonSchema & { $defs?: Record<string, JsonSchema> };
  return { root, defs: $defs };
}

/** The names of the schemas `node` references directly. */
function refsIn(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const n of node) refsIn(n, into);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
        into.add(value.slice("#/$defs/".length));
      } else refsIn(value, into);
    }
  }
  return into;
}

/**
 * Converts every procedure, sharing components between them. A schema reads
 * differently as input (defaults make fields optional) than as output; where
 * it does, its input form is a component of its own, `NameInput`.
 */
function convertContract() {
  const procedures = [...flatten(contract)].map(([path, proc]) => ({
    path,
    input: convert(proc.input, "input"),
    output: convert(proc.output, "output"),
  }));
  const outputDefs: Record<string, JsonSchema> = {};
  const inputDefs: Record<string, JsonSchema> = {};
  for (const p of procedures) {
    Object.assign(outputDefs, p.output.defs);
    Object.assign(inputDefs, p.input.defs);
  }

  // An input schema needs its own component if it reads differently, or
  // refers to one that does.
  const distinct = new Set(
    Object.keys(inputDefs).filter(
      (name) =>
        name in outputDefs && JSON.stringify(inputDefs[name]) !== JSON.stringify(outputDefs[name]),
    ),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, def] of Object.entries(inputDefs)) {
      if (distinct.has(name) || !(name in outputDefs)) continue;
      if ([...refsIn(def)].some((r) => distinct.has(r))) {
        distinct.add(name);
        grew = true;
      }
    }
  }
  const asInput = (name: string) => (distinct.has(name) ? `${name}Input` : name);
  const asOutput = (name: string) => name;

  const schemas: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(outputDefs)) schemas[name] = rewriteRefs(def, asOutput);
  for (const [name, def] of Object.entries(inputDefs)) {
    if (asInput(name) in schemas) continue;
    schemas[asInput(name)] = rewriteRefs(def, asInput);
  }
  return {
    schemas,
    procedures: procedures.map((p) => ({
      path: p.path,
      input: rewriteRefs(p.input.root, asInput),
      output: rewriteRefs(p.output.root, asOutput),
    })),
  };
}

const operationId = (path: string) =>
  path.replace(/\.([a-zA-Z])/g, (_, c: string) => c.toUpperCase());

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ref("RpcError") } },
});

const plainError = (description: string) => ({
  description,
  content: { "application/json": { schema: ref("PlainError") } },
});

const idParam = (description: string) => ({
  name: "id",
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});

/** The WebSockets' messages, which no procedure mentions. */
function messageSchemas() {
  const out: Record<string, unknown> = {};
  for (const [name, schema, io] of [
    ["LiveMessage", protocol.LiveMessage, "output"],
    ["TerminalInput", protocol.TerminalInput, "input"],
    ["TerminalEvent", protocol.TerminalEvent, "output"],
  ] as const) {
    const { root, defs } = convert(schema, io);
    for (const [def, value] of Object.entries(defs)) out[def] = rewriteRefs(value, (n) => n);
    if (!(name in out)) out[name] = rewriteRefs(root, (n) => n);
  }
  return out;
}

export function openApiDocument(version: string) {
  const { schemas, procedures } = convertContract();

  const paths: Record<string, unknown> = {};
  for (const p of procedures) {
    const [tag = p.path] = p.path.split(".");
    paths[`/api/rpc/${p.path}`] = {
      post: {
        operationId: operationId(p.path),
        tags: [tag],
        summary: p.path,
        requestBody: {
          required: true,
          content: { "application/json": { schema: p.input } },
        },
        responses: {
          "200": {
            description: "The procedure's result.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { const: true }, data: p.output },
                  required: ["ok", "data"],
                },
              },
            },
          },
          "400": errorResponse("The input didn't match the procedure's schema (`bad_request`)."),
          "401": errorResponse("Not signed in (`unauthorized`)."),
          "404": errorResponse("No such thing, or no such procedure (`not_found`)."),
          "500": errorResponse("Any other failure (`conflict`, `unavailable` or `internal`)."),
        },
      },
    };
  }

  Object.assign(paths, {
    "/healthz": {
      get: {
        operationId: "healthz",
        tags: ["http"],
        security: [],
        summary: "Whether the server is up.",
        responses: {
          "200": {
            description: "It is.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { const: true } },
                  required: ["ok"],
                },
              },
            },
          },
        },
      },
    },
    "/api/openapi.json": {
      get: {
        operationId: "openapi",
        tags: ["http"],
        security: [],
        summary: "This document.",
        responses: {
          "200": {
            description: "The OpenAPI document.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/api/pair": {
      post: {
        operationId: "pair",
        tags: ["http"],
        security: [],
        summary: "Redeems a pairing link's code for a token to send as `Authorization: Bearer`.",
        description:
          "`createPairingLink` (or `node apps/server/src/cli.ts pair`) makes the link; its `code` query parameter goes here. Each code works once.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  label: {
                    type: "string",
                    maxLength: 100,
                    description: "What to call this device. Defaults to `Browser`.",
                  },
                },
                required: ["code"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "A token for this device.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { token: { type: "string" } },
                  required: ["token"],
                },
              },
            },
          },
          "401": plainError("The code has expired or was already used."),
        },
      },
    },
    "/api/ticket": {
      post: {
        operationId: "ticket",
        tags: ["http"],
        summary: "A one-time ticket for opening a WebSocket, good for 30 seconds.",
        description:
          "Browsers can't send headers on a WebSocket, so the WebSocket endpoints take `?ticket=` instead.",
        responses: {
          "200": {
            description: "The ticket.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ticket: { type: "string" } },
                  required: ["ticket"],
                },
              },
            },
          },
          "401": errorResponse("Not signed in."),
        },
      },
    },
    "/api/nibblets/{id}/files": {
      post: {
        operationId: "uploadFile",
        tags: ["files"],
        summary: "Uploads a file to attach to a message.",
        description:
          "The request body is the file itself. Pass the returned `fileId` in `nibblets.send`'s `attachments`.",
        parameters: [
          idParam("The nibblet's id."),
          {
            name: "name",
            in: "query",
            description: "The file's name. Defaults to `file`.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: { "*/*": { schema: { type: "string", format: "binary" } } },
        },
        responses: {
          "200": {
            description: "The stored file.",
            content: { "application/json": { schema: ref("FileRef") } },
          },
          "400": plainError("No body."),
          "401": errorResponse("Not signed in."),
          "404": plainError("No such nibblet."),
          "413": plainError("Too large, or the upload failed."),
        },
      },
    },
    "/api/files/{id}/link": {
      post: {
        operationId: "fileLink",
        tags: ["files"],
        summary: "A signed link to download a file without signing in, good for an hour.",
        parameters: [idParam("The file's id.")],
        responses: {
          "200": {
            description: "The link, relative to the server.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { url: { type: "string" } },
                  required: ["url"],
                },
              },
            },
          },
          "401": errorResponse("Not signed in."),
          "404": plainError("No such file."),
        },
      },
    },
    "/api/files/{id}": {
      get: {
        operationId: "downloadFile",
        tags: ["files"],
        summary: "Downloads a file, whole or a `Range` of it.",
        description:
          "Takes either a bearer token or the `exp` and `sig` of a link from `POST /api/files/{id}/link`.",
        security: [{ bearer: [] }, {}],
        parameters: [
          idParam("The file's id."),
          { name: "exp", in: "query", schema: { type: "string" } },
          { name: "sig", in: "query", schema: { type: "string" } },
          { name: "range", in: "header", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "The file.",
            content: { "*/*": { schema: { type: "string", format: "binary" } } },
          },
          "206": {
            description: "The requested range.",
            content: { "*/*": { schema: { type: "string", format: "binary" } } },
          },
          "401": plainError("Neither signed in nor a valid link."),
          "404": plainError("No such file."),
          "416": { description: "The range is outside the file." },
        },
      },
    },
    "/api/live": {
      get: {
        operationId: "live",
        tags: ["websockets"],
        security: [],
        summary: "A WebSocket of live updates.",
        description:
          "Each text frame is a JSON `LiveMessage`, apart from a bare `ping` every 25 seconds to keep the connection open.",
        parameters: [{ name: "ticket", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "101": {
            description: "Switching to the WebSocket protocol.",
            content: { "application/json": { schema: ref("LiveMessage") } },
          },
          "401": { description: "No ticket, or it has expired." },
        },
      },
    },
    "/api/nibblets/{id}/terminal": {
      get: {
        operationId: "terminal",
        tags: ["websockets"],
        security: [],
        summary: "A WebSocket terminal in the nibblet's container.",
        description:
          "Send `TerminalInput` messages and receive `TerminalEvent` ones, as JSON text frames. The socket closes after `exit` or `error`.",
        parameters: [
          idParam("The nibblet's id."),
          { name: "ticket", in: "query", required: true, schema: { type: "string" } },
          { name: "cols", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000 } },
          { name: "rows", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000 } },
          {
            name: "task",
            in: "query",
            description: "A background task's id, to attach to it instead of a new shell.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "101": {
            description: "Switching to the WebSocket protocol.",
            content: { "application/json": { schema: ref("TerminalEvent") } },
          },
          "401": { description: "No ticket, or it has expired." },
        },
      },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Nibblets server",
      version,
      description:
        "The API a Nibblets server serves to its web UI and to peer servers.\n\nEvery procedure is `POST /api/rpc/{procedure}` with its input as the JSON body, answered with `{ ok: true, data }` or `{ ok: false, error }`. Sign in with `Authorization: Bearer <token>`: the server's owner token, a paired device's token from `POST /api/pair`, or a token Nibblets Connect minted.",
      license: { name: "GPL-2.0-only", identifier: "GPL-2.0-only" },
    },
    servers: [{ url: "http://localhost:8420", description: "A server on this computer" }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        RpcError: {
          type: "object",
          properties: {
            ok: { const: false },
            error: {
              type: "object",
              properties: {
                code: { type: "string", enum: RpcErrorCode.options },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["ok", "error"],
        },
        PlainError: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
        ...messageSchemas(),
        ...schemas,
      },
    },
  };
}
