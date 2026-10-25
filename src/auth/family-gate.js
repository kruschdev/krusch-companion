import crypto from 'crypto';
import config from '../config.js';

const COOKIE_NAME = 'companion_device_session';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 8;

const failedAttemptsByIp = new Map();

function getSigningSecret() {
  return (
    process.env.COMPANION_AUTH_SECRET ||
    process.env.AP2_SIGNING_SECRET ||
    process.env.GCRUSH_SECRET ||
    'krusch-companion-sovereign-family-gate-secret-2026'
  );
}

function getAllowedEmails() {
  const raw = process.env.ALLOWED_GOOGLE_EMAILS || '';
  return raw
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function safeEqualStrings(a, b) {
  const strA = String(a || '');
  const strB = String(b || '');
  if (!strA || !strB) return false;
  const bufA = Buffer.from(strA, 'utf8');
  const bufB = Buffer.from(strB, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSessionToken({ sub, method = 'passcode' }) {
  const exp = Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      method,
      app: config.app.name,
      exp
    }),
    'utf8'
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');
  if (!safeEqualStrings(sig, expectedSig)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getClientIp(req) {
  return (
    String(req.headers['cf-connecting-ip'] || '').trim() ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = failedAttemptsByIp.get(ip);
  if (!entry) return false;
  if (now - entry.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    failedAttemptsByIp.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = failedAttemptsByIp.get(ip);
  if (!entry || now - entry.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    failedAttemptsByIp.set(ip, { count: 1, firstAttemptAt: now });
  } else {
    entry.count += 1;
  }
}

function clearFailedAttempts(ip) {
  failedAttemptsByIp.delete(ip);
}

function setSessionCookie(res, req, token) {
  const isHttps =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    String(req.headers.host || '').endsWith('.krusch.dev') ||
    String(req.headers.host || '').endsWith('.kruschdev.com');
  const cookieParts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (isHttps) {
    cookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

export function isExternalOrAuthRequiredRequest(req) {
  const authEnabled = String(process.env.COMPANION_AUTH_ENABLED || '').toLowerCase() === 'true';
  const host = String(req.headers.host || '').toLowerCase();
  const isPublicDomain = host.endsWith('.krusch.dev') || host === 'krusch.dev' || host.endsWith('.kruschdev.com');
  const hasCloudflareHeaders = Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);

  if (isPublicDomain || hasCloudflareHeaders) {
    return true;
  }
  if (!authEnabled) {
    return false;
  }
  // Even when COMPANION_AUTH_ENABLED=true, allow direct unproxied 127.0.0.1 loopback for local backup/health scripts
  const remoteAddr = req.socket?.remoteAddress || '';
  const isDirectLoopback =
    (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') &&
    !req.headers['x-forwarded-for'] &&
    !req.headers['cf-connecting-ip'];
  return !isDirectLoopback;
}

export function renderLoginPageHtml({ appName, ownerName, googleClientId, errorMsg = '' }) {
  const safeApp = String(appName || 'Krusch Companion').replace(/[<>&"]/g, '');
  const safeOwner = String(ownerName || '').replace(/[<>&"]/g, '');
  const hasGoogle = Boolean(googleClientId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${safeApp} — Sign In</title>
  ${hasGoogle ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : ''}
  <style>
    :root {
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at top, #172033 0%, #0b0e17 70%);
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 20px;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: rgba(17, 24, 39, 0.92);
      border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 20px;
      padding: 32px 26px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      text-align: center;
    }
    .badge {
      display: inline-block;
      background: rgba(56, 189, 248, 0.14);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      font-size: 13px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 999px;
      margin-bottom: 14px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
      font-weight: 700;
    }
    p.sub {
      margin: 0 0 24px;
      color: #94a3b8;
      font-size: 16px;
      line-height: 1.45;
    }
    .error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.45);
      color: #fca5a5;
      padding: 12px;
      border-radius: 12px;
      margin-bottom: 18px;
      font-size: 15px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    input[type="password"] {
      width: 100%;
      padding: 16px;
      font-size: 20px;
      text-align: center;
      letter-spacing: 3px;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      background: #0f172a;
      color: #f8fafc;
      outline: none;
    }
    input[type="password"]:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
    }
    button.primary {
      width: 100%;
      padding: 16px;
      font-size: 18px;
      font-weight: 700;
      border-radius: 14px;
      border: none;
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: white;
      cursor: pointer;
    }
    button.primary:active {
      transform: scale(0.99);
    }
    .divider {
      margin: 22px 0;
      display: flex;
      align-items: center;
      color: #64748b;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .divider::before, .divider::after {
      content: "";
      flex: 1;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    }
    .divider span {
      padding: 0 10px;
    }
    .google-wrap {
      display: flex;
      justify-content: center;
      margin-top: 6px;
    }
    .note {
      margin-top: 20px;
      font-size: 13px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🔒 Private Family Companion</div>
    <h1>${safeApp}</h1>
    <p class="sub">${safeOwner ? `Welcome back, ${safeOwner}! Enter your family passcode once to keep this device signed in.` : 'Enter your family passcode to unlock this device.'}</p>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
    <form method="POST" action="/api/auth/passcode">
      <input type="password" name="passcode" placeholder="Family Passcode" autocomplete="current-password" required autofocus />
      <button type="submit" class="primary">Unlock &amp; Remember This Device</button>
    </form>
    ${
      hasGoogle
        ? `<div class="divider"><span>Or Sign In With Google</span></div>
    <div class="google-wrap">
      <div id="g_id_onload"
           data-client_id="${googleClientId}"
           data-context="signin"
           data-ux_mode="popup"
           data-callback="onGoogleSignIn"
           data-auto_prompt="false">
      </div>
      <div class="g_id_signin"
           data-type="standard"
           data-shape="pill"
           data-theme="filled_blue"
           data-text="signin_with"
           data-size="large"
           data-logo_alignment="left">
      </div>
    </div>
    <script>
      async function onGoogleSignIn(response) {
        try {
          const res = await fetch('/api/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: response.credential })
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            window.location.href = '/';
          } else {
            alert(data.error || 'Google sign-in not authorized for this Companion.');
          }
        } catch (err) {
          alert('Sign-in error: ' + err.message);
        }
      }
    </script>`
        : ''
    }
    <div class="note">✅ Keeps your phone or computer signed in for 1 year.</div>
  </div>
</body>
</html>`;
}

export function registerFamilyAuthRoutes(app) {
  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
  const ownerName = process.env.COMPANION_OWNER_NAME || '';

  // 1. Magic 1-Tap Device Setup Link: GET /api/auth/magic?token=...
  app.get('/api/auth/magic', (req, res) => {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return res.status(429).send('Too many failed sign-in attempts. Please wait 15 minutes.');
    }
    const provided = String(req.query.token || '').trim();
    const expected = String(process.env.COMPANION_MAGIC_TOKEN || '').trim();
    if (!expected || !safeEqualStrings(provided, expected)) {
      recordFailedAttempt(ip);
      return res
        .status(401)
        .send(
          renderLoginPageHtml({
            appName: config.app.name,
            ownerName,
            googleClientId,
            errorMsg: 'Invalid or expired setup link. Please enter your Family Passcode below.'
          })
        );
    }
    clearFailedAttempts(ip);
    const sessionToken = createSessionToken({ sub: ownerName || 'family_magic_link', method: 'magic_link' });
    setSessionCookie(res, req, sessionToken);
    return res.redirect('/');
  });

  // 2. Family Passcode Login: POST /api/auth/passcode (supports form-urlencoded or JSON)
  app.post('/api/auth/passcode', (req, res) => {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return res.status(429).send('Too many failed sign-in attempts. Please wait 15 minutes.');
    }
    const provided = String(req.body?.passcode || '').trim();
    const expected = String(process.env.COMPANION_PASSCODE || '').trim();
    if (!expected || !safeEqualStrings(provided, expected)) {
      recordFailedAttempt(ip);
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ ok: false, error: 'Incorrect family passcode.' });
      }
      return res
        .status(401)
        .send(
          renderLoginPageHtml({
            appName: config.app.name,
            ownerName,
            googleClientId,
            errorMsg: 'Incorrect passcode. Please try again.'
          })
        );
    }
    clearFailedAttempts(ip);
    const sessionToken = createSessionToken({ sub: ownerName || 'family_passcode', method: 'passcode' });
    setSessionCookie(res, req, sessionToken);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ ok: true, owner: ownerName || 'family' });
    }
    return res.redirect('/');
  });

  // 3. Google OAuth ID Token Login: POST /api/auth/google
  app.post('/api/auth/google', async (req, res) => {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return res.status(429).json({ ok: false, error: 'Too many failed sign-in attempts.' });
    }
    const idToken = String(req.body?.credential || req.body?.idToken || '').trim();
    if (!idToken) {
      return res.status(400).json({ ok: false, error: 'Missing Google credential token.' });
    }
    try {
      const verifyRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!verifyRes.ok) {
        recordFailedAttempt(ip);
        return res.status(401).json({ ok: false, error: 'Google token verification failed.' });
      }
      const tokenInfo = await verifyRes.json();
      const email = String(tokenInfo.email || '').toLowerCase().trim();
      const emailVerified = String(tokenInfo.email_verified) === 'true';
      const allowedEmails = getAllowedEmails();

      if (googleClientId && tokenInfo.aud !== googleClientId) {
        recordFailedAttempt(ip);
        return res.status(401).json({ ok: false, error: 'Google token audience mismatch.' });
      }
      if (!emailVerified || !allowedEmails.includes(email)) {
        recordFailedAttempt(ip);
        return res.status(403).json({
          ok: false,
          error: `Google account (${email || 'unknown'}) is not on the family whitelist for ${config.app.name}.`
        });
      }

      clearFailedAttempts(ip);
      const sessionToken = createSessionToken({ sub: email, method: 'google_oauth' });
      setSessionCookie(res, req, sessionToken);
      return res.json({ ok: true, email });
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Google verification error: ${err.message}` });
    }
  });

  // 4. Logout: GET/POST /api/auth/logout
  const handleLogout = (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.redirect('/');
  };
  app.get('/api/auth/logout', handleLogout);
  app.post('/api/auth/logout', handleLogout);
}

export function familyAuthGateMiddleware(req, res, next) {
  // Always allow auth endpoints and basic health ping
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health') {
    return next();
  }

  // Only enforce gate on public/external requests or when COMPANION_AUTH_ENABLED=true
  if (!isExternalOrAuthRequiredRequest(req)) {
    return next();
  }

  // 1. Check Cloudflare Zero Trust authenticated header if present
  const cfEmail = String(req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (cfEmail && getAllowedEmails().includes(cfEmail)) {
    req.companionUser = { sub: cfEmail, method: 'cloudflare_access' };
    return next();
  }

  // 2. Check signed 365-day HttpOnly cookie
  const cookies = parseCookies(req.headers.cookie);
  const verified = verifySessionToken(cookies[COOKIE_NAME]);
  if (verified) {
    req.companionUser = verified;
    return next();
  }

  // 3. Check Bearer / X-API-Key header for programmatic access
  const apiKey = process.env.COMPANION_API_KEY || process.env.COMPANION_MAGIC_TOKEN;
  if (apiKey) {
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : String(req.headers['x-api-key'] || '').trim();
    if (bearer && safeEqualStrings(bearer, apiKey)) {
      req.companionUser = { sub: 'api_key', method: 'bearer' };
      return next();
    }
  }

  // If this is an API request, return 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      error: 'Authentication required. Please sign in with your Family Passcode or Google account.',
      loginUrl: '/'
    });
  }

  // Otherwise render the Family Login Gate HTML page
  return res.status(200).send(
    renderLoginPageHtml({
      appName: config.app.name,
      ownerName: process.env.COMPANION_OWNER_NAME || '',
      googleClientId: process.env.GOOGLE_CLIENT_ID || ''
    })
  );
}
