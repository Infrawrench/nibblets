import { createApp, sweepLinks } from "./app.ts";
import { sweepThirdPartySignIns } from "./third-parties.ts";

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweepLinks(env));
    ctx.waitUntil(sweepThirdPartySignIns(env));
  },
} satisfies ExportedHandler<Env>;
