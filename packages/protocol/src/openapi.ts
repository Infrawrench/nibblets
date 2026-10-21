import { z } from "zod";
import * as protocol from "./index.ts";
import { contract } from "./contract.ts";
import type { Binary, HttpResponse, HttpRoute } from "./http.ts";
import { flatten, RpcErrorCode } from "./rpc.ts";

/**
 * An OpenAPI 3.1 description of the server's API: the contract's procedures
 * and the plain HTTP routes the server mounts. The server builds it when
 * asked, at `/api/openapi.json`, so it's always of what that server serves.
 */

type JsonSchema = { [key: string]: unknown };
type Io = "input" | "output";

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

function convert(schema: z.ZodType, io: Io) {
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
 * Collects the schemas a document uses, so they can share components. `use`
 * hands back an empty object that `finish` fills in once every schema is
 * known: a schema reads differently as input (defaults make fields optional)
 * than as output, and where it does, its input form is a component of its
 * own, `NameInput`.
 */
function schemaSet() {
  const uses: { target: JsonSchema; io: Io; root: JsonSchema; defs: Record<string, JsonSchema> }[] =
    [];
  return {
    use(schema: z.ZodType, io: Io): JsonSchema {
      const target: JsonSchema = {};
      uses.push({ target, io, ...convert(schema, io) });
      return target;
    },
    finish(): Record<string, unknown> {
      const defs: Record<Io, Record<string, JsonSchema>> = { input: {}, output: {} };
      for (const u of uses) Object.assign(defs[u.io], u.defs);

      // An input schema needs its own component if it reads differently, or
      // refers to one that does.
      const distinct = new Set(
        Object.keys(defs.input).filter(
          (name) =>
            name in defs.output &&
            JSON.stringify(defs.input[name]) !== JSON.stringify(defs.output[name]),
        ),
      );
      for (let grew = true; grew;) {
        grew = false;
        for (const [name, def] of Object.entries(defs.input)) {
          if (distinct.has(name) || !(name in defs.output)) continue;
          if ([...refsIn(def)].some((r) => distinct.has(r))) {
            distinct.add(name);
            grew = true;
          }
        }
      }
      const rename: Record<Io, (name: string) => string> = {
        input: (name) => (distinct.has(name) ? `${name}Input` : name),
        output: (name) => name,
      };

      for (const u of uses) Object.assign(u.target, rewriteRefs(u.root, rename[u.io]));
      const schemas: Record<string, unknown> = {};
      for (const io of ["output", "input"] as const) {
        for (const [name, def] of Object.entries(defs[io])) {
          schemas[rename[io](name)] ??= rewriteRefs(def, rename[io]);
        }
      }
      return schemas;
    },
  };
}

/** `nibblets.create` to `nibbletsCreate`, `get /api/files/{id}` to `getApiFilesId`. */
const operationId = (words: string) =>
  words
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join("");

const rpcError = (description: string) => ({
  description,
  content: { "application/json": { schema: ref("RpcError") } },
});

export interface OpenApiOptions {
  version: string;
  /** The plain HTTP routes, beside the contract's procedures. */
  routes?: HttpRoute[];
}

export function openApiDocument({ version, routes = [] }: OpenApiOptions) {
  const schemas = schemaSet();
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [path, proc] of flatten(contract)) {
    const [tag = path] = path.split(".");
    paths[`/api/rpc/${path}`] = {
      post: {
        operationId: operationId(path),
        tags: [tag],
        summary: path,
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: schemas.use(proc.input, "input") } },
        },
        responses: {
          "200": {
            description: "The procedure's result.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { const: true }, data: schemas.use(proc.output, "output") },
                  required: ["ok", "data"],
                },
              },
            },
          },
          "400": rpcError("The input didn't match the procedure's schema (`bad_request`)."),
          "401": rpcError("Not signed in (`unauthorized`)."),
          "404": rpcError("No such thing, or no such procedure (`not_found`)."),
          "500": rpcError("Any other failure (`conflict`, `unavailable` or `internal`)."),
        },
      },
    };
  }

  const content = (body: z.ZodType | Binary, io: Io) =>
    body === "binary"
      ? { "*/*": { schema: { type: "string", format: "binary" } } }
      : { "application/json": { schema: schemas.use(body, io) } };

  for (const route of routes) {
    const path = route.path.replace(/:(\w+)/g, "{$1}");
    const pathParams = [...route.path.matchAll(/:(\w+)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      ...(route.params?.[name!] ? { description: route.params[name!] } : {}),
      schema: { type: "string" },
    }));
    const queryParams = Object.entries(route.query?.shape ?? {}).map(([name, field]) => ({
      name,
      in: "query",
      required: !field.safeParse(undefined).success,
      ...(field.description ? { description: field.description } : {}),
      schema: schemas.use(field, "input"),
    }));
    const responses = Object.fromEntries(
      Object.entries(route.responses).map(([status, res]: [string, HttpResponse]) => {
        // A WebSocket's upgrade carries what it will send, as near as OpenAPI gets.
        const body = res.body ?? (status === "101" ? route.websocket?.receive : undefined);
        return [
          status,
          { description: res.description, ...(body ? { content: content(body, "output") } : {}) },
        ];
      }),
    );
    paths[path] ??= {};
    paths[path][route.method] = {
      operationId: operationId(`${route.method} ${path}`),
      tags: route.tags,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      security: route.security,
      ...(pathParams.length || queryParams.length
        ? { parameters: [...pathParams, ...queryParams] }
        : {}),
      ...(route.body
        ? { requestBody: { required: true, content: content(route.body, "input") } }
        : {}),
      responses,
      // OpenAPI has no word for WebSockets, so their messages go in an extension.
      ...(route.websocket
        ? {
            "x-websocket": {
              ...(route.websocket.send ? { send: schemas.use(route.websocket.send, "input") } : {}),
              receive: schemas.use(route.websocket.receive, "output"),
            },
          }
        : {}),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Nibblets server",
      version,
      description:
        "The API a Nibblets server serves to its web UI and to peer servers.\n\nEvery procedure is `POST /api/rpc/{procedure}` with its input as the JSON body, answered with `{ ok: true, data }` or `{ ok: false, error }`. Sign in with `Authorization: Bearer <token>`: the server's owner token, a paired device's token from `POST /api/pair`, or a token Nibblets Connect minted. WebSockets take a one-time `ticket` from `POST /api/ticket` instead, as browsers can't send headers on them.",
      license: { name: "GPL-2.0-only", identifier: "GPL-2.0-only" },
    },
    servers: [{ url: "/", description: "This server" }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        ticket: { type: "apiKey", in: "query", name: "ticket" },
      },
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
        ...schemas.finish(),
      },
    },
  };
}
