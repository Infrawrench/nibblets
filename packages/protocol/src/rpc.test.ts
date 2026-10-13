import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createClient, createDispatcher, procedure, RpcError } from "./rpc.ts";

const router = {
  maths: {
    add: procedure(z.object({ a: z.number(), b: z.number() }), z.object({ sum: z.number() })),
    fail: procedure(z.object({}), z.object({})),
  },
};

const dispatch = createDispatcher(router, {
  maths: {
    add: async ({ a, b }) => ({ sum: a + b }),
    fail: async () => {
      throw new RpcError("conflict", "nope");
    },
  },
});

const client = createClient(router, (path, input) => dispatch(path, input, {}));

describe("rpc", () => {
  it("round-trips a typed call", async () => {
    await expect(client.maths.add({ a: 2, b: 3 })).resolves.toEqual({ sum: 5 });
  });

  it("rejects bad input before the handler runs", async () => {
    const res = await dispatch("maths.add", { a: "two" }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bad_request");
  });

  it("carries RpcError codes to the client", async () => {
    await expect(client.maths.fail({})).rejects.toMatchObject({
      code: "conflict",
      message: "nope",
    });
  });

  it("answers unknown paths with not_found", async () => {
    const res = await dispatch("maths.subtract", {}, {});
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
