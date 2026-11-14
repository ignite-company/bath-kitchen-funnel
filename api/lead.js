'use strict';

// Version B routes applications through the same production intake as Version A.
// This keeps Supabase, GoHighLevel, validation, receipts and lead notifications
// consistent even when Vercel preview environment variables are not configured.
const PRODUCTION_INTAKE_URL = 'https://ignite-co-funnel.vercel.app/api/lead';

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return res.status(415).json({ error: 'Use JSON' });
  }
  let serialized;
  try {
    serialized = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (typeof serialized !== 'string') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (Buffer.byteLength(serialized, 'utf8') > 12000) {
    return res.status(413).json({ error: 'Request is too large' });
  }
  try {
    const response = await fetch(PRODUCTION_INTAKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
      signal: AbortSignal.timeout(14500)
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json';
    res.status(response.status).setHeader('Content-Type', contentType);
    return res.send(body);
  } catch (error) {
    console.error('Version B lead intake forwarding failed:', error?.name || 'UnknownError');
    return res.status(503).json({ error: 'Unable to save application right now' });
  }
};
