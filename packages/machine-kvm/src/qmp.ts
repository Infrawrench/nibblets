import { connectTo } from "@nibblets/machine/host";
import { z } from "zod";

/** QMP, QEMU's control socket: a JSON object a line, a greeting, then a handshake. */

/** Says things to a QEMU over QMP, its control socket, one after another. */
export async function qmp(
  path: string,
  commands: { execute: string; arguments?: object }[],
): Promise<void> {
  const socket = await connectTo(path);
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    socket.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // The greeting first, then capabilities' answer: then it listens.
      if (!ready && text.includes('"QMP"')) {
        socket.write(JSON.stringify({ execute: "qmp_capabilities" }));
      } else if (!ready && text.includes('"return"')) {
        ready = true;
        for (const command of commands) socket.write(JSON.stringify(command));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      }
    });
    socket.once("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("QEMU didn't answer"));
    }, 5000);
  });
}

/** A line QEMU says: its greeting, an answer, an error, or an event (ignored). */
const Line = z.object({
  QMP: z.object({}).loose().optional(),
  return: z.json().optional(),
  error: z.object({ desc: z.string() }).optional(),
});

/** One thing to say to QEMU: a command's name, or a command and its arguments. */
export type QmpCommand = string | { execute: string; arguments?: object };

/** Asks QEMU one thing over its control socket, and has its answer, as `answer` says it looks. */
export async function ask<T>(path: string, command: QmpCommand, answer: z.ZodType<T>): Promise<T> {
  const socket = await connectTo(path);
  try {
    return await new Promise<T>((resolve, reject) => {
      let buffered = "";
      let ready = false;
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const text of lines) {
          if (!text.trim()) continue;
          const line = Line.safeParse(JSON.parse(text));
          if (!line.success) continue;
          if (line.data.error) return reject(new Error(line.data.error.desc));
          if (line.data.QMP) {
            socket.write(JSON.stringify({ execute: "qmp_capabilities" }));
          } else if (line.data.return !== undefined && !ready) {
            // The handshake's answer: now it takes commands.
            ready = true;
            socket.write(
              JSON.stringify(typeof command === "string" ? { execute: command } : command),
            );
          } else if (line.data.return !== undefined) {
            const said = answer.safeParse(line.data.return);
            return said.success ? resolve(said.data) : reject(said.error);
          }
        }
      });
      socket.once("error", reject);
      setTimeout(() => reject(new Error("QEMU didn't answer")), 5000);
    });
  } finally {
    socket.destroy();
  }
}
