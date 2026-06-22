// api/sessions/get-upload-url.js
//
// Шаг 1 из 3 в новой схеме распознавания речи через Yandex SpeechKit.
//
// Терапевт перед началом записи аудио вызывает этот эндпоинт.
// Сервер генерирует уникальное имя файла и временную (подписанную) ссылку,
// по которой браузер сможет САМ загрузить аудиофайл прямо в Yandex Object Storage,
// минуя наш backend — это нужно, чтобы не упереться в лимит размера запроса
// на Vercel (около 4.5 МБ), который не подходит для часовых аудиозаписей.
//
// Метод: POST
// Заголовки: Authorization: Bearer <JWT терапевта>
// Тело запроса: { clientId: string }  — на какого клиента записывается сессия
//   (clientId сейчас используется только для проверки, что клиент принадлежит
//   этому терапевту — для самой загрузки файла он не обязателен)
//
// Ответ: { uploadUrl: string, objectKey: string }
//   uploadUrl — временная ссылка, на которую браузер должен сделать PUT-запрос
//               с аудиофайлом в теле
//   objectKey — уникальное имя файла в бакете; его нужно передать дальше
//               в /api/sessions/start-recognition при запуске распознавания

import { sql } from "../../lib/db.mjs";
import { getTherapistIdFromRequest } from "../../lib/auth.mjs";
import { getSignedUploadUrl } from "../../lib/yandex-storage.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается, используйте POST" });
  }

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован" });
  }

  const { clientId } = req.body || {};

  if (!clientId) {
    return res.status(400).json({ error: "Не передан clientId" });
  }

  // Проверяем, что клиент действительно принадлежит этому терапевту —
  // защита от попытки записать аудио на чужого клиента
  const clientRows = await sql`
    SELECT id FROM clients WHERE id = ${clientId} AND therapist_id = ${therapistId}
  `;

  if (clientRows.length === 0) {
    return res.status(404).json({ error: "Клиент не найден" });
  }

  // Генерируем уникальное имя файла: sessions/{therapistId}/{timestamp}-{random}.webm
  // Структура папок помогает потом ориентироваться в бакете при необходимости
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const objectKey = `sessions/${therapistId}/${timestamp}-${randomSuffix}.webm`;

  let uploadUrl;
  try {
    uploadUrl = await getSignedUploadUrl(objectKey, "audio/webm");
  } catch (err) {
    console.error("get-upload-url: ошибка создания подписанной ссылки:", err);
    return res.status(500).json({ error: "Не удалось подготовить загрузку файла" });
  }

  return res.status(200).json({ uploadUrl, objectKey });
}
