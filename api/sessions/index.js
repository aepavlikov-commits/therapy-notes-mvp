// api/sessions/index.js
//
// POST /api/sessions — создаёт новую сессию для клиента: генерирует через
// GigaChat обе заметки (для клиента и клиническую) на основе транскрипта,
// сохраняет всё в базу данных и возвращает результат терапевту.
//
// Тело запроса: { clientId, transcript, noteFormat? }
//   clientId    — ID клиента, к которому относится сессия
//   transcript  — текст транскрипта (записанный голосом через SpeechKit
//                 или вставленный вручную)
//   noteFormat  — опционально: SOAP | DAP | BIRP | GIRP | CUSTOM.
//                 Если не передан — используется формат по умолчанию
//                 из настроек терапевта.
//
// Ответ: { clientNote, clinicalNote, shortTranscriptWarning? }

import { sql } from "../../lib/db.mjs";
import { getTherapistIdFromRequest } from "../../lib/auth.mjs";
import { callGigaChat } from "../../lib/gigachat.mjs";
import { buildClientPrompt, buildClinicalPrompt, detectRiskFlag } from "../../lib/prompts.mjs";

const SHORT_TRANSCRIPT_WORD_THRESHOLD = 30;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается, используйте POST" });
  }

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован" });
  }

  const { clientId, transcript, noteFormat } = req.body || {};

  if (!clientId) {
    return res.status(400).json({ error: "Не передан clientId" });
  }
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: "Не передан текст транскрипта" });
  }

  // Проверяем, что клиент принадлежит этому терапевту
  const clientRows = await sql`
    SELECT id FROM clients WHERE id = ${clientId} AND therapist_id = ${therapistId}
  `;
  if (clientRows.length === 0) {
    return res.status(404).json({ error: "Клиент не найден" });
  }

  // Достаём настройки терапевта — формат заметки по умолчанию, свой формат,
  // выбранные терапевтические подходы (модальности)
  const settingsRows = await sql`
    SELECT default_note_format, custom_format_instructions, modalities
    FROM therapists
    WHERE id = ${therapistId}
  `;
  const settings = settingsRows[0] || {};
  const format = noteFormat || settings.default_note_format || "SOAP";
  const customInstructions = settings.custom_format_instructions || "";
  const modalities = settings.modalities || [];

  const trimmedTranscript = transcript.trim();
  const wordCount = trimmedTranscript.split(/\s+/).filter(Boolean).length;
  const shortTranscriptWarning =
    wordCount < SHORT_TRANSCRIPT_WORD_THRESHOLD
      ? `Транскрипт очень короткий (${wordCount} слов) — заметки могут получиться неполными. Проверьте, что запись/текст сохранились полностью.`
      : undefined;

  let clientNote;
  let clinicalNote;

  try {
    const clientPrompt = buildClientPrompt(trimmedTranscript);
    const clinicalPrompt = buildClinicalPrompt(trimmedTranscript, format, customInstructions, modalities);

    // Вызовы к GigaChat идут последовательно (не параллельно) — параллельные
    // запросы упираются в лимит 429 (rate limit) на стороне GigaChat
    clientNote = await callGigaChat(clientPrompt);
    clinicalNote = await callGigaChat(clinicalPrompt);
  } catch (err) {
    console.error("sessions (POST): ошибка генерации заметок через GigaChat:", err);
    return res.status(502).json({ error: "Не удалось сгенерировать заметки", details: err.message });
  }

  const hasRiskFlag = detectRiskFlag(clinicalNote);

  let sessionId;
  try {
    const sessionRows = await sql`
      INSERT INTO sessions (client_id, therapist_id, transcript, status, session_date)
      VALUES (${clientId}, ${therapistId}, ${trimmedTranscript}, 'completed', NOW())
      RETURNING id
    `;
    sessionId = sessionRows[0].id;

    await sql`
      INSERT INTO notes (session_id, client_note, clinical_note, note_format, has_risk_flag)
      VALUES (${sessionId}, ${clientNote}, ${clinicalNote}, ${format}, ${hasRiskFlag})
    `;
  } catch (err) {
    console.error("sessions (POST): ошибка сохранения сессии в БД:", err);
    return res.status(500).json({ error: "Заметки сгенерированы, но не удалось сохранить сессию" });
  }

  return res.status(200).json({
    sessionId,
    clientNote,
    clinicalNote,
    shortTranscriptWarning,
  });
}
