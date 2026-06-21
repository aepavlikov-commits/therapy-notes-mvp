// /api/portal/sign-consent.js
// POST /api/portal/sign-consent -> клиент подписывает согласие

import { sql } from "../../lib/db.mjs";
import { buildConsentText } from "../../lib/consentText.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Только POST-запросы поддерживаются" });
  }

  const { token, signedName } = req.body || {};
  if (!token || !signedName) {
    return res.status(400).json({ error: "Токен и ФИО обязательны" });
  }

  try {
    const clientResult = await sql`
      SELECT c.id, t.name AS therapist_name
      FROM clients c
      JOIN therapists t ON t.id = c.therapist_id
      WHERE c.access_token = ${token}
    `;
    const client = clientResult[0];
    if (!client) {
      return res.status(404).json({ error: "Ссылка недействительна" });
    }

    const existing = await sql`SELECT id FROM client_consents WHERE client_id = ${client.id}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: "Согласие уже подписано" });
    }

    const consentText = buildConsentText(client.therapist_name);
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null;

    await sql`
      INSERT INTO client_consents (client_id, consent_text, signed_name, ip_address)
      VALUES (${client.id}, ${consentText}, ${signedName}, ${ip})
    `;

    return res.status(201).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Ошибка при подписании согласия", details: err.message });
  }
}
