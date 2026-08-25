import { WebPushError } from '@mmmike/web-push';
import { sendReminderPush, type ScheduleType } from './webpush';

const RETRY_WINDOW_DAYS = 7;

function jstDate(daysAgo = 0): string {
  return new Date(Date.now() + (9 - daysAgo * 24) * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function todayJst(): string {
  return jstDate();
}

// 鍵や購読の不備(408/429以外の4xx)は翌日も失敗する
function isPermanentError(err: unknown): boolean {
  return (
    err instanceof WebPushError &&
    err.statusCode >= 400 &&
    err.statusCode < 500 &&
    ![408, 429].includes(err.statusCode)
  );
}

interface DueRow {
  schedule_id: number;
  sub_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  type: ScheduleType;
}

export async function runDailyPushJob(env: Env) {
  // 送れなかった予約を翌日以降の実行で拾う。時期を過ぎた通知まで送らないよう7日で打ち切る
  const { results } = await env.DB.prepare(
    `SELECT s.id AS schedule_id, sub.id AS sub_id, sub.endpoint, sub.p256dh, sub.auth, s.type AS type
     FROM schedules s
     JOIN subscriptions sub ON sub.user_id = s.user_id
     WHERE s.target_date BETWEEN ? AND ? AND s.sent_at IS NULL`,
  )
    .bind(jstDate(RETRY_WINDOW_DAYS), todayJst())
    .all<DueRow>();

  for (const row of results) {
    const markSent = env.DB.prepare('UPDATE schedules SET sent_at = ? WHERE id = ?').bind(
      new Date().toISOString(),
      row.schedule_id,
    );
    try {
      const delivered = await sendReminderPush(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        row.type,
        env,
      );
      if (delivered) {
        await markSent.run();
      } else {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(row.sub_id),
          markSent,
        ]);
      }
    } catch (err) {
      // endpointはcapability URLなので err をそのまま出さず toJSON() で切り詰める
      const detail = err instanceof WebPushError ? JSON.stringify(err.toJSON()) : String(err);
      console.error(`push failed for schedule ${row.schedule_id}: ${detail}`);
      if (isPermanentError(err)) await markSent.run();
    }
  }
}
