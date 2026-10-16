import { z } from "zod";

/**
 * Borrowing a nibblet's browser profile onto the host for a quick sign-in.
 * The nibblet is stopped (so its Chromium releases the profile and nothing
 * browses twice at once), the profile is opened in a Chrome window on the
 * host, and when that window closes the profile — with every extension
 * purged — is handed back and the nibblet started again.
 */
export const BrowserBorrowState = z.enum([
  /** Stopping the nibblet and copying its profile out. */
  "preparing",
  /** Open in a Chrome window on the host; waiting for it to close. */
  "local",
  /** The window closed: purging extensions, copying the profile back, starting the nibblet. */
  "handback",
]);
export type BrowserBorrowState = z.infer<typeof BrowserBorrowState>;

export const BrowserBorrow = z.object({
  nibbletId: z.string(),
  state: BrowserBorrowState,
  /** A short line for the UI, e.g. why it couldn't start. */
  detail: z.string().nullable(),
  /** The host loopback port the local window proxies through, once it's up. */
  proxyPort: z.number().int().nullable(),
  /** Whether the host's 1Password was added to the local window. */
  onePassword: z.boolean(),
  /** When the borrow began, epoch ms. */
  startedAt: z.number().int().nullable(),
});
export type BrowserBorrow = z.infer<typeof BrowserBorrow>;
