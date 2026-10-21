import {
  HttpError,
  type HttpResponse,
  type HttpRoute,
  type SecurityRequirement,
} from "@nibblet/protocol";
import type { Context, Hono, MiddlewareHandler, Next } from "hono";
import { z } from "zod";

/** Who may call a route: a check to run first, and how the API description says so. */
export interface Auth {
  check?: MiddlewareHandler;
  security: SecurityRequirement[];
  /** What `check` answers when it turns someone away, with a 401. */
  rejects?: HttpResponse;
}

type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

/** A route as it's declared: its description, with who may call it. */
export type RouteSpec<Q extends z.ZodObject | undefined, B> = Omit<
  HttpRoute,
  "method" | "path" | "security" | "query" | "body"
> & {
  auth: Auth;
  /** Checked before the handler runs; it gets what it parses to. */
  query?: Q;
  /** A JSON body, checked like the query, or a file the handler reads itself. */
  body?: B;
};

export type RouteHandler<Q, B> = (
  c: Context,
  input: { query: Parsed<Q>; body: Parsed<B> },
  next: Next,
) => Response | void | Promise<Response | void>;

/**
 * Mounts the server's plain HTTP routes on Hono and keeps their
 * descriptions, so each is declared once and `/api/openapi.json` shows
 * exactly what's served.
 */
export class Routes {
  readonly described: HttpRoute[] = [];
  private readonly app: Hono;

  constructor(app: Hono) {
    this.app = app;
  }

  get<Q extends z.ZodObject | undefined = undefined, B = undefined>(
    path: string,
    spec: RouteSpec<Q, B>,
    handler: RouteHandler<Q, B>,
  ): void {
    this.add("get", path, spec, handler);
  }

  post<Q extends z.ZodObject | undefined = undefined, B = undefined>(
    path: string,
    spec: RouteSpec<Q, B>,
    handler: RouteHandler<Q, B>,
  ): void {
    this.add("post", path, spec, handler);
  }

  private add<Q extends z.ZodObject | undefined, B>(
    method: HttpRoute["method"],
    path: string,
    { auth, query, body, ...spec }: RouteSpec<Q, B>,
    handler: RouteHandler<Q, B>,
  ): void {
    const json = body instanceof z.ZodType ? body : undefined;
    const responses: Record<number, HttpResponse> = {};
    if (query || json) {
      responses[400] = {
        description: "The request didn't match this description.",
        body: HttpError,
      };
    }
    if (auth.rejects) responses[401] = auth.rejects;
    this.described.push({
      ...spec,
      method,
      path,
      security: auth.security,
      ...(query ? { query } : {}),
      ...(body === "binary" || json ? { body: json ?? "binary" } : {}),
      responses: { ...responses, ...spec.responses },
    });

    const run: MiddlewareHandler = async (c, next) => {
      const q = query?.safeParse(c.req.query());
      if (q && !q.success) return c.json({ error: z.prettifyError(q.error) }, 400);
      const b = json?.safeParse(await c.req.json().catch(() => null));
      if (b && !b.success) return c.json({ error: z.prettifyError(b.error) }, 400);
      // The parsed values have the types the handler was declared with; the
      // check above is what makes them so.
      const input = { query: q?.data, body: b?.data } as { query: Parsed<Q>; body: Parsed<B> };
      return handler(c, input, next);
    };
    this.app.on(method.toUpperCase(), [path], ...(auth.check ? [auth.check, run] : [run]));
  }
}
