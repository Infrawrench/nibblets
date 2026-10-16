/**
 * Fixed ports inside each nibblet's container. Kept apart from runner.ts so
 * tailscale.ts can build its list of reserved ports from them without a cycle.
 */

/** Where the guard's gate listens, inside each container. */
export const GATE_PORT = 7810;
/** Where OpenComputerUse's view server listens, for the server to proxy the browser. */
export const VIEW_PORT = 7900;
/** Where OpenComputerUse's MCP endpoint listens, on loopback. */
export const BROWSER_MCP_PORT = 7800;
