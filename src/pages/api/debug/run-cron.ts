import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { runDailyPushJob } from '../../../lib/push/cron';

export const prerender = false;

export const GET: APIRoute = async () => {
  await runDailyPushJob(env);
  return new Response(JSON.stringify({ ok: true }));
};
