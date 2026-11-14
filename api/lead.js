'use strict';

// Control variant: forward lead intake to the existing Ignite production
// intake so split-test visitors reach the same Supabase and GHL integrations.
const UPSTREAM = 'https://ignite-co-funnel.vercel.app/api/lead';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return res.status(415).json({ error: 'Use JSON' });
  }
  try {
    const serialized = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > 12000) {
      return res.status(413).json({ error: 'Request is too large' });
    }
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
      signal: AbortSignal.timeout(20000),
    });
    const payload = await upstream.text();
    return res.status(upstream.status).setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json').send(payload);
  } catch (error) {
    console.error('Control funnel intake proxy failed:', error?.name || 'UnknownError');
    return res.status(503).json({ error: 'Unable to save application right now' });
  }
};
