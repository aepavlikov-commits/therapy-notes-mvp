// /api/clients/index.js
// GET  /api/clients       -> список клиентов текущего терапевта
// POST /api/clients       -> создать нового клиента

import { sql } from "../../lib/db.mjs";
import { getTherapistIdFromRequest } from "../../lib/auth.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован. Войдите снова." });
  }

  if (req.method === "GET") {
    try {
      const result = await sql`
        SELECT c.id, c.name, c.notes, c.created_at,
               COUNT(s.id) AS session_count,
               MAX(s.session_date) AS last_session_date
        FROM clients c
        LEFT JOIN sessions s ON s.client_id = c.id
        WHERE c.therapist_id = ${therapistId}
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `;
      return res.status(200).json({ clients: result });
    } catch (err) {
      return res.status(500).json({ error: "Ошибка при загрузке клиентов", details: err.message });
    }
  }

  if (req.method === "POST") {
    const { name, notes } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: "Имя клиента обязательно" });
    }
    try {
      const result = await sql`
        INSERT INTO clients (therapist_id, name, notes)
        VALUES (${therapistId}, ${name}, ${notes || null})
        RETURNING id, name, notes, created_at
      `;
      return res.status(201).json({ client: result[0] });
    } catch (err) {
      return res.status(500).json({ error: "Ошибка при создании клиента", details: err.message });
    }
  }

  return res.status(405).json({ error: "Метод не поддерживается" });
}
