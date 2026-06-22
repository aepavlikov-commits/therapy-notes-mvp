// api/sessions/recognize.js
//
// Объединённый эндпоинт для всей схемы распознавания речи через Yandex SpeechKit.
// Объединён в один файл (вместо трёх отдельных) из-за лимита Vercel Hobby-плана
// на 12 serverless-функций в одном деплое.
//
// Действие выбирается через параметр action в теле запроса (для POST) или
// в строке запроса (для GET):
//
//   POST  /api/sessions/recognize   { action: "get-upload-url", clientId }
//     → { uploadUrl, objectKey }
//
//   POST  /api/sessions/recognize   { action: "start-recognition", objectKey }
//     → { operationId }
//
//   GET   /api/sessions/recognize?action=status&operationId=...
//     → { done, transcript? , error? }

import { sql } from "../../lib/db.mjs";
import { getTherapistIdFromRequest } from "../../lib/auth.mjs";
import { getSignedAudioUrl, getSignedUploadUrl } from "../../lib/yandex-storage.mjs";
import { startRecognition, checkRecognitionStatus } from "../../lib/yandex-speechkit.mjs";

export default async function handler(req, res) {
  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован" });
  }

  if (req.method === "GET") {
    const { action, operationId } = req.query || {};

    if (action !== "status") {
      return res.status(400).json({ error: "Неизвестное действие для GET-запроса" });
    }
    if (!operationId) {
      return res.status(400).json({ error: "Не передан operationId" });
    }

    try {
      const result = await checkRecognitionStatus(operationId);

      if (!result.done) {
        return res.status(200).json({ done: false });
      }
      if (result.error) {
        return res.status(200).json({ done: true, error: result.error });
      }
      return res.status(200).json({ done: true, transcript: result.transcript });
    } catch (err) {
      console.error("recognize (status): ошибка проверки статуса:", err);
      return res.status(502).json({ error: "Не удалось проверить статус распознавания" });
    }
  }

  if (req.method === "POST") {
    const { action } = req.body || {};

    if (action === "get-upload-url") {
      const { clientId } = req.body || {};

      if (!clientId) {
        return res.status(400).json({ error: "Не передан clientId" });
      }

      const clientRows = await sql`
        SELECT id FROM clients WHERE id = ${clientId} AND therapist_id = ${therapistId}
      `;

      if (clientRows.length === 0) {
        return res.status(404).json({ error: "Клиент не найден" });
      }

      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const objectKey = `sessions/${therapistId}/${timestamp}-${randomSuffix}.wav`;

      try {
        const uploadUrl = await getSignedUploadUrl(objectKey, "audio/wav");
        return res.status(200).json({ uploadUrl, objectKey });
      } catch (err) {
        console.error("recognize (get-upload-url): ошибка создания подписанной ссылки:", err);
        return res.status(500).json({ error: "Не удалось подготовить загрузку файла" });
      }
    }

    if (action === "start-recognition") {
      const { objectKey, sampleRateHertz } = req.body || {};

      if (!objectKey) {
        return res.status(400).json({ error: "Не передан objectKey" });
      }

      const expectedPrefix = `sessions/${therapistId}/`;
      if (!objectKey.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "Доступ к этому файлу запрещён" });
      }

      try {
        const audioUrl = await getSignedAudioUrl(objectKey);
        const operationId = await startRecognition(audioUrl, {
          languageCode: "ru-RU",
          sampleRateHertz: sampleRateHertz || 48000,
        });
        return res.status(200).json({ operationId });
      } catch (err) {
        console.error("recognize (start-recognition): ошибка запуска распознавания:", err);
        return res.status(502).json({ error: "Не удалось запустить распознавание речи" });
      }
    }

    return res.status(400).json({ error: "Неизвестное действие для POST-запроса" });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Метод не поддерживается" });
}
