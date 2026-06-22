// api/sessions/recognition-status.js
//
// Последний шаг в схеме распознавания через Yandex SpeechKit.
//
// Браузер периодически (например, раз в 5-10 секунд) вызывает этот эндпоинт,
// передавая operationId, полученный от /api/sessions/start-recognition,
// и ждёт, пока done не станет true.
//
// Метод: GET
// Заголовки: Authorization: Bearer <JWT терапевта>
// Параметр строки запроса: ?operationId=...
//
// Ответ:
//   { done: false }
//     — распознавание ещё идёт, нужно повторить запрос позже
//   { done: true, transcript: "..." }
//     — распознавание завершилось успешно, текст готов
//   { done: true, error: "..." }
//     — распознавание завершилось с ошибкой (например, файл повреждён,
//       или формат не подошёл)

import { getTherapistIdFromRequest } from "../../lib/auth.mjs";
import { checkRecognitionStatus } from "../../lib/yandex-speechkit.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Метод не поддерживается, используйте GET" });
  }

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован" });
  }

  const { operationId } = req.query || {};

  if (!operationId) {
    return res.status(400).json({ error: "Не передан operationId" });
  }

  let result;
  try {
    result = await checkRecognitionStatus(operationId);
  } catch (err) {
    console.error("recognition-status: ошибка проверки статуса:", err);
    return res.status(502).json({ error: "Не удалось проверить статус распознавания" });
  }

  if (!result.done) {
    return res.status(200).json({ done: false });
  }

  if (result.error) {
    return res.status(200).json({ done: true, error: result.error });
  }

  return res.status(200).json({ done: true, transcript: result.transcript });
}
