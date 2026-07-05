import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { todayJst } from '../../lib/push/cron';

export const prerender = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.json<{
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    targetDate: string;
  }>();
  const { subscription, targetDate } = body;

  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return new Response(JSON.stringify({ error: 'invalid subscription' }), { status: 400 });
  }
  if (!DATE_RE.test(targetDate) || targetDate < todayJst()) {
    return new Response(JSON.stringify({ error: 'invalid targetDate' }), { status: 400 });
  }

  const userId = locals.userId;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions (user_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`,
    ).bind(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth),
    env.DB.prepare(
      `INSERT INTO schedules (user_id, target_date)
       VALUES (?, ?)
       ON CONFLICT(user_id, target_date) DO NOTHING`,
    ).bind(userId, targetDate),
  ]);

  return new Response(JSON.stringify({ ok: true }));
};

export const DELETE: APIRoute = async ({ request }) => {
  const { endpoint } = await request.json<{ endpoint: string }>();
  await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(endpoint).run();
  return new Response(JSON.stringify({ ok: true }));
};
