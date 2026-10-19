import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * nibblet-hvsock.exe: a Hyper-V socket to a VM's guest agent, relayed over
 * stdio for the bridge, since Node can't open one. It says "connected" on
 * stderr once it is, or why not and exits; then it ends when either side
 * does. Built from here with .NET Framework's own compiler, which every
 * Windows has, the first time it's needed.
 *
 *   nibblet-hvsock.exe <VM id> <service id>
 */
export const HVSOCK_CS = `using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;

// SOCKADDR_HV: the family, a reserved short, then the VM's id and the service's.
public class HyperVEndPoint : EndPoint
{
    public const AddressFamily HyperV = (AddressFamily)34;
    public Guid VmId;
    public Guid ServiceId;

    public HyperVEndPoint(Guid vmId, Guid serviceId)
    {
        VmId = vmId;
        ServiceId = serviceId;
    }

    public override AddressFamily AddressFamily { get { return HyperV; } }

    public override SocketAddress Serialize()
    {
        var address = new SocketAddress(HyperV, 36);
        byte[] vm = VmId.ToByteArray();
        byte[] service = ServiceId.ToByteArray();
        for (int i = 0; i < 16; i++)
        {
            address[4 + i] = vm[i];
            address[20 + i] = service[i];
        }
        return address;
    }

    public override EndPoint Create(SocketAddress address)
    {
        byte[] vm = new byte[16];
        byte[] service = new byte[16];
        for (int i = 0; i < 16; i++)
        {
            vm[i] = address[4 + i];
            service[i] = address[20 + i];
        }
        return new HyperVEndPoint(new Guid(vm), new Guid(service));
    }
}

public static class NibbletHvSock
{
    static void Pump(Stream from, Stream to)
    {
        var buffer = new byte[65536];
        try
        {
            int n;
            while ((n = from.Read(buffer, 0, buffer.Length)) > 0)
            {
                to.Write(buffer, 0, n);
                to.Flush();
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        Environment.Exit(0);
    }

    public static int Main(string[] args)
    {
        // HV_PROTOCOL_RAW
        var socket = new Socket(HyperVEndPoint.HyperV, SocketType.Stream, (ProtocolType)1);
        try
        {
            socket.Connect(new HyperVEndPoint(new Guid(args[0]), new Guid(args[1])));
        }
        catch (SocketException e)
        {
            Console.Error.WriteLine("nibblet-hvsock: " + e.Message);
            return 1;
        }
        Console.Error.WriteLine("connected");
        var stream = new NetworkStream(socket, true);
        Stream stdin = Console.OpenStandardInput();
        Stream stdout = Console.OpenStandardOutput();
        var fromGuest = new Thread(() => Pump(stream, stdout)) { IsBackground = true };
        fromGuest.Start();
        Pump(stdin, stream);
        return 0;
    }
}
`;

/** .NET Framework's compiler: 64-bit where there is one. */
function csc(): string {
  const windir = process.env.WINDIR ?? "C:\\Windows";
  const framework64 = join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  return existsSync(framework64)
    ? framework64
    : join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
}

const building = new Map<string, Promise<string>>();

/** The helper, built in `dir` once per version of its source. */
export function hvsockHelper(dir: string): Promise<string> {
  const version = createHash("sha256").update(HVSOCK_CS).digest("hex").slice(0, 12);
  const exe = join(dir, `nibblet-hvsock-${version}.exe`);
  let built = building.get(exe);
  if (!built) {
    built = (async () => {
      if (existsSync(exe)) return exe;
      await mkdir(dir, { recursive: true });
      const source = join(dir, `nibblet-hvsock-${version}.cs`);
      await writeFile(source, HVSOCK_CS);
      await run(csc(), ["/nologo", "/target:exe", `/out:${exe}`, source], { timeout: 120_000 });
      return exe;
    })();
    built.catch(() => building.delete(exe));
    building.set(exe, built);
  }
  return built;
}

/**
 * A connection to a VM's service over a Hyper-V socket, through the helper:
 * once it says it's connected, or failing with why it couldn't (the guest
 * isn't listening yet, say).
 */
export function connectHvSock(helper: string, vmId: string, serviceId: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [vmId, serviceId], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let said = "";
    let open = false;
    const stream = new Duplex({
      read() {
        child.stdout.resume();
      },
      write(chunk: Buffer, _enc, done) {
        if (child.stdin.write(chunk)) done();
        else child.stdin.once("drain", () => done());
      },
      final(done) {
        child.stdin.end();
        done();
      },
      destroy(err, done) {
        if (child.exitCode === null) child.kill();
        done(err);
      },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stream.push(chunk)) child.stdout.pause();
    });
    child.stdout.once("end", () => stream.push(null));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (!open && said.includes("connected")) {
        open = true;
        resolve(stream);
      }
    });
    child.once("error", (err) => (open ? stream.destroy(err) : reject(err)));
    child.once("exit", (code) => {
      if (!open) reject(new Error(said.trim() || `nibblet-hvsock exited ${code ?? "?"}`));
      else stream.destroy();
    });
  });
}
