import type { ThirdParty, ThirdPartyKind } from "@nibblets/protocol";
import { cn } from "../../lib/cn.ts";

/**
 * A third party's logo where a nibblet has its hamster, with a dot for how it
 * is. It never sleeps, so answering is online, not a nibblet's grey for idle.
 */
export function ThirdPartyAvatar({
  kind,
  party,
  size = 22,
}: {
  kind: ThirdPartyKind;
  party?: ThirdParty;
  size?: number;
}) {
  const dot = !party
    ? null
    : party.state === "revoked" || party.problem
      ? "bg-danger"
      : party.activity?.working
        ? "bg-working"
        : party.activity
          ? "bg-ok"
          : "bg-dim/50";
  return (
    <span className="relative shrink-0">
      <img
        src={kind.icon}
        alt=""
        width={size}
        height={size}
        className={cn("rounded-md", party?.state === "revoked" && "opacity-50 grayscale")}
      />
      {dot ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-[1.5px] border-panel",
            dot,
          )}
        />
      ) : null}
    </span>
  );
}
