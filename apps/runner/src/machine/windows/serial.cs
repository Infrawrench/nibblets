// nibblet-serial.exe: the agent's port on Windows, a COM port (COM2, which
// the hypervisor connects to the host bridge), relayed over this process's
// stdio for the guest agent, since Node can't set a serial port up. Ends
// when either side does. Compiled in the guest by its bootstrap.
//
//   nibblet-serial.exe COM2

using System;
using System.IO;
using System.IO.Ports;
using System.Threading;

public static class NibbletSerial
{
    static void Pump(Stream from, Stream to, bool fromPort)
    {
        var buffer = new byte[65536];
        int errors = 0;
        while (true)
        {
            try
            {
                int n = from.Read(buffer, 0, buffer.Length);
                if (n <= 0) break;
                errors = 0;
                to.Write(buffer, 0, n);
                to.Flush();
            }
            catch (IOException e)
            {
                // .NET aborts a port's reads on any line error until it's cleared:
                // that's worth a try again, not ending every connection over it.
                if (!fromPort || ++errors > 50) break;
                Console.Error.WriteLine("nibblet-serial: " + e.Message);
                Thread.Sleep(20);
            }
            catch (ObjectDisposedException) { break; }
        }
        Environment.Exit(0);
    }

    public static int Main(string[] args)
    {
        string name = args.Length > 0 ? args[0] : "COM2";
        // The host's end is a pipe, not a wire: none of these matter but that they agree.
        var port = new SerialPort(name, 115200, Parity.None, 8, StopBits.One);
        port.Handshake = Handshake.None;
        // Room for a burst while the agent's busy: the driver's own 4 KB drops what doesn't fit.
        port.ReadBufferSize = 1 << 20;
        port.WriteBufferSize = 1 << 20;
        port.ReadTimeout = SerialPort.InfiniteTimeout;
        port.WriteTimeout = SerialPort.InfiniteTimeout;
        port.Open();
        Stream serial = port.BaseStream;
        Stream stdin = Console.OpenStandardInput();
        Stream stdout = Console.OpenStandardOutput();
        var fromHost = new Thread(() => Pump(serial, stdout, true)) { IsBackground = true };
        fromHost.Start();
        Pump(stdin, serial, false);
        return 0;
    }
}
