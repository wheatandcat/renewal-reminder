import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { runDailyPushJob } from '../../../lib/push/cron';

export const prerender = false;

export const GET: APIRoute = async () => {
  // 認証なしで日次pushを全ユーザーへ即送信できてしまうため、ローカル開発時のみ有効にする
  if (!import.meta.env.DEV) return new Response('Not Found', { status: 404 });
  await runDailyPushJob(env);
  return new Response(JSON.stringify({ ok: true }));
};
