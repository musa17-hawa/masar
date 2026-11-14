// Accounts and sessions. Passwords are hashed with scrypt; session tokens are random,
// stored only as SHA-256 hashes, and sent as HttpOnly cookies.
import crypto from 'node:crypto';
import { db } from './db.js';

const COOKIE = 'masar_sid';
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function publicUser(u) {
  return u && { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'password_short';
  if (password.length > 200) return 'password_long';
  return null;
}

export function createUser({ name, email, password, role = 'member' }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('email_invalid'), { status: 400 });
  const bad = validatePassword(password);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  if (db.users.some((u) => u.email === email)) throw Object.assign(new Error('email_taken'), { status: 409 });
  const user = { id: db.id(), name: name || email.split('@')[0], email, role: role === 'admin' ? 'admin' : 'member',
    password: hashPassword(password), createdAt: new Date().toISOString() };
  db.users.push(user);
  db.save();
  return user;
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted === true;
}

export function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.sessions = db.sessions.filter((s) => s.expires > Date.now());
  db.sessions.push({ hash: sha(token), userId: user.id, expires });
  db.save();
  setCookie(req, res, token, SESSION_DAYS * 86400);
}

function setCookie(req, res, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function endSession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) { db.sessions = db.sessions.filter((s) => s.hash !== sha(token)); db.save(); }
  setCookie(req, res, '', 0);
}

export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const session = db.sessions.find((s) => s.hash === sha(token));
  if (!session || session.expires < Date.now()) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}

export function dropSessionsFor(userId) {
  db.sessions = db.sessions.filter((s) => s.userId !== userId);
  db.save();
}

// Simple in-memory limiter: slows down password guessing.
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return b.count <= max;
}

export function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
}
