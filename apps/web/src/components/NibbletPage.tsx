import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Brain,
  CalendarClock,
  Globe,
  HeartPulse,
  History,
  PanelRight,
  Settings2,
} from "lucide-react";
import { harnesses } from "@nibblet/protocol";
import { modelLabel, useModels } from "../lib/models.ts";
import { useNibblets, useServer, useServers, useThread } from "../lib/servers.tsx";
import { runningTurn } from "../lib/thread.ts";
import { storage } from "../lib/storage.ts";
import { isPanelTab, onPanelRequest, PANEL_KEY, type PanelTab } from "../lib/panels.ts";
import { relativeTime } from "../lib/time.ts";
import type { ServerConnection } from "../lib/connection.ts";
import { Hamster } from "./hamster/Hamster.tsx";
import { HarnessIcon } from "./HarnessIcon.tsx";
import { ThreadView } from "./thread/ThreadView.tsx";
import { Composer } from "./thread/Composer.tsx";
import { BrowserPanel } from "./panels/BrowserPanel.tsx";
import { SchedulesPanel } from "./panels/SchedulesPanel.tsx";
import { MemoryPanel } from "./panels/MemoryPanel.tsx";
import { SnapshotsPanel } from "./panels/SnapshotsPanel.tsx";
import { NibbletSettings } from "./panels/NibbletSettings.tsx";
import { Segmented } from "./ui/Segmented.tsx";
import { Button } from "./ui/Button.tsx";
import { cn } from "../lib/cn.ts";

function initialPanel(): PanelTab | null {
  const saved = storage.get(PANEL_KEY);
  return isPanelTab(saved) ? saved : null;
}

export function NibbletPage({ server, id }: { server: string; id: string }) {
  const connection = useServer(server);
  if (!connection) return <Missing text="That server isn't connected." />;
  return <NibbletView connection={connection} id={id} />;
}

function NibbletView({ connection, id }: { connection: ServerConnection; id: string }) {
  const nibblets = useNibblets(connection);
  const servers = useServers();
  // Which machine it runs on, whenever there's more than one to choose from.
  const systemName =
    servers.systems.length > 1 || servers.central ? servers.system(connection.id)?.name : null;
  const thread = useThread(connection, id);
  const catalogue = useModels(connection);
  const [panel, setPanelState] = useState<PanelTab | null>(initialPanel);
  const setPanel = (p: PanelTab | null) => {
    setPanelState(p);
    if (p) storage.set(PANEL_KEY, p);
    else storage.remove(PANEL_KEY);
  };
  // The sidebar's menu can ask for a panel (its "Settings" item, say).
  useEffect(() => onPanelRequest(setPanelState), []);

  const nibblet = nibblets.data?.find((n) => n.id === id);
  if (nibblets.isPending) return <div className="flex-1" />;
  if (!nibblet) return <Missing text="This nibblet has gone." />;

  const items = thread.data ?? [];
  const running = runningTurn(items) !== null;
  const parent = nibblet.parentId
    ? nibblets.data?.find((n) => n.id === nibblet.parentId)
    : undefined;
  const model = catalogue.find(nibblet.harness, nibblet.model);

  return (
    <div className="flex min-w-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="shell-titlebar flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Hamster look={nibblet.look} size={26} status={nibblet.status} />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="flex items-center gap-1.5 truncate text-sm font-semibold">
              {parent ? (
                <>
                  <Link
                    to="/n/$server/$id"
                    params={{ server: connection.id, id: parent.id }}
                    className="font-normal text-dim hover:underline"
                  >
                    {parent.name}
                  </Link>
                  <span className="font-normal text-faint">/</span>
                </>
              ) : null}
              {nibblet.name}
              {nibblet.statusText ? (
                <span
                  className="min-w-0 truncate text-xs font-normal text-dim"
                  title={nibblet.statusText}
                >
                  · {nibblet.statusEmoji ? `${nibblet.statusEmoji} ` : ""}
                  {nibblet.statusText}
                </span>
              ) : null}
              {nibblet.awaitingApproval ? (
                <span className="shrink-0 text-xs font-normal text-warning">· Needs approval</span>
              ) : null}
            </span>
            <span className="flex items-center gap-1 truncate text-2xs text-faint">
              <HarnessIcon harness={nibblet.harness} className="size-3" />
              {systemName ? <>{systemName} · </> : null}
              {harnesses[nibblet.harness].label} · {modelLabel(model, nibblet.model)}
              {nibblet.heartbeats.length > 0 ? (
                <>
                  {" · "}
                  <HeartPulse className="size-3" />{" "}
                  {nibblet.heartbeats.length === 1
                    ? `${nibblet.heartbeats[0]?.name}, every ${nibblet.heartbeats[0]?.everyMinutes} min`
                    : `${nibblet.heartbeats.length} heartbeats`}
                </>
              ) : null}
              {nibblet.status === "error" && nibblet.statusDetail ? (
                <span className="text-danger"> · {nibblet.statusDetail}</span>
              ) : nibblet.lastActivityAt ? (
                <> · active {relativeTime(nibblet.lastActivityAt)}</>
              ) : null}
            </span>
          </div>
          <Segmented<PanelTab>
            value={panel ?? "browser"}
            onChange={(p) => setPanel(p === panel ? null : p)}
            className={cn(
              !panel &&
                "[&_[aria-selected=true]]:bg-transparent [&_[aria-selected=true]]:shadow-none",
            )}
            options={[
              { value: "browser", label: <Globe />, title: "Browser" },
              { value: "schedules", label: <CalendarClock />, title: "Schedules" },
              { value: "memory", label: <Brain />, title: "Memory" },
              { value: "snapshots", label: <History />, title: "Snapshots" },
              { value: "settings", label: <Settings2 />, title: "Settings" },
            ]}
          />
          <Button
            size="icon"
            variant="ghost"
            title={panel ? "Hide panel" : "Show panel"}
            onClick={() => setPanel(panel ? null : "browser")}
          >
            <PanelRight />
          </Button>
        </header>
        <ThreadView
          items={items}
          server={connection.id}
          nibblets={nibblets.data ?? []}
          onDecide={async (approvalId, approve, reason) => {
            await connection.client.nibblets.decide({
              id: nibblet.id,
              approvalId,
              approve,
              reason,
            });
          }}
          onResume={async () => {
            await connection.client.nibblets.resume({ id: nibblet.id });
          }}
        />
        <Composer connection={connection} nibblet={nibblet} running={running} />
      </div>
      {panel ? (
        <aside className="flex w-[26rem] shrink-0 flex-col border-l border-line bg-panel max-lg:hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === "browser" ? (
              <BrowserPanel connection={connection} nibblet={nibblet} />
            ) : null}
            {panel === "schedules" ? (
              <SchedulesPanel connection={connection} nibblet={nibblet} />
            ) : null}
            {panel === "memory" ? <MemoryPanel connection={connection} nibblet={nibblet} /> : null}
            {panel === "snapshots" ? (
              <SnapshotsPanel connection={connection} nibblet={nibblet} />
            ) : null}
            {panel === "settings" ? (
              <NibbletSettings key={nibblet.id} connection={connection} nibblet={nibblet} />
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function Missing({ text }: { text: string }) {
  return <div className="flex flex-1 items-center justify-center text-sm text-faint">{text}</div>;
}
