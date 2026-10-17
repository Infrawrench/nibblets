// nibblet-runas.exe: starts a command as the nibblet agent's local user,
// from SYSTEM, with this process's own stdio and environment, and waits
// for it, ending with its exit code. Its whole tree is in a job that ends
// with this process, so stopping this stops everything it started.
//
//   nibblet-runas.exe <user> <program> [args...]
//
// The password is read from C:\ProgramData\Nibblets\agent.json, which
// only SYSTEM and Administrators can open (see entry/windows.ts). Compiled
// in the guest by its bootstrap, with PowerShell's Add-Type.

using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class NibbletRunAs
{
    const int LOGON32_LOGON_INTERACTIVE = 2;
    const int LOGON32_PROVIDER_DEFAULT = 0;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint HANDLE_FLAG_INHERIT = 1;
    const uint INFINITE = 0xFFFFFFFF;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    /** A command line Windows splits back into the same arguments. */
    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') sb.Append('\\', slashes * 2 + 1);
            else sb.Append('\\', slashes);
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static IntPtr Inheritable(int which)
    {
        IntPtr h = GetStdHandle(which);
        SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        return h;
    }

    public static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: nibblet-runas.exe <user> <program> [args...]");
            return 2;
        }
        string secret = File.ReadAllText(@"C:\ProgramData\Nibblets\agent.json");
        Match m = Regex.Match(secret, "\"password\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        if (!m.Success) { Console.Error.WriteLine("nibblet-runas: no password for " + args[0]); return 2; }
        string password = Regex.Unescape(m.Groups[1].Value);

        IntPtr token;
        if (!LogonUser(args[0], ".", password, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, out token))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "LogonUser");

        // Everything it starts ends when this does, however this ends.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));

        var cmd = new StringBuilder();
        for (int i = 1; i < args.Length; i++) { if (i > 1) cmd.Append(' '); cmd.Append(Quote(args[i])); }
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        // An empty desktop: SYSTEM's isn't the user's to open, so it gets a window station of its own.
        si.lpDesktop = "";
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = Inheritable(-10);
        si.hStdOutput = Inheritable(-11);
        si.hStdError = Inheritable(-12);
        PROCESS_INFORMATION pi;
        // No environment block: it gets this process's, which is what the entry gave it.
        if (!CreateProcessAsUser(token, null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero,
                Environment.CurrentDirectory, ref si, out pi))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser");
        AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        return (int)code;
    }
}
