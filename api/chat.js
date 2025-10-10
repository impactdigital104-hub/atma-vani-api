export const config = { runtime: 'edge' };

export default async function handler(req) {
  return new Response('Hello from Atma Vani API!', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
