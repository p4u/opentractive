// Password login: stateless signed session cookie and an in-memory failure rate limit.
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const hmacHex = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');

export function passwordMatches(input, password) {
  if (typeof input !== 'string' || typeof password !== 'string' || input.length > 1024) return false;
  return crypto.timingSafeEqual(sha256(input), sha256(password));
}

// Bound to the password: changing APP_PASSWORD invalidates every cookie.
export const sessionKey = (secretHex, password) =>
  crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(password).digest();

export const signSession = (key, expiryMs) => `${expiryMs}.${hmacHex(key, String(expiryMs))}`;

export function verifySession(key, value, now) {
  const m = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(value ?? '');
  if (!m) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(hmacHex(key, m[1]), 'hex'));
  const expiry = Number(m[1]);
  return ok && expiry > now ? expiry : null;
}

// Sliding window of failure timestamps, per IP and global (one shared password).
export function createLimiter({ perIp = 5, global = 30, windowMs = 15 * 60e3, now = Date.now } = {}) {
  const byIp = new Map();
  let all = [];
  const live = (list, t) => list.filter((ts) => ts > t - windowMs);
  // seconds until enough failures leave the window to drop below max
  const wait = (list, max, t) => (list.length < max ? 0 : Math.max(1, Math.ceil((list[list.length - max] + windowMs - t) / 1000)));
  return {
    retryAfter(ip) {
      const t = now();
      all = live(all, t);
      return Math.max(wait(live(byIp.get(ip) ?? [], t), perIp, t), wait(all, global, t));
    },
    fail(ip) {
      const t = now();
      for (const [k, list] of byIp) if (list.at(-1) <= t - windowMs) byIp.delete(k); // forget idle IPs
      all.push(t);
      byIp.set(ip, [...live(byIp.get(ip) ?? [], t), t]);
    },
    reset(ip) {
      byIp.delete(ip);
    },
  };
}

// Proxies append the address they saw, so only the last entry is trustworthy.
export function clientIp(req, trustProxy) {
  const xff = trustProxy ? req.headers['x-forwarded-for'] : undefined;
  return xff?.split(',').at(-1).trim() || req.socket.remoteAddress;
}

export const isHttps = (req, trustProxy) =>
  Boolean(req.socket.encrypted) || (Boolean(trustProxy) && req.headers['x-forwarded-proto'] === 'https');

// Lax (not Strict) so a link in a Telegram alert opens the app with the session; CSRF is covered by the
// JSON content type and Origin checks on every mutating request.
export const cookieHeader = (value, { maxAgeS, secure }) =>
  `ot_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
