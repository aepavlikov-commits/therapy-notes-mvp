// /api/settings.js
// GET /api/settings -> получить текущие настройки терапевта
// PUT /api/settings -> обновить формат заметки, методы терапии и т.д.

import { sql } from "../lib/db.mjs";
import { getTherapistIdFromRequest } from "../lib/auth.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован. Войдите снова." });
  }

  if (req.method === "GET") {
    const result = await sql`
      SELECT email, name, default_note_format, custom_format_instructions, modalities
      FROM therapists WHERE id = ${therapistId}
    `;
    return res.status(200).json({ settings: result[0] });
  }

  if (req.method === "PUT") {
    const { defaultNoteFormat, customFormatInstructions, name, modalities } = req.body || {};
    try {
      const result = await sql`
        UPDATE therapists
        SET default_note_format = COALESCE(${defaultNoteFormat}, default_note_format),
            custom_format_instructions = COALESCE(${customFormatInstructions}, custom_format_instructions),
            name = COALESCE(${name}, name),
            modalities = COALESCE(${modalities}, modalities)
        WHERE id = ${therapistId}
        RETURNING email, name, default_note_format, custom_format_instructions, modalities
      `;
      return res.status(200).json({ settings: result[0] });
    } catch (err) {
      return res.status(500).json({ error: "Ошибка при сохранении настроек", details: err.message });
    }
  }

  return res.status(405).json({ error: "Метод не поддерживается" });
}
