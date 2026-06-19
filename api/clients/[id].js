// /api/clients/[id].js
// GET /api/clients/:id -> карточка клиента: данные, история сессий с заметками, план лечения
// PUT /api/clients/:id -> обновить данные клиента (имя, заметки)

import { sql } from "../../lib/db.js";
import { getTherapistIdFromRequest } from "../../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован. Войдите снова." });
  }

  const { id } = req.query;

  const clientCheck = await sql`
    SELECT id, name, notes, created_at FROM clients
    WHERE id = ${id} AND therapist_id = ${therapistId}
  `;
  const client = clientCheck[0];
  if (!client) {
    return res.status(404).json({ error: "Клиент не найден" });
  }

  if (req.method === "GET") {
    try {
      const sessions = await sql`
        SELECT s.id, s.session_date, s.status,
               n.client_note, n.clinical_note, n.note_format, n.has_risk_flag
        FROM sessions s
        LEFT JOIN notes n ON n.session_id = s.id
        WHERE s.client_id = ${id}
        ORDER BY s.session_date DESC
      `;

      const plan = await sql`
        SELECT goals, phase, total_sessions_planned, updated_at
        FROM treatment_plans
        WHERE client_id = ${id}
        ORDER BY updated_at DESC
        LIMIT 1
      `;

      return res.status(200).json({
        client,
        sessions: sessions,
        treatmentPlan: plan[0] || null,
      });
    } catch (err) {
      return res.status(500).json({ error: "Ошибка при загрузке карточки клиента", details: err.message });
    }
  }

  if (req.method === "PUT") {
    const { name, notes } = req.body || {};
    try {
      const result = await sql`
        UPDATE clients
        SET name = COALESCE(${name}, name), notes = COALESCE(${notes}, notes)
        WHERE id = ${id} AND therapist_id = ${therapistId}
        RETURNING id, name, notes
      `;
      return res.status(200).json({ client: result[0] });
    } catch (err) {
      return res.status(500).json({ error: "Ошибка при обновлении клиента", details: err.message });
    }
  }

  return res.status(405).json({ error: "Метод не поддерживается" });
}
