import { z } from "zod";

/**
 * One line of `kimi -p --output-format stream-json`, which is OpenAI chat
 * shaped: an assistant message carries the text so far plus any tool calls
 * the model made, and each tool call is followed by its own tool message.
 * `meta` lines carry the CLI's own notices, such as the session to resume
 * next turn and any provider retry.
 *
 * Both the runner and the tests read the stream through this one definition,
 * so a line the CLI adds later is ignored rather than mistaken for something
 * else.
 */
export const KimiLine = z.union([
  z.object({
    role: z.literal("assistant"),
    content: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          type: z.literal("function"),
          id: z.string(),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .optional(),
  }),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string(),
    content: z.string(),
  }),
  z.object({ role: z.literal("meta"), type: z.string() }).loose(),
]);
export type KimiLine = z.infer<typeof KimiLine>;
