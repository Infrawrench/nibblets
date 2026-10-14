import { createApp, sweepLinks } from "./app.ts";

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweepLinks(env));
  },
} satisfies ExportedHandler<Env>;
