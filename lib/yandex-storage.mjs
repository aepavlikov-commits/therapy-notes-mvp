// lib/yandex-speechkit.mjs
//
// Асинхронное распознавание речи через Yandex SpeechKit (longRunningRecognize).
// Подходит для длинных аудиозаписей (терапевтические сессии 45-60 минут),
// в отличие от синхронного stt:recognize, который ограничен короткими файлами.
//
// Поток работы:
//   1. Аудиофайл уже загружен в Object Storage (см. lib/yandex-storage.mjs)
//   2. startRecognition() запускает операцию распознавания, передавая
//      SpeechKit подписанную ссылку на файл — возвращает operationId
//   3. checkRecognitionStatus(operationId) опрашивается периодически,
//      пока распознавание не завершится — тогда возвращает готовый текст
//
// Переменная окружения (задана на Vercel):
//   YANDEX_SPEECHKIT_API_KEY — API-ключ сервисного аккаунта с ролью ai.speechkit-stt.user

const SPEECHKIT_OPERATION_BASE_URL = "https://operation.api.cloud.yandex.net/operations";
const SPEECHKIT_RECOGNIZE_URL =
  "https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize";

function getApiKey() {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  if (!apiKey) {
    throw new Error("YANDEX_SPEECHKIT_API_KEY не задана в переменных окружения");
  }
  return apiKey;
}

/**
 * Запускает асинхронное распознавание речи по ссылке на аудиофайл.
 *
 * @param {string} audioUrl — подписанная (временная) ссылка на файл в Object Storage,
 *   полученная через getSignedAudioUrl() из lib/yandex-storage.mjs
 * @param {object} [options]
 * @param {string} [options.languageCode="ru-RU"] — язык распознавания
 * @returns {Promise<string>} operationId — идентификатор операции,
 *   по которому потом проверяется статус через checkRecognitionStatus()
 */
export async function startRecognition(audioUrl, options = {}) {
  if (!audioUrl) {
    throw new Error("startRecognition: не передана ссылка на аудиофайл (audioUrl)");
  }

  const languageCode = options.languageCode || "ru-RU";
  const apiKey = getApiKey();

  const response = await fetch(SPEECHKIT_RECOGNIZE_URL, {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      config: {
        specification: {
          languageCode,
          // audioEncoding не указываем явно — SpeechKit определяет формат
          // автоматически для большинства случаев (OGG_OPUS, MP3, WAV и т.п.)
          // Если браузер записывает webm/opus, явное указание ниже надёжнее:
          audioEncoding: "OGG_OPUS",
          sampleRateHertz: 48000,
          // Включаем автоматическую расстановку пунктуации — это упрощает
          // дальнейшую обработку транскрипта в GigaChat
          literatureText: true,
        },
      },
      audio: {
        uri: audioUrl,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `SpeechKit startRecognition: ошибка ${response.status} — ${errorText}`
    );
  }

  const data = await response.json();

  if (!data.id) {
    throw new Error(
      `SpeechKit startRecognition: в ответе не найден id операции — ${JSON.stringify(data)}`
    );
  }

  return data.id;
}

/**
 * Проверяет статус операции распознавания.
 *
 * @param {string} operationId — идентификатор, полученный от startRecognition()
 * @returns {Promise<{done: boolean, transcript: string|null, error: string|null}>}
 *   done=false — распознавание ещё идёт, нужно повторить проверку позже
 *   done=true, transcript содержит текст — распознавание завершилось успешно
 *   done=true, error содержит сообщение — распознавание завершилось с ошибкой
 */
export async function checkRecognitionStatus(operationId) {
  if (!operationId) {
    throw new Error("checkRecognitionStatus: не передан operationId");
  }

  const apiKey = getApiKey();

  const response = await fetch(`${SPEECHKIT_OPERATION_BASE_URL}/${operationId}`, {
    method: "GET",
    headers: {
      Authorization: `Api-Key ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `SpeechKit checkRecognitionStatus: ошибка ${response.status} — ${errorText}`
    );
  }

  const data = await response.json();

  if (!data.done) {
    return { done: false, transcript: null, error: null };
  }

  if (data.error) {
    return {
      done: true,
      transcript: null,
      error: data.error.message || "Неизвестная ошибка распознавания",
    };
  }

  // Успешный результат: response.chunks — массив фрагментов с альтернативами.
  // Берём первую (наиболее вероятную) альтернативу каждого фрагмента и склеиваем.
  const chunks = data.response?.chunks || [];

  const transcript = chunks
    .map((chunk) => {
      const bestAlternative = chunk.alternatives?.[0];
      return bestAlternative?.text || "";
    })
    .filter(Boolean)
    .join(" ");

  return { done: true, transcript, error: null };
}
