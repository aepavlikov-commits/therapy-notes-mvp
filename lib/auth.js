// /lib/auth.js
// Простая авторизация на JWT-токенах.
// JWT_SECRET — секретная строка для подписи токенов, задаётся как переменная
// окружения на Vercel (см. README), никогда не пишется в коде напрямую.

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const JWT_SECRET = process.env.JWT_SECRET;

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function createToken(therapistId) {
  return jwt.sign({ therapistId }, JWT_SECRET, { expiresIn: "30d" });
}

// Извлекает и проверяет токен из заголовка Authorization: Bearer <token>.
// Возвращает therapistId, либо null если токен невалиден/отсутствует.
export function getTherapistIdFromRequest(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.therapistId;
  } catch (e) {
    return null;
  }
}
