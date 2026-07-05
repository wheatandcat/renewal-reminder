import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware((context, next) => {
  let userId = context.cookies.get('anon_id')?.value;
  if (!userId) {
    userId = crypto.randomUUID();
    context.cookies.set('anon_id', userId, {
      path: '/',
      httpOnly: true,
      secure: context.url.protocol === 'https:',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  context.locals.userId = userId;
  return next();
});
