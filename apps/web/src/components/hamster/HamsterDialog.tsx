import { useEffect, useState } from "react";
import type { HamsterLook } from "@nibblets/protocol";
import { Modal } from "../ui/Modal.tsx";
import { Button } from "../ui/Button.tsx";
import { HamsterEditor } from "./HamsterEditor.tsx";

/** The hamster editor on its own, for restyling an existing nibblet. */
export function HamsterDialog({
  open,
  onOpenChange,
  initial,
  title,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: HamsterLook;
  title: string;
  onSave: (look: HamsterLook) => void;
}) {
  const [look, setLook] = useState(initial);
  useEffect(() => {
    if (open) setLook(initial);
  }, [open, initial]);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <div className="p-4">
        <HamsterEditor look={look} onChange={setLook} />
      </div>
      <div className="sticky bottom-0 flex justify-end gap-1.5 border-t border-line bg-panel px-4 py-2.5">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onSave(look);
            onOpenChange(false);
          }}
        >
          Done
        </Button>
      </div>
    </Modal>
  );
}
