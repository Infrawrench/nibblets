import { Menu } from "@base-ui/react/menu";
import { Brain, Check, ChevronDown } from "lucide-react";
import { effortLabels, type Effort, type ModelOption } from "@nibblet/protocol";
import { cn } from "../lib/cn.ts";

/** Reasoning effort, from what the chosen model supports. */
export function EffortMenu({
  model,
  value,
  onChange,
}: {
  model: ModelOption | undefined;
  value: Effort;
  onChange: (effort: Effort) => void;
}) {
  const efforts = model?.efforts ?? [value];
  return (
    <Menu.Root>
      <Menu.Trigger className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-dim hover:bg-hover hover:text-text">
        <Brain className="size-3.5" />
        {effortLabels[value]}
        <ChevronDown className="size-3 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="start" className="z-50">
          <Menu.Popup className="min-w-40 rounded-lg border border-edge bg-panel p-1 shadow-float transition-[opacity,transform] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            <div className="px-2 pt-1 pb-1.5 text-2xs font-medium text-faint">Reasoning</div>
            {efforts.map((e) => (
              <Menu.Item
                key={e}
                onClick={() => onChange(e)}
                className={cn(
                  "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-xs outline-none data-[highlighted]:bg-hover",
                )}
              >
                <span className="flex-1">{effortLabels[e]}</span>
                {model?.defaultEffort === e ? (
                  <span className="text-2xs text-faint">Default</span>
                ) : null}
                {value === e ? (
                  <Check className="size-3.5 text-accent" />
                ) : (
                  <span className="size-3.5" />
                )}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
