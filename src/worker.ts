import { handle } from '@astrojs/cloudflare/handler';
import { runDailyPushJob } from './lib/push/cron';

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runDailyPushJob(env));
  },
} satisfies ExportedHandler<Env>;
