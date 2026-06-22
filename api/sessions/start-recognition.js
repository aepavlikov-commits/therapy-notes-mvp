// api/sessions/start-recognition.js
//
// Шаг 3 из той же схемы (после get-upload-url и прямой загрузки браузером в Storage).
//
// Браузер уже загрузил аудиофайл прямо в Yandex Object Storage по подписанной
// ссылке, полученной от /api/sessions/get-upload-url. Теперь браузер сообщает
// серверу "файл лежит вот под таким именем" — сервер получает временную ссылку
// на скачивание этого файла и передаёт её в Yandex SpeechKit, чтобы запустить
// асинхронное распознавание речи.
//
// Метод: POST
// Заголовки: Authorization: Bearer <JWT терапевта>
// Тело запроса: { objectKey: string }
//   objectKey — имя файла в бакете, которое вернул /api/sessions/get-upload-url
//
// Ответ: { operationId: string }
//   operationId нужно передавать в /api/sessions/recognition-status,
//   чтобы периодически проверять готовность транскрипта

import { getTherapistIdFromRequest } from "../../lib/auth.mjs";
import { getSignedAudioUrl } from "../../lib/yandex-storage.mjs";
import { startRecognition } from "../../lib/yandex-speechkit.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается, используйте POST" });
  }

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован" });
  }

  const { objectKey } = req.body || {};

  if (!objectKey) {
    return res.status(400).json({ error: "Не передан objectKey" });
  }

  // Защита от попытки запустить распознавание чужого файла:
  // имя файла обязательно содержит ID терапевта (см. get-upload-url.js,
  // где objectKey строится как sessions/{therapistId}/...)
  const expectedPrefix = `sessions/${therapistId}/`;
  if (!objectKey.startsWith(expectedPrefix)) {
    return res.status(403).json({ error: "Доступ к этому файлу запрещён" });
  }

  let audioUrl;
  try {
    audioUrl = await getSignedAudioUrl(objectKey);
  } catch (err) {
    console.error("start-recognition: ошибка получения ссылки на файл:", err);
    return res.status(500).json({ error: "Не удалось получить доступ к загруженному файлу" });
  }

  let operationId;
  try {
    operationId = await startRecognition(audioUrl, { languageCode: "ru-RU" });
  } catch (err) {
    console.error("start-recognition: ошибка запуска распознавания SpeechKit:", err);
    return res.status(502).json({ error: "Не удалось запустить распознавание речи" });
  }

  return res.status(200).json({ operationId });
}
