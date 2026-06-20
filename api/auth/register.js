// /api/auth/register.js
import { sql } from "../../lib/db.mjs";
import { hashPassword, createToken } from "../../lib/auth.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Только POST-запросы поддерживаются" });
  }

  const { email, password, name } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email и пароль обязательны" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
  }

  try {
    const existing = await sql`SELECT id FROM therapists WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: "Этот email уже зарегистрирован" });
    }

    const passwordHash = await hashPassword(password);
    const result = await sql`
      INSERT INTO therapists (email, password_hash, name)
      VALUES (${email}, ${passwordHash}, ${name || null})
      RETURNING id, email, name
    `;

    const therapist = result[0];
    const token = createToken(therapist.id);

    return res.status(201).json({ token, therapist });
  } catch (err) {
    return res.status(500).json({ error: "Ошибка при регистрации", details: err.message });
  }
}
