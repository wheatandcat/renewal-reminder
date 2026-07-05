import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const { results } = await env.DB.prepare(
    `SELECT target_date, sent_at FROM schedules WHERE user_id = ? AND sent_at IS NULL ORDER BY target_date ASC`,
  )
    .bind(locals.userId)
    .all<{ target_date: string; sent_at: string | null }>();

  return new Response(JSON.stringify({ schedules: results }), {
    headers: { 'content-type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const { targetDate } = await request.json<{ targetDate: string }>();
  await env.DB.prepare(
    `DELETE FROM schedules WHERE user_id = ? AND target_date = ? AND sent_at IS NULL`,
  )
    .bind(locals.userId, targetDate)
    .run();
  return new Response(JSON.stringify({ ok: true }));
};
