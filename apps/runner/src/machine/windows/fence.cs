// nibblet-fence.exe: lets one program reach this machine's own ports (over
// loopback) only on the ports given, with the Windows Filtering Platform,
// which sees loopback connections where Windows' firewall rules don't. For
// Tailscale: in userspace networking, what comes in from the tailnet is
// tailscaled connecting to 127.0.0.1, so this is what the tailnet can reach.
//
// Its filters are persistent, so they hold before the program starts and
// across restarts, and each run replaces the last one's. Compiled in the
// guest by its bootstrap; run as SYSTEM.
//
//   nibblet-fence.exe <program> [port...]

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NibbletFence
{
    const uint RPC_C_AUTHN_WINNT = 10;
    const uint FWPM_FILTER_FLAG_PERSISTENT = 0x1;
    const uint FWPM_SUBLAYER_FLAG_PERSISTENT = 0x1;
    const uint FWP_ACTION_BLOCK = 0x1001;
    const uint FWP_ACTION_PERMIT = 0x1002;
    const uint FWP_UINT8 = 1;
    const uint FWP_UINT16 = 2;
    const uint FWP_UINT32 = 3;
    const uint FWP_BYTE_BLOB_TYPE = 12;
    const uint FWP_MATCH_EQUAL = 0;
    const uint FWP_MATCH_FLAGS_ALL_SET = 6;
    const uint FWP_CONDITION_FLAG_IS_LOOPBACK = 0x1;
    const uint FWP_E_FILTER_NOT_FOUND = 0x80320003;
    const uint FWP_E_ALREADY_EXISTS = 0x80320009;

    static readonly Guid LayerConnectV4 = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    static readonly Guid LayerConnectV6 = new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
    static readonly Guid ConditionAppId = new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971");
    static readonly Guid ConditionFlags = new Guid("632ce23b-5167-435c-86d7-e903684aa80c");
    static readonly Guid ConditionRemotePort = new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b");

    // Nibblets' own: the same each run, so a run can take the last one's away.
    static readonly Guid SubLayer = new Guid("5e0b3c4e-6f1a-4d0e-9a51-6e6962626c01");
    static readonly Guid BlockV4 = new Guid("5e0b3c4e-6f1a-4d0e-9a51-6e6962626c02");
    static readonly Guid BlockV6 = new Guid("5e0b3c4e-6f1a-4d0e-9a51-6e6962626c03");
    static readonly Guid PermitV4 = new Guid("5e0b3c4e-6f1a-4d0e-9a51-6e6962626c04");
    static readonly Guid PermitV6 = new Guid("5e0b3c4e-6f1a-4d0e-9a51-6e6962626c05");

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DisplayData
    {
        public string Name;
        public string Description;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ByteBlob
    {
        public uint Size;
        public IntPtr Data;
    }

    // FWP_VALUE0 and FWP_CONDITION_VALUE0: a type, then a union a pointer wide.
    [StructLayout(LayoutKind.Sequential)]
    struct Value
    {
        public uint Type;
        public IntPtr Data;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Condition
    {
        public Guid FieldKey;
        public uint MatchType;
        public Value ConditionValue;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Action
    {
        public uint Type;
        public Guid FilterType;
    }

    // The union of a UINT64 and a GUID that follows the action.
    [StructLayout(LayoutKind.Sequential)]
    struct Context
    {
        public ulong Low;
        public ulong High;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Filter
    {
        public Guid FilterKey;
        public DisplayData DisplayData;
        public uint Flags;
        public IntPtr ProviderKey;
        public ByteBlob ProviderData;
        public Guid LayerKey;
        public Guid SubLayerKey;
        public Value Weight;
        public uint NumFilterConditions;
        public IntPtr FilterCondition;
        public Action Action;
        public Context ProviderContext;
        public IntPtr Reserved;
        public ulong FilterId;
        public Value EffectiveWeight;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SubLayerInfo
    {
        public Guid SubLayerKey;
        public DisplayData DisplayData;
        public uint Flags;
        public IntPtr ProviderKey;
        public ByteBlob ProviderData;
        public ushort Weight;
    }

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)]
    static extern uint FwpmEngineOpen0(string serverName, uint authnService, IntPtr authIdentity, IntPtr session, out IntPtr engine);

    [DllImport("fwpuclnt.dll")]
    static extern uint FwpmEngineClose0(IntPtr engine);

    [DllImport("fwpuclnt.dll")]
    static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);

    [DllImport("fwpuclnt.dll")]
    static extern uint FwpmTransactionCommit0(IntPtr engine);

    [DllImport("fwpuclnt.dll")]
    static extern uint FwpmTransactionAbort0(IntPtr engine);

    [DllImport("fwpuclnt.dll")]
    static extern uint FwpmSubLayerAdd0(IntPtr engine, ref SubLayerInfo subLayer, IntPtr sd);

    [DllImport("fwpuclnt.dll")]
    static extern uint FwpmFilterAdd0(IntPtr engine, ref Filter filter, IntPtr sd, out ulong id);

    [DllImport("fwpuclnt.dll")]
    static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)]
    static extern uint FwpmGetAppIdFromFileName0(string fileName, out IntPtr appId);

    [DllImport("fwpuclnt.dll")]
    static extern void FwpmFreeMemory0(ref IntPtr p);

    static void Check(uint result, string what)
    {
        if (result != 0) throw new Win32Exception(unchecked((int)result), what + " failed (0x" + result.ToString("x8") + ")");
    }

    static Condition Equal(Guid field, uint type, IntPtr data)
    {
        return new Condition { FieldKey = field, MatchType = FWP_MATCH_EQUAL, ConditionValue = new Value { Type = type, Data = data } };
    }

    static void Add(IntPtr engine, Guid key, Guid layer, uint action, byte weight, List<Condition> conditions)
    {
        int size = Marshal.SizeOf(typeof(Condition));
        IntPtr array = Marshal.AllocHGlobal(size * conditions.Count);
        try
        {
            for (int i = 0; i < conditions.Count; i++)
                Marshal.StructureToPtr(conditions[i], new IntPtr(array.ToInt64() + i * size), false);
            var filter = new Filter
            {
                FilterKey = key,
                DisplayData = new DisplayData { Name = "Nibblets: tailnet fence", Description = "What the tailnet may reach on this machine" },
                Flags = FWPM_FILTER_FLAG_PERSISTENT,
                LayerKey = layer,
                SubLayerKey = SubLayer,
                Weight = new Value { Type = FWP_UINT8, Data = new IntPtr(weight) },
                NumFilterConditions = (uint)conditions.Count,
                FilterCondition = array,
                Action = new Action { Type = action },
            };
            ulong id;
            Check(FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out id), "Adding a filter");
        }
        finally
        {
            Marshal.FreeHGlobal(array);
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: nibblet-fence.exe <program> [port...]");
            return 2;
        }
        var ports = new List<ushort>();
        for (int i = 1; i < args.Length; i++) ports.Add(ushort.Parse(args[i]));

        IntPtr appId;
        Check(FwpmGetAppIdFromFileName0(args[0], out appId), "Finding " + args[0]);
        IntPtr engine;
        Check(FwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, IntPtr.Zero, IntPtr.Zero, out engine), "Opening the filtering engine");
        try
        {
            Check(FwpmTransactionBegin0(engine, 0), "Starting a transaction");
            try
            {
                var subLayer = new SubLayerInfo
                {
                    SubLayerKey = SubLayer,
                    DisplayData = new DisplayData { Name = "Nibblets", Description = "Nibblets' filters" },
                    Flags = FWPM_SUBLAYER_FLAG_PERSISTENT,
                    Weight = 0x100,
                };
                uint added = FwpmSubLayerAdd0(engine, ref subLayer, IntPtr.Zero);
                if (added != FWP_E_ALREADY_EXISTS) Check(added, "Adding a sublayer");
                foreach (Guid old in new[] { BlockV4, BlockV6, PermitV4, PermitV6 })
                {
                    Guid key = old;
                    uint deleted = FwpmFilterDeleteByKey0(engine, ref key);
                    if (deleted != FWP_E_FILTER_NOT_FOUND) Check(deleted, "Removing an old filter");
                }

                var mine = new List<Condition>
                {
                    Equal(ConditionAppId, FWP_BYTE_BLOB_TYPE, appId),
                    new Condition
                    {
                        FieldKey = ConditionFlags,
                        MatchType = FWP_MATCH_FLAGS_ALL_SET,
                        ConditionValue = new Value { Type = FWP_UINT32, Data = new IntPtr(FWP_CONDITION_FLAG_IS_LOOPBACK) },
                    },
                };
                // Everything of its over loopback is blocked, but for the ports given: in
                // one filter, since conditions on the same field are any of them.
                Add(engine, BlockV4, LayerConnectV4, FWP_ACTION_BLOCK, 1, mine);
                Add(engine, BlockV6, LayerConnectV6, FWP_ACTION_BLOCK, 1, mine);
                if (ports.Count > 0)
                {
                    var shared = new List<Condition>(mine);
                    foreach (ushort port in ports) shared.Add(Equal(ConditionRemotePort, FWP_UINT16, new IntPtr(port)));
                    Add(engine, PermitV4, LayerConnectV4, FWP_ACTION_PERMIT, 2, shared);
                    Add(engine, PermitV6, LayerConnectV6, FWP_ACTION_PERMIT, 2, shared);
                }
                Check(FwpmTransactionCommit0(engine), "Committing the filters");
            }
            catch
            {
                FwpmTransactionAbort0(engine);
                throw;
            }
        }
        finally
        {
            FwpmEngineClose0(engine);
            FwpmFreeMemory0(ref appId);
        }
        Console.Error.WriteLine("nibblet-fence: " + args[0] + " may reach " + (ports.Count > 0 ? "ports " + string.Join(", ", ports) : "nothing") + " here");
        return 0;
    }
}
