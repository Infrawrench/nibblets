import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActiveHours, type Nibblet } from "@nibblet/protocol";
import { Cron } from "croner";
import type { Context } from "hono";
import { z } from "zod";
import type { Conductor } from "./conductor.ts";
import type { Scheduler } from "./scheduler.ts";
import { toNibblet, type Store } from "./store.ts";

interface ToolDeps {
  store: Store;
  conductor: Conductor;
  scheduler: Scheduler;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const json = (value: object) => text(JSON.stringify(value, null, 2));

function validCron(pattern: string, timezone: string): string | null {
  try {
    new Cron(pattern, { timezone, paused: true }).stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The nibblet tools, scoped to the nibblet whose token made the call. */
function buildServer(nibblet: Nibblet, deps: ToolDeps): McpServer {
  const { store, conductor, scheduler } = deps;
  const server = new McpServer({ name: "nibblet", version: "0.1.0" });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search your long-term memory (your notes, notes shared by every nibblet, and optionally past conversation) by meaning. Use before asking the user something you may already know.",
      inputSchema: {
        query: z.string().describe("What you're trying to remember"),
        limit: z.int().min(1).max(50).default(8),
        includeTranscript: z
          .boolean()
          .default(true)
          .describe("Also search past turns of this thread"),
      },
    },
    async ({ query, limit, includeTranscript }) => {
      const results = await store.searchMemories({
        nibbletId: nibblet.id,
        query,
        limit,
        kinds: includeTranscript ? ["note", "transcript"] : ["note"],
      });
      if (results.length === 0) return text("Nothing relevant in memory.");
      return json(
        results.map((m) => ({
          id: m.id,
          content: m.content,
          tags: m.tags,
          shared: m.nibbletId === null,
          savedAt: m.createdAt,
          score: m.score === null ? null : Math.round(m.score * 100) / 100,
        })),
      );
    },
  );

  server.registerTool(
    "memory_save",
    {
      description:
        "Save something to long-term memory. Your container's disk is temporary; this isn't. Save facts about the user, decisions, progress on long tasks, and anything you'd want to know next time. One idea per note.",
      inputSchema: {
        content: z.string().min(1),
        tags: z.array(z.string()).default([]),
        shared: z.boolean().default(false).describe("Share with every nibblet on this server"),
      },
    },
    async ({ content, tags, shared }) => {
      const memory = await store.saveMemory({
        nibbletId: shared ? null : nibblet.id,
        content,
        tags,
      });
      return text(`Saved as ${memory.id}.`);
    },
  );

  server.registerTool(
    "memory_forget",
    {
      description: "Delete a note from memory by id, for when it's wrong or out of date.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      text(
        (await store.deleteMemory(id, nibblet.id)) ? "Forgotten." : `No memory ${id} you can see.`,
      ),
  );

  server.registerTool(
    "schedule_create",
    {
      description:
        "Schedule a prompt to be sent to you later: repeatedly with a cron expression (`0 9 * * 1-5`), or once at a time (ISO 8601). When it fires you get a turn with the prompt.",
      inputSchema: {
        name: z.string().min(1),
        prompt: z
          .string()
          .min(1)
          .describe("What to do when it fires; write it for your future self"),
        cron: z.string().optional(),
        runAt: z.iso.datetime({ offset: true }).optional(),
        timezone: z.string().default("UTC").describe("IANA timezone, e.g. Europe/London"),
      },
    },
    async ({ name, prompt, cron, runAt, timezone }) => {
      if ((cron === undefined) === (runAt === undefined))
        return text("Give exactly one of cron or runAt.");
      if (cron) {
        const problem = validCron(cron, timezone);
        if (problem) return text(`That cron expression doesn't parse: ${problem}`);
      }
      const row = await store.createSchedule({
        nibbletId: nibblet.id,
        name,
        prompt,
        cron: cron ?? null,
        runAt: runAt ? new Date(runAt) : null,
        timezone,
      });
      await scheduler.arm(row.id);
      const next = scheduler.nextRun(row.id);
      return text(
        `Scheduled ${row.id}. Next run: ${next ? next.toISOString() : "never (time already passed)"}.`,
      );
    },
  );

  server.registerTool(
    "schedule_list",
    { description: "List your schedules.", inputSchema: {} },
    async () => json(await scheduler.describe(nibblet.id)),
  );

  server.registerTool(
    "schedule_delete",
    { description: "Delete one of your schedules by id.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const row = await store.scheduleRow(id).catch(() => null);
      if (!row || row.nibbletId !== nibblet.id) return text(`No schedule ${id} of yours.`);
      scheduler.disarm(id);
      await store.deleteSchedule(id);
      return text("Deleted.");
    },
  );

  server.registerTool(
    "instructions_update",
    {
      description:
        "Rewrite your standing instructions: who you are, what you look after, and how the user wants you to work. They're shown to you at the start of every turn. Update them when the user tells you your job or how they like things done, keeping what still applies. Pass the complete new text, not a diff.",
      inputSchema: {
        instructions: z.string().max(8000).describe("The full new instructions"),
      },
    },
    async ({ instructions }) => {
      await store.updateNibblet(nibblet.id, { instructions: instructions.trim() });
      return text("Instructions updated.");
    },
  );

  server.registerTool(
    "heartbeat_configure",
    {
      description:
        "Set up your heartbeat: a regular turn where you check on things without being asked. The checklist is what you look at each time.",
      inputSchema: {
        enabled: z.boolean(),
        everyMinutes: z
          .int()
          .min(5)
          .max(24 * 60)
          .optional(),
        checklist: z.string().optional().describe("What to check on each heartbeat"),
        activeHours: ActiveHours.nullable()
          .optional()
          .describe("Only beat between these local times"),
      },
    },
    async ({ enabled, everyMinutes, checklist, activeHours }) => {
      const current = (await store.getNibblet(nibblet.id)).heartbeat;
      const heartbeat = {
        enabled,
        everyMinutes: everyMinutes ?? current.everyMinutes,
        prompt: checklist ?? current.prompt,
        activeHours: activeHours === undefined ? current.activeHours : activeHours,
      };
      await store.updateNibblet(nibblet.id, { heartbeat });
      return json({ heartbeat });
    },
  );

  server.registerTool(
    "spawn_subagent",
    {
      description:
        "Start a sub-agent: a new nibblet in its own container that works on one task in parallel with you. Its final answer is sent back to you as a message when it's done. Give it everything it needs; it doesn't see this conversation.",
      inputSchema: {
        name: z.string().min(1).max(60).describe("A short name, shown in the UI"),
        task: z.string().min(1).describe("The complete task, with all context it needs"),
        instructions: z
          .string()
          .optional()
          .describe("Standing instructions for how it should work"),
        model: z.string().optional().describe("Defaults to your model"),
      },
    },
    async ({ name, task, instructions, model }) => {
      const parent = await store.getNibblet(nibblet.id);
      const child = await conductor.spawnSubagent(
        parent,
        { name, task, instructions, model },
        null,
      );
      return text(
        `Started sub-agent ${child.name} (${child.id}). You'll get its answer as a message.`,
      );
    },
  );

  server.registerTool(
    "subagent_status",
    { description: "List your sub-agents and what they're doing.", inputSchema: {} },
    async () => {
      const children = await store.children(nibblet.id);
      return json(
        children.map((c) => ({ id: c.id, name: c.name, status: c.status, detail: c.statusDetail })),
      );
    },
  );

  return server;
}

/** Handles `/mcp`: authenticates the nibblet by token and serves its tools statelessly. */
export function mcpHandler(deps: ToolDeps) {
  return async (c: Context) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const row = token ? await deps.store.nibbletByToken(token) : null;
    if (!row) return c.json({ error: "unauthorized" }, 401);
    const server = buildServer(toNibblet(row), deps);
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c);
  };
}
