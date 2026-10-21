import { z } from "zod";

/** What the server's plain HTTP routes answer with when they fail. */
export const HttpError = z.object({ error: z.string() });
export type HttpError = z.infer<typeof HttpError>;

/** A body that isn't JSON: a file, sent or received as is. */
export type Binary = "binary";

/** One way of signing in, named as in the API description's security schemes. */
export type SecurityRequirement = { bearer: [] } | { ticket: [] } | Record<string, never>;

export interface HttpResponse {
  description: string;
  body?: z.ZodType | Binary;
}

/**
 * One of the server's plain HTTP routes, as the API description shows it.
 * The server mounts routes from these, so the description is of what's
 * actually served. `path` is in Hono's form, `/api/files/:id`.
 */
export interface HttpRoute {
  method: "get" | "post" | "put" | "delete";
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  /** Any one of these will do; empty for a route anyone may call. */
  security: SecurityRequirement[];
  /** Descriptions for the path's parameters, which are strings. */
  params?: Record<string, string>;
  query?: z.ZodObject;
  body?: z.ZodType | Binary;
  responses: Record<number, HttpResponse>;
  /** For a WebSocket: the JSON messages each way. */
  websocket?: { send?: z.ZodType; receive: z.ZodType };
}
