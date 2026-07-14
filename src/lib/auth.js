// Password hashing (PBKDF2) and session tokens (HMAC), both via the Workers-native
// crypto.subtle - no external auth library needed.

import { getUsers } from "./storage.js";

const PBKDF2_ITERATIONS = 100000;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function derivePasswordHash(password, saltHex) {
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

// Returns { salt, hash } to store alongside the user record.
export async function createPasswordRecord(password) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const hash = await derivePasswordHash(password, salt);
  return { salt, hash };
}

export async function verifyPassword(password, salt, expectedHash) {
  const hash = await derivePasswordHash(password, salt);
  return timingSafeEqual(hash, expectedHash);
}

// ---- Session tokens: base64url(userId).base64url(issuedAtMs).hex(HMAC-SHA256) ----
function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return atob(padded);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSessionToken(userId, secret) {
  const payload = `${b64url(userId)}.${b64url(Date.now().toString())}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${toHex(sig)}`;
}

// Verifies signature + expiry, returns the userId or null.
export async function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdPart, issuedAtPart, sigHex] = parts;
  const payload = `${userIdPart}.${issuedAtPart}`;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, fromHex(sigHex), new TextEncoder().encode(payload));
    if (!valid) return null;
    const issuedAt = Number(b64urlDecode(issuedAtPart));
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null;
    return b64urlDecode(userIdPart);
  } catch (e) {
    return null; // malformed token (bad base64/hex) - treat like any other invalid token
  }
}

// Resolves a request to { userId, username, role } via its session token, or null.
export async function requireAuth(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = request.headers.get("x-session-token");
  const userId = await verifySessionToken(token, env.SESSION_SECRET);
  if (!userId) return null;
  const users = await getUsers(env.DATA_BUCKET);
  const user = users.find((u) => u.id === userId);
  if (!user) return null;
  return { userId: user.id, username: user.username, role: user.role };
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
