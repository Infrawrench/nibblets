import { useEffect, useState, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  CalendarClock,
  HeartPulse,
  History,
  MessageSquare,
  Moon,
  Palette,
  Pencil,
  Power,
  Settings2,
  Trash2,
} from "lucide-react";
import type { Nibblet } from "@nibblets/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import { openPanel, type PanelTab } from "../lib/panels.ts";
import { cn } from "../lib/cn.ts";
import { HamsterDialog } from "./hamster/HamsterDialog.tsx";
import { Modal } from "./ui/Modal.tsx";
import { Button } from "./ui/Button.tsx";
import { Input } from "./ui/Field.tsx";

const itemClass =
  "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-xs outline-none data-[highlighted]:bg-hover [&_svg]:size-3.5 [&_svg]:text-dim";

/** Right-click on a nibblet in the sidebar: open it, its panels, rename, restyle, sleep, delete. */
export function NibbletMenu({
  connection,
  nibblet,
  children,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const [renaming, setRenaming] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const client = connection.client.nibblets;
  const asleep = nibblet.status === "stopped";

  const open = (panel?: PanelTab) => {
    if (panel) openPanel(panel);
    void navigate({ to: "/n/$server/$id", params: { server: connection.id, id: nibblet.id } });
  };

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className="min-w-44 rounded-lg border border-edge bg-panel p-1 shadow-float transition-[opacity] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
              <div className="truncate px-2 pt-1 pb-1.5 text-2xs font-medium text-faint">
                {nibblet.name}
              </div>
              <ContextMenu.Item className={itemClass} onClick={() => open()}>
                <MessageSquare />
                Open
              </ContextMenu.Item>
              <ContextMenu.Item className={itemClass} onClick={() => open("settings")}>
                <Settings2 />
                Settings
              </ContextMenu.Item>
              <ContextMenu.Item className={itemClass} onClick={() => open("schedules")}>
                <CalendarClock />
                Schedules
              </ContextMenu.Item>
              <ContextMenu.Item className={itemClass} onClick={() => open("snapshots")}>
                <History />
                Snapshots
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <ContextMenu.Item className={itemClass} onClick={() => setRenaming(true)}>
                <Pencil />
                Rename…
              </ContextMenu.Item>
              <ContextMenu.Item className={itemClass} onClick={() => setRestyling(true)}>
                <Palette />
                Edit look…
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <ContextMenu.Item
                className={itemClass}
                onClick={() => void client.wake({ id: nibblet.id })}
              >
                <HeartPulse />
                Check in now
              </ContextMenu.Item>
              <ContextMenu.Item
                className={itemClass}
                onClick={() =>
                  void (asleep ? client.start({ id: nibblet.id }) : client.stop({ id: nibblet.id }))
                }
              >
                {asleep ? <Power /> : <Moon />}
                {asleep ? "Wake up" : "Put to sleep"}
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <ContextMenu.Item
                className={cn(itemClass, "text-danger [&_svg]:text-danger")}
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
                Delete…
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        name={nibblet.name}
        onSave={(name) => void client.update({ id: nibblet.id, name })}
      />
      <HamsterDialog
        open={restyling}
        onOpenChange={setRestyling}
        initial={nibblet.look}
        title={`${nibblet.name}'s look`}
        onSave={(look) => void client.update({ id: nibblet.id, look })}
      />
      <Modal
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${nibblet.name}?`}
        className="w-[min(92vw,440px)]"
      >
        <div className="p-4">
          <p className="text-sm text-dim">
            Its container, thread, schedules and memories go with it. This can't be undone.
          </p>
          <div className="mt-4 flex justify-end gap-1.5">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setDeleting(false);
                await client.delete({ id: nibblet.id });
                if (params.id === nibblet.id) void navigate({ to: "/" });
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  name,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  // Start from the current name each time it opens.
  useEffect(() => {
    if (open) setValue(name);
  }, [open, name]);
  const trimmed = value.trim();
  const save = () => {
    if (!trimmed) return;
    onSave(trimmed);
    onOpenChange(false);
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Rename" className="w-[min(92vw,440px)]">
      <form
        className="p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} autoFocus />
        <div className="mt-4 flex justify-end gap-1.5">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!trimmed}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
