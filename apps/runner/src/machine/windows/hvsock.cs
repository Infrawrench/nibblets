// nibblet-hvsock.exe: the agent's port on Hyper-V, a Hyper-V socket, relayed
// over this process's stdio for the guest agent, since Node can't open one.
// It listens for good and takes the host's connections one at a time, so to
// the agent it's a serial line: one stream, whoever's on the other end, and
// what's written with no one there goes nowhere. Compiled in the guest by
// its bootstrap.
//
// Only the host is let in: it listens for the parent partition alone, and
// turns away a connection from inside this VM, so nothing here can pose as
// the host and run things as SYSTEM.
//
//   nibblet-hvsock.exe <service id>

using System;
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
    // HV_GUID_PARENT: bound to it, a guest hears only from its host.
    static readonly Guid Parent = new Guid("a42e7cda-d03f-480c-9cc2-a4de20abb878");
    // HV_GUID_LOOPBACK: this VM, talking to itself.
    static readonly Guid Loopback = new Guid("e0e16197-dd56-4a10-9195-5ee7a155a838");

    static readonly object Gate = new object();
    static Socket current;

    // The agent's output, to whichever connection is the host's now.
    static void ToHost()
    {
        Stream stdin = Console.OpenStandardInput();
        var buffer = new byte[65536];
        int n;
        while ((n = stdin.Read(buffer, 0, buffer.Length)) > 0)
        {
            Socket conn;
            lock (Gate) conn = current;
            if (conn == null) continue;
            try { conn.Send(buffer, 0, n, SocketFlags.None); }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
        }
        Environment.Exit(0);
    }

    public static int Main(string[] args)
    {
        var listener = new Socket(HyperVEndPoint.HyperV, SocketType.Stream, (ProtocolType)1);
        listener.Bind(new HyperVEndPoint(Parent, new Guid(args[0])));
        listener.Listen(1);
        Console.Error.WriteLine("nibblet-hvsock: listening for the host");
        Stream stdout = Console.OpenStandardOutput();
        var toHost = new Thread(ToHost) { IsBackground = true };
        toHost.Start();
        var buffer = new byte[65536];
        while (true)
        {
            Socket conn = listener.Accept();
            var from = conn.RemoteEndPoint as HyperVEndPoint;
            if (from == null || from.VmId == Loopback)
            {
                conn.Close();
                continue;
            }
            lock (Gate) current = conn;
            try
            {
                int n;
                while ((n = conn.Receive(buffer)) > 0)
                {
                    stdout.Write(buffer, 0, n);
                    stdout.Flush();
                }
            }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            lock (Gate)
            {
                if (current == conn) current = null;
            }
            conn.Close();
        }
    }
}
