import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ publicKey: env.VAPID_PUBLIC_KEY }), {
    headers: { 'content-type': 'application/json' },
  });
};
