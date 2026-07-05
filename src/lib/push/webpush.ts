import { sendPushNotification, type PushSubscriptionData } from '@mmmike/web-push';

export function sendReminderPush(subscription: PushSubscriptionData, targetDate: string, env: Env) {
  return sendPushNotification(
    subscription,
    { title: 'Renewal Reminder', body: `Today (${targetDate}) is your reminder date!`, url: '/' },
    {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    },
  );
}
