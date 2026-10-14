import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { cn } from "../lib/cn.ts";

/** Back to the list, on a phone, where the list and a page don't fit side by side. */
export function MobileBack({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Back to your nibblets"
      onClick={() => void navigate({ to: "/" })}
      className={cn(
        "-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-text md:hidden",
        className,
      )}
    >
      <ChevronLeft className="size-5" />
    </button>
  );
}
