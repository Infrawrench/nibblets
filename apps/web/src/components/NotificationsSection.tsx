import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { loadCentralConfig } from "../lib/central.ts";
import { asInput, currentSubscription, pushSupport, subscribe } from "../lib/push.ts";
import { useServers } from "../lib/servers.tsx";
import { Button } from "./ui/Button.tsx";
import { SectionHeading } from "./ui/Field.tsx";

/**
 * Push notifications on this device, for when a nibblet needs you: an
 * approval, an error, or it asking for help. Nibblets Connect sends them,
 * so they reach a phone with the app closed.
 */
export function NotificationsSection() {
  const { central } = useServers();
  const config = useQuery({ queryKey: ["central", "config"], queryFn: loadCentralConfig });
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const support = pushSupport();
  const key = config.data?.vapidPublicKey ?? null;

  useEffect(() => {
    if (support !== "supported" || !central) return;
    void currentSubscription().then((subscription) => {
      setOn(subscription !== null);
      // Re-register what this browser has, in case the service forgot it.
      if (subscription)
        void central.api.subscribePush(asInput(subscription)).catch(() => undefined);
    });
  }, [support, central]);

  if (!central || !key) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      const subscription = await subscribe(key);
      if (!subscription) {
        setMessage(
          Notification.permission === "denied"
            ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."
            : "Notifications weren't turned on.",
        );
        return;
      }
      await central.api.subscribePush(subscription);
      setOn(true);
    });

  const turnOff = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (subscription) {
        await central.api.unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setOn(false);
    });

  const test = () =>
    run(async () => {
      const { sent } = await central.api.testPush();
      setMessage(
        sent > 0
          ? `Sent to ${sent} ${sent === 1 ? "device" : "devices"}.`
          : "No devices to send to.",
      );
    });

  return (
    <>
      <SectionHeading>Notifications</SectionHeading>
      <p className="text-xs text-dim">
        Hear about it on this device when a nibblet needs you: waiting on an approval, stuck on an
        error, or asking for help.
      </p>
      {support === "needs-install" ? (
        <p className="text-xs text-faint">
          On iPhone and iPad, add Nibblets to your Home Screen first (Share, then Add to Home
          Screen), open it from there, and turn notifications on in its Settings.
        </p>
      ) : support === "unsupported" ? (
        <p className="text-xs text-faint">This browser can't show notifications.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {on ? (
            <>
              <span className="mr-1 flex items-center gap-1.5 text-sm text-ok">
                <Bell className="size-3.5" />
                On for this device
              </span>
              <Button size="sm" onClick={() => void test()} disabled={busy}>
                Send a test
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void turnOff()} disabled={busy}>
                <BellOff />
                Turn off
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void turnOn()}
              disabled={busy || on === null}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Bell />}
              Turn on notifications
            </Button>
          )}
        </div>
      )}
      {message ? <p className="text-xs text-dim">{message}</p> : null}
    </>
  );
}
