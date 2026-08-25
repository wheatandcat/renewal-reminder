import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { todayJst } from '../../lib/push/cron';

export const prerender = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SCHEDULE_TYPES = ['prepare', 'start'] as const;
type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.json<{
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    targetDate: string;
    type: ScheduleType;
  }>();
  const { subscription, targetDate, type } = body;

  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return new Response(JSON.stringify({ error: 'invalid subscription' }), { status: 400 });
  }
  if (!DATE_RE.test(targetDate) || targetDate < todayJst()) {
    return new Response(JSON.stringify({ error: 'invalid targetDate' }), { status: 400 });
  }
  if (!SCHEDULE_TYPES.includes(type)) {
    return new Response(JSON.stringify({ error: 'invalid type' }), { status: 400 });
  }

  const userId = locals.userId;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions (user_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`,
    ).bind(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth),
    env.DB.prepare(
      `INSERT INTO schedules (user_id, target_date, type)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, target_date) DO UPDATE SET type = excluded.type`,
    ).bind(userId, targetDate, type),
  ]);

  return new Response(JSON.stringify({ ok: true }));
};

export const DELETE: APIRoute = async ({ locals }) => {
  const userId = locals.userId;

  // user_id はブラウザ単位なので endpoint が変わって残った古い行も消す。
  // 片方だけ残ると cron のJOINが空振りし、送信済みにならない予約が残り続ける
  await env.DB.batch([
    env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM schedules WHERE user_id = ? AND sent_at IS NULL').bind(userId),
  ]);

  return new Response(JSON.stringify({ ok: true }));
};
