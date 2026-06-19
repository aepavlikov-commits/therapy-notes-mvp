// /api/auth/login.js
import { sql } from "../../lib/db.js";
import { verifyPassword, createToken } from "../../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Только POST-запросы поддерживаются" });
  }

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email и пароль обязательны" });
  }

  try {
    const result = await sql`SELECT id, email, name, password_hash FROM therapists WHERE email = ${email}`;
    const therapist = result[0];

    if (!therapist) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const passwordValid = await verifyPassword(password, therapist.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const token = createToken(therapist.id);

    return res.status(200).json({
      token,
      therapist: { id: therapist.id, email: therapist.email, name: therapist.name },
    });
  } catch (err) {
    return res.status(500).json({ error: "Ошибка при входе", details: err.message });
  }
}
