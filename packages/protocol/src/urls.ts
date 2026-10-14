import { z } from "zod";

/**
 * A web address: http or https only. Anything a server sends that the UI
 * might open or link to is one of these, so a javascript: or file: URL never
 * reaches window.open or an href.
 */
export const WebUrl = z.url({ protocol: /^https?$/ });
