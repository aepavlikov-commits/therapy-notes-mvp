// /api/treatment-plans.js
// POST /api/treatment-plans -> создать/обновить план лечения для клиента

import { sql } from "../lib/db.mjs";
import { getTherapistIdFromRequest } from "../lib/auth.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Только POST-запросы поддерживаются" });
  }

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован. Войдите снова." });
  }

  const { clientId, goals, phase, totalSessionsPlanned } = req.body || {};
  if (!clientId) {
    return res.status(400).json({ error: "clientId обязателен" });
  }

  const clientCheck = await sql`
    SELECT id FROM clients WHERE id = ${clientId} AND therapist_id = ${therapistId}
  `;
  if (clientCheck.length === 0) {
    return res.status(404).json({ error: "Клиент не найден" });
  }

  try {
    const result = await sql`
      INSERT INTO treatment_plans (client_id, goals, phase, total_sessions_planned)
      VALUES (${clientId}, ${goals || null}, ${phase || null}, ${totalSessionsPlanned || null})
      RETURNING id, goals, phase, total_sessions_planned, updated_at
    `;
    return res.status(201).json({ treatmentPlan: result[0] });
  } catch (err) {
    return res.status(500).json({ error: "Ошибка при сохранении плана лечения", details: err.message });
  }
}
