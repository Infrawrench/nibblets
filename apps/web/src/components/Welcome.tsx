import { useState } from "react";
import { Plus } from "lucide-react";
import { randomHamsterLook } from "@nibblets/protocol";
import { Hamster } from "./hamster/Hamster.tsx";
import { CreateNibbletDialog } from "./CreateNibbletDialog.tsx";
import { Button } from "./ui/Button.tsx";

export function Welcome() {
  const [creating, setCreating] = useState(false);
  const [looks] = useState(() => [randomHamsterLook(), randomHamsterLook(), randomHamsterLook()]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex items-end -space-x-3">
        <Hamster look={looks[0] ?? randomHamsterLook()} size={64} status="idle" />
        <Hamster look={looks[1] ?? randomHamsterLook()} size={88} status="working" />
        <Hamster look={looks[2] ?? randomHamsterLook()} size={64} status="stopped" />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h1 className="text-lg font-semibold">Your nibblets</h1>
        <p className="text-sm text-dim">
          Little agents that live on your server, check in on a heartbeat, remember things, and get
          on with work while you're away. Pick one from the list, or make a new one.
        </p>
      </div>
      <Button variant="primary" onClick={() => setCreating(true)}>
        <Plus />
        New nibblet
      </Button>
      <CreateNibbletDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
