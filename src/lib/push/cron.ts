import { sendReminderPush } from './webpush';

export function todayJst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

interface DueRow {
  schedule_id: number;
  sub_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function runDailyPushJob(env: Env) {
  const date = todayJst();
  const { results } = await env.DB.prepare(
    `SELECT s.id AS schedule_id, sub.id AS sub_id, sub.endpoint, sub.p256dh, sub.auth
     FROM schedules s
     JOIN subscriptions sub ON sub.user_id = s.user_id
     WHERE s.target_date = ? AND s.sent_at IS NULL`,
  )
    .bind(date)
    .all<DueRow>();

  for (const row of results) {
    try {
      const delivered = await sendReminderPush(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        date,
        env,
      );
      if (delivered) {
        await env.DB.prepare('UPDATE schedules SET sent_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), row.schedule_id)
          .run();
      } else {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(row.sub_id),
          env.DB.prepare('UPDATE schedules SET sent_at = ? WHERE id = ?').bind(
            new Date().toISOString(),
            row.schedule_id,
          ),
        ]);
      }
    } catch (err) {
      console.error(`push failed for schedule ${row.schedule_id}`, err);
    }
  }
}
