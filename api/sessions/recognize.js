// api/sessions/recognize.js
//
// Объединённый эндпоинт для всей схемы распознавания речи через Yandex SpeechKit.
// Объединён в один файл (вместо нескольких отдельных) из-за лимита Vercel
// Hobby-плана на 12 serverless-функций в одном деплое.
//
// Действие выбирается через параметр action в теле запроса (для POST) или
// в строке запроса (для GET):
//
//   --- Старая схема загрузки (один файл целиком, после окончания записи) ---
//   POST  /api/sessions/recognize   { action: "get-upload-url", clientId }
//     → { uploadUrl, objectKey }
//
//   --- Новая схема: multipart upload (потоковая загрузка по ходу записи) ---
//   Записи дольше нескольких минут ОБЯЗАТЕЛЬНО используют эту схему — иначе
//   вся запись копится в памяти браузера и теряется при перезагрузке/OOM.
//
//   POST  /api/sessions/recognize   { action: "start-upload", clientId }
//     → { uploadId, objectKey }
//
//   POST  /api/sessions/recognize   { action: "get-part-url", objectKey, uploadId, partNumber }
//     → { partUrl }
//
//   POST  /api/sessions/recognize   { action: "complete-upload", objectKey, uploadId, parts }
//     parts: [{ partNumber, eTag }, ...]
//     → { objectKey }
//
//   POST  /api/sessions/recognize   { action: "abort-upload", objectKey, uploadId }
//     → { ok: true }
//
//   --- Запуск и проверка распознавания (общие для обеих схем) ---
//   POST  /api/sessions/recognize   { action: "start-recognition", objectKey }
//     → { operationId }
//
//   GET   /api/sessions/recognize?action=status&operationId=...
//     → { done, transcript? , error? }

import { sql } from "../../lib/db.mjs";
import { getTherapistIdFromRequest } from "../../lib/auth.mjs";
import {
  getSignedAudioUrl,
  getSignedUploadUrl,
  createMultipartUpload,
  getSignedPartUploadUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  finalizeWavHeader,
} from "../../lib/yandex-storage.mjs";
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

      // Формируем читаемый транскрипт, подставляя "Терапевт:"/"Клиент:"
      // вместо технических меток. По умолчанию первый говорящий в записи
      // считается терапевтом (он обычно начинает сессию) — это
      // соответствует значению roleMap по умолчанию ниже. Если в запросе
      // передан roleMap (после того как терапевт нажал "Поменять местами"
      // на фронтенде), используем его вместо предположения по умолчанию.
      const utterances = result.utterances || [];
      const uniqueSpeakerTags = [...new Set(utterances.map((u) => u.speakerTag))];

      const transcript = utterances
        .map((u) => {
          const isFirstSpeaker = u.speakerTag === uniqueSpeakerTags[0];
          const roleLabel = isFirstSpeaker ? "Терапевт" : "Клиент";
          return `${roleLabel}: ${u.text}`;
        })
        .join("\n");

      return res.status(200).json({ done: true, transcript, speakerTags: uniqueSpeakerTags });
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

    if (action === "start-upload") {
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
        const uploadId = await createMultipartUpload(objectKey, "audio/wav");
        return res.status(200).json({ uploadId, objectKey });
      } catch (err) {
        console.error("recognize (start-upload): ошибка создания multipart upload:", err);
        return res.status(500).json({ error: "Не удалось начать загрузку записи" });
      }
    }

    if (action === "get-part-url") {
      const { objectKey, uploadId, partNumber } = req.body || {};

      if (!objectKey || !uploadId || !partNumber) {
        return res.status(400).json({ error: "Не переданы objectKey, uploadId или partNumber" });
      }

      const expectedPrefix = `sessions/${therapistId}/`;
      if (!objectKey.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "Доступ к этому файлу запрещён" });
      }

      try {
        const partUrl = await getSignedPartUploadUrl(objectKey, uploadId, partNumber);
        return res.status(200).json({ partUrl });
      } catch (err) {
        console.error("recognize (get-part-url): ошибка создания ссылки на часть:", err);
        return res.status(500).json({ error: "Не удалось подготовить загрузку части записи" });
      }
    }

    if (action === "complete-upload") {
      const { objectKey, uploadId, parts, sampleRateHertz } = req.body || {};

      if (!objectKey || !uploadId || !Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: "Не переданы objectKey, uploadId или parts" });
      }

      const expectedPrefix = `sessions/${therapistId}/`;
      if (!objectKey.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "Доступ к этому файлу запрещён" });
      }

      try {
        await completeMultipartUpload(objectKey, uploadId, parts);
        // Первая часть содержала WAV-заголовок с заведомо неверным размером
        // данных (на момент записи итоговый размер не был известен) — теперь,
        // когда файл целиком собран, перезаписываем заголовок правильным
        // размером, иначе некоторые парсеры WAV могут счесть файл повреждённым.
        await finalizeWavHeader(objectKey, sampleRateHertz || 48000);
        return res.status(200).json({ objectKey });
      } catch (err) {
        console.error("recognize (complete-upload): ошибка завершения загрузки:", err);
        return res.status(500).json({ error: "Не удалось завершить загрузку записи" });
      }
    }

    if (action === "abort-upload") {
      const { objectKey, uploadId } = req.body || {};

      if (!objectKey || !uploadId) {
        return res.status(400).json({ error: "Не переданы objectKey или uploadId" });
      }

      const expectedPrefix = `sessions/${therapistId}/`;
      if (!objectKey.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "Доступ к этому файлу запрещён" });
      }

      await abortMultipartUpload(objectKey, uploadId);
      return res.status(200).json({ ok: true });
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

