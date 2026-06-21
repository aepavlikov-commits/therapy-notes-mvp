// /api/portal/[token].js
// GET /api/portal/:token -> данные для личного кабинета клиента:
//   если согласие не подписано — только текст согласия для подписания;
//   если подписано — история памяток (без клинической части).

import { sql } from "../../lib/db.mjs";
import { buildConsentText } from "../../lib/consentText.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Только GET-запросы поддерживаются" });
  }

  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: "Токен доступа обязателен" });
  }

  try {
    const clientResult = await sql`
      SELECT c.id, c.name, t.name AS therapist_name
      FROM clients c
      JOIN therapists t ON t.id = c.therapist_id
      WHERE c.access_token = ${token}
    `;
    const client = clientResult[0];
    if (!client) {
      return res.status(404).json({ error: "Ссылка недействительна. Обратитесь к своему терапевту за новой ссылкой." });
    }

    const consentResult = await sql`
      SELECT signed_at FROM client_consents WHERE client_id = ${client.id} ORDER BY signed_at DESC LIMIT 1
    `;
    const consent = consentResult[0] || null;

    if (!consent) {
      return res.status(200).json({
        clientName: client.name,
        consentSigned: false,
        consentText: buildConsentText(client.therapist_name),
      });
    }

    const sessionsResult = await sql`
      SELECT s.id, s.session_date, n.client_note
      FROM sessions s
      JOIN notes n ON n.session_id = s.id
      WHERE s.client_id = ${client.id} AND s.status = 'done'
      ORDER BY s.session_date DESC
    `;

    return res.status(200).json({
      clientName: client.name,
      consentSigned: true,
      signedAt: consent.signed_at,
      sessions: sessionsResult,
    });
  } catch (err) {
    return res.status(500).json({ error: "Ошибка при загрузке данных", details: err.message });
  }
}
