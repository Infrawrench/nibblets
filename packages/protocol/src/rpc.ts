import { z } from "zod";

/**
 * A tiny typed RPC layer. The contract is declared once as a tree of
 * procedures; the server implements it with `Handlers<typeof contract>` and
 * clients call it through `createClient`, so a renamed field or a changed
 * output is a type error on both sides rather than a runtime surprise.
 *
 * On the wire every call is `POST {base}/{dotted.path}` with the JSON input
 * as the body, answered with `{ ok: true, data }` or `{ ok: false, error }`.
 */

export interface Procedure<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly kind: "procedure";
  readonly input: I;
  readonly output: O;
}

export function procedure<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
): Procedure<I, O> {
  return { kind: "procedure", input, output };
}

export interface Router {
  readonly [key: string]: Procedure | Router;
}

export type Handlers<R extends Router, Ctx> = {
  [K in keyof R]: R[K] extends Procedure<infer I, infer O>
    ? (input: z.output<I>, ctx: Ctx) => Promise<z.input<O>>
    : R[K] extends Router
      ? Handlers<R[K], Ctx>
      : never;
};

export type Client<R extends Router> = {
  [K in keyof R]: R[K] extends Procedure<infer I, infer O>
    ? (input: z.input<I>) => Promise<z.output<O>>
    : R[K] extends Router
      ? Client<R[K]>
      : never;
};

export const RpcErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "not_found",
  "conflict",
  "unavailable",
  "internal",
]);
export type RpcErrorCode = z.infer<typeof RpcErrorCode>;

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const RpcResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.json() }),
  z.object({ ok: z.literal(false), error: z.object({ code: RpcErrorCode, message: z.string() }) }),
]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export function isProcedure(node: Procedure | Router): node is Procedure {
  return node.kind === "procedure";
}

/** Every procedure in the tree, by dotted path. */
export function flatten(router: Router, prefix = ""): Map<string, Procedure> {
  const out = new Map<string, Procedure>();
  for (const [key, node] of Object.entries(router)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isProcedure(node)) out.set(path, node);
    else for (const [p, proc] of flatten(node, path)) out.set(p, proc);
  }
  return out;
}

type AnyHandler<Ctx> = (input: unknown, ctx: Ctx) => Promise<unknown>;
interface HandlerTree<Ctx> {
  readonly [key: string]: AnyHandler<Ctx> | HandlerTree<Ctx>;
}

/**
 * Looks a handler up by dotted path and runs it with validated input and
 * output. This is the one place the typed handler tree is walked by string,
 * so the one place a widening is needed.
 */
export function createDispatcher<R extends Router, Ctx>(router: R, handlers: Handlers<R, Ctx>) {
  const procedures = flatten(router);
  const tree: HandlerTree<Ctx> = handlers as unknown as HandlerTree<Ctx>;

  return async (path: string, rawInput: unknown, ctx: Ctx): Promise<RpcResponse> => {
    const proc = procedures.get(path);
    let node: AnyHandler<Ctx> | HandlerTree<Ctx> | undefined = tree;
    for (const part of path.split(".")) {
      node = typeof node === "object" ? node[part] : undefined;
    }
    if (!proc || typeof node !== "function") {
      return { ok: false, error: { code: "not_found", message: `No procedure ${path}` } };
    }
    const input = proc.input.safeParse(rawInput ?? {});
    if (!input.success) {
      return { ok: false, error: { code: "bad_request", message: z.prettifyError(input.error) } };
    }
    try {
      const output = proc.output.parse(await node(input.data, ctx));
      return { ok: true, data: z.json().parse(output ?? null) };
    } catch (err) {
      if (err instanceof RpcError) {
        return { ok: false, error: { code: err.code, message: err.message } };
      }
      console.error(`rpc ${path} failed`, err);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: "internal", message } };
    }
  };
}

export type Transport = (path: string, input: unknown) => Promise<RpcResponse>;

/** Builds a typed client by walking the contract, validating each output. */
export function createClient<R extends Router>(router: R, transport: Transport): Client<R> {
  const build = (node: Router, prefix: string): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(node).map(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        if (!isProcedure(child)) return [key, build(child, path)];
        return [
          key,
          async (input: unknown) => {
            const res = await transport(path, input);
            if (!res.ok) throw new RpcError(res.error.code, res.error.message);
            return child.output.parse(res.data);
          },
        ];
      }),
    );
  // The object built above mirrors `Client<R>` key for key; TypeScript can't
  // follow a mapped type through Object.fromEntries, hence the one cast.
  return build(router, "") as Client<R>;
}

/**
 * A transport over fetch, for browsers and for server-to-server calls. Both
 * the base and the headers are asked for on every call, so a client can move
 * between routes to a server and refresh short-lived tokens.
 */
export function fetchTransport(
  base: string | (() => string),
  headers: () => Record<string, string> | Promise<Record<string, string>> = () => ({}),
) {
  return async (path: string, input: unknown): Promise<RpcResponse> => {
    const root = typeof base === "string" ? base : base();
    const res = await fetch(`${root}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await headers()) },
      body: JSON.stringify(input ?? {}),
    });
    const body: unknown = await res.json().catch(() => null);
    const parsed = RpcResponse.safeParse(body);
    if (parsed.success) return parsed.data;
    return {
      ok: false,
      error: { code: res.status === 401 ? "unauthorized" : "internal", message: res.statusText },
    };
  };
}
