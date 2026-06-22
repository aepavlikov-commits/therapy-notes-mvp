// lib/yandex-speechkit.mjs
//
// Асинхронное распознавание речи через Yandex SpeechKit API v3
// (stt/v3/recognizeFileAsync). Подходит для длинных аудиозаписей
// (терапевтические сессии 45-60 минут) и поддерживает speakerLabeling —
// автоматическое определение говорящих (терапевт/клиент) даже при записи
// с одного микрофона.
//
// Поток работы:
//   1. Аудиофайл уже загружен в Object Storage (см. lib/yandex-storage.mjs)
//   2. startRecognition() запускает операцию распознавания, передавая
//      SpeechKit подписанную ссылку на файл — возвращает operationId
//   3. checkRecognitionStatus(operationId) опрашивается периодически,
//      пока распознавание не завершится — тогда возвращает готовый текст
//      с метками говорящих (Спикер 1 / Спикер 2)
//
// Переменная окружения (задана на Vercel):
//   YANDEX_SPEECHKIT_API_KEY — API-ключ сервисного аккаунта с ролью ai.speechkit-stt.user
//   YANDEX_FOLDER_ID         — ID каталога Yandex Cloud (нужен для API v3, в отличие от v2)

const SPEECHKIT_OPERATION_BASE_URL = "https://operation.api.cloud.yandex.net/operations";
const SPEECHKIT_RECOGNIZE_URL = "https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync";
const SPEECHKIT_GET_RESULT_URL = "https://stt.api.cloud.yandex.net/stt/v3/getRecognition";

function getApiKey() {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  if (!apiKey) {
    throw new Error("YANDEX_SPEECHKIT_API_KEY не задана в переменных окружения");
  }
  return apiKey;
}

function getFolderId() {
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!folderId) {
    throw new Error("YANDEX_FOLDER_ID не задана в переменных окружения");
  }
  return folderId;
}

/**
 * Запускает асинхронное распознавание речи по ссылке на аудиофайл,
 * с включённым определением говорящих (speakerLabeling).
 *
 * @param {string} audioUrl — подписанная (временная) ссылка на файл в Object Storage
 * @param {object} [options]
 * @param {string} [options.languageCode="ru-RU"] — язык распознавания
 * @returns {Promise<string>} operationId
 */
export async function startRecognition(audioUrl, options = {}) {
  if (!audioUrl) {
    throw new Error("startRecognition: не передана ссылка на аудиофайл (audioUrl)");
  }

  const languageCode = options.languageCode || "ru-RU";
  const apiKey = getApiKey();
  const folderId = getFolderId();

  const response = await fetch(SPEECHKIT_RECOGNIZE_URL, {
    method: "POST",
    headers: {
      Authorization: `Api-key ${apiKey}`,
      "x-folder-id": folderId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      uri: audioUrl,
      recognitionModel: {
        model: "general",
        audioFormat: {
          containerAudio: {
            // Браузер записывает аудио в WAV (LINEAR16_PCM) — см. index.html.
            containerAudioType: "WAV",
          },
        },
        languageRestriction: {
          restrictionType: "WHITELIST",
          languageCode: [languageCode],
        },
      },
      speakerLabeling: {
        speakerLabeling: "SPEAKER_LABELING_ENABLED",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SpeechKit startRecognition: ошибка ${response.status} — ${errorText}`);
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
 * Проверяет статус операции распознавания и, если она завершена,
 * возвращает текст с метками говорящих в формате:
 *   "Говорящий 1: ...\nГоворящий 2: ...\n..."
 *
 * @param {string} operationId
 * @returns {Promise<{done: boolean, transcript: string|null, error: string|null}>}
 */
export async function checkRecognitionStatus(operationId) {
  if (!operationId) {
    throw new Error("checkRecognitionStatus: не передан operationId");
  }

  const apiKey = getApiKey();
  const folderId = getFolderId();
  const headers = {
    Authorization: `Api-key ${apiKey}`,
    "x-folder-id": folderId,
  };

  const opResponse = await fetch(`${SPEECHKIT_OPERATION_BASE_URL}/${operationId}`, {
    method: "GET",
    headers,
  });

  if (!opResponse.ok) {
    const errorText = await opResponse.text();
    throw new Error(`SpeechKit checkRecognitionStatus: ошибка ${opResponse.status} — ${errorText}`);
  }

  const opData = await opResponse.json();

  if (!opData.done) {
    return { done: false, transcript: null, error: null };
  }

  if (opData.error) {
    return {
      done: true,
      transcript: null,
      error: opData.error.message || "Неизвестная ошибка распознавания",
    };
  }

  // Когда операция завершена, результат запрашивается отдельным методом
  const resultResponse = await fetch(
    `${SPEECHKIT_GET_RESULT_URL}?operation_id=${encodeURIComponent(operationId)}`,
    { method: "GET", headers }
  );

  if (!resultResponse.ok) {
    const errorText = await resultResponse.text();
    return { done: true, transcript: null, error: `Не удалось получить результат: ${errorText}` };
  }

  const resultText = await resultResponse.text();
  const diagLines = resultText.split("\n").filter((l) => l.trim());
  const diagSummary = diagLines.map((line) => {
    try {
      const p = JSON.parse(line);
      const r = p.result;
      return {
        finalIndex: r?.audioCursors?.finalIndex,
        hasRefinement: !!r?.finalRefinement,
        hasFinal: !!r?.final,
        channelTag: r?.channelTag,
      };
    } catch (e) {
      return { parseError: true };
    }
  });
  console.log("SpeechKit diag summary:", JSON.stringify(diagSummary));
  const utterances = parseSpeakerLabeledResult(resultText);
  console.log("SpeechKit parsed utterances:", JSON.stringify(utterances));

  return { done: true, utterances, error: null };
}

/**
 * Разбирает текстовый поток ответа getRecognition (формат NDJSON —
 * по одному JSON-объекту на строку).
 *
 * Реальная структура ответа SpeechKit v3: для каждой произнесённой фразы
 * сервис присылает ДВЕ отдельные строки с одинаковым finalIndex:
 *   1. { result: { final: {...}, channelTag } }              — сырой текст
 *   2. { result: { finalRefinement: { normalizedText: {...} } } } — тот же
 *      текст, но с расставленными заглавными буквами/пунктуацией
 * Без дедупликации по finalIndex обе строки попадали бы в транскрипт,
 * вызывая видимое дублирование каждой фразы.
 *
 * Метка говорящего приходит в поле channelTag (несмотря на название —
 * это и есть номер говорящего при включённом speakerLabeling, а не номер
 * физического аудиоканала).
 */
function parseSpeakerLabeledResult(rawText) {
  const lines = rawText.split("\n").filter((line) => line.trim());

  // Собираем по finalIndex лучший доступный вариант текста — отдаём
  // приоритет normalizedText (он приходит позже и содержит ту же фразу
  // с пунктуацией), но если по какой-то причине его не пришло, используем
  // сырой final.
  const byIndex = new Map();

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      continue;
    }

    const result = parsed.result;
    if (!result) continue;

    const finalIndex = result.audioCursors?.finalIndex;
    if (finalIndex === undefined || finalIndex === null) continue;

    if (result.finalRefinement?.normalizedText?.alternatives?.length) {
      const alt = result.finalRefinement.normalizedText.alternatives[0];
      const channelTag = result.channelTag || alt.channelTag || "0";
      byIndex.set(finalIndex, { channelTag, text: alt.text || "" });
    } else if (result.final?.alternatives?.length && !byIndex.has(finalIndex)) {
      // Используем сырой вариант только если нормализованный ещё не пришёл
      // для этого finalIndex (он может прийти в следующей строке потока)
      const alt = result.final.alternatives[0];
      const channelTag = result.channelTag || alt.channelTag || "0";
      byIndex.set(finalIndex, { channelTag, text: alt.text || "" });
    }
  }

  // Сортируем по finalIndex, чтобы сохранить хронологический порядок фраз
  const utterances = [...byIndex.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value)
    .filter((u) => u.text);

  if (utterances.length === 0) {
    return [];
  }

  // Объединяем соседние фразы одного и того же говорящего в один блок
  const grouped = [];
  for (const utterance of utterances) {
    const last = grouped[grouped.length - 1];
    if (last && last.speakerTag === utterance.channelTag) {
      last.text += " " + utterance.text;
    } else {
      grouped.push({ speakerTag: utterance.channelTag, text: utterance.text });
    }
  }

  return grouped;
}
