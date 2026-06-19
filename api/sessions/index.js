// /api/sessions/index.js
// POST /api/sessions -> создать сессию для клиента: сгенерировать заметки и сохранить

import { sql } from "../../lib/db.js";
import { getTherapistIdFromRequest } from "../../lib/auth.js";
import { callGigaChat } from "../../lib/gigachat.js";
import { buildClinicalPrompt, buildClientPrompt, detectRiskFlag } from "../../lib/prompts.js";

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

  const { clientId, transcript, noteFormat } = req.body || {};

  if (!clientId || !transcript) {
    return res.status(400).json({ error: "clientId и transcript обязательны" });
  }

  const clientCheck = await sql`
    SELECT id FROM clients WHERE id = ${clientId} AND therapist_id = ${therapistId}
  `;
  if (clientCheck.rows.length === 0) {
    return res.status(404).json({ error: "Клиент не найден" });
  }

  let format = noteFormat;
  let customInstructions = null;
  if (!format) {
    const therapistResult = await sql`
      SELECT default_note_format, custom_format_instructions FROM therapists WHERE id = ${therapistId}
    `;
    format = therapistResult.rows[0]?.default_note_format || "SOAP";
    customInstructions = therapistResult.rows[0]?.custom_format_instructions || null;
  }

  const sessionResult = await sql`
    INSERT INTO sessions (client_id, therapist_id, transcript, status)
    VALUES (${clientId}, ${therapistId}, ${transcript}, 'processing')
    RETURNING id, session_date
  `;
  const session = sessionResult.rows[0];

  try {
    const clientNote = await callGigaChat(buildClientPrompt(transcript));
    const clinicalNote = await callGigaChat(buildClinicalPrompt(transcript, format, customInstructions));
    const hasRisk = detectRiskFlag(clinicalNote);

    await sql`
      INSERT INTO notes (session_id, client_note, clinical_note, note_format, has_risk_flag)
      VALUES (${session.id}, ${clientNote}, ${clinicalNote}, ${format}, ${hasRisk})
    `;

    await sql`UPDATE sessions SET status = 'done' WHERE id = ${session.id}`;

    return res.status(201).json({
      sessionId: session.id,
      sessionDate: session.session_date,
      clientNote,
      clinicalNote,
      noteFormat: format,
      hasRiskFlag: hasRisk,
    });
  } catch (err) {
    await sql`UPDATE sessions SET status = 'error' WHERE id = ${session.id}`;
    return res.status(500).json({ error: "Ошибка при генерации заметок", details: err.message });
  }
}
