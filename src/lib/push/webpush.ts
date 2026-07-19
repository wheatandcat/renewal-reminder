import { sendPushNotification, type PushSubscriptionData } from '@mmmike/web-push';

export type ScheduleType = 'prepare' | 'start';

const NOTIFICATION_CONTENT: Record<ScheduleType, { title: string; body: string }> = {
  prepare: {
    title: 'もうすぐ手帳の更新が始まります',
    body: '用意するものをチェックしましょう',
  },
  start: {
    title: '手帳の更新受付が始まりました',
    body: '早めに窓口へ提出しましょう',
  },
};

export function sendReminderPush(subscription: PushSubscriptionData, type: ScheduleType, env: Env) {
  const { title, body } = NOTIFICATION_CONTENT[type];
  return sendPushNotification(
    subscription,
    { title, body, url: '/checklist' },
    {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    },
  );
}
