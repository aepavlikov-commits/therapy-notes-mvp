// lib/yandex-storage.mjs
//
// Загрузка и получение аудиофайлов из Yandex Object Storage.
// Object Storage у Yandex Cloud S3-совместим, поэтому используем @aws-sdk/client-s3
// с endpoint, указывающим на storage.yandexcloud.net.
//
// Переменные окружения (заданы на Vercel):
//   YANDEX_STORAGE_ACCESS_KEY_ID  — Access Key ID статического ключа сервисного аккаунта
//   YANDEX_STORAGE_SECRET_KEY     — Secret Key того же статического ключа
//   YANDEX_STORAGE_BUCKET         — имя бакета (например, therapy-notes-mvp-audio-9084)

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from "@aws-sdk/client-s3";

const YANDEX_STORAGE_ENDPOINT = "https://storage.yandexcloud.net";
const YANDEX_STORAGE_REGION = "ru-central1"; // регион Yandex Cloud, требуется SDK, реального значения не имеет

function getBucketName() {
  const bucket = process.env.YANDEX_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error("YANDEX_STORAGE_BUCKET не задана в переменных окружения");
  }
  return bucket;
}

function getClient() {
  const accessKeyId = process.env.YANDEX_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.YANDEX_STORAGE_SECRET_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "YANDEX_STORAGE_ACCESS_KEY_ID / YANDEX_STORAGE_SECRET_KEY не заданы в переменных окружения"
    );
  }

  return new S3Client({
    region: YANDEX_STORAGE_REGION,
    endpoint: YANDEX_STORAGE_ENDPOINT,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    // Yandex Object Storage ожидает "path-style" адресацию объектов
    forcePathStyle: true,
  });
}

/**
 * Загружает аудиофайл в Object Storage напрямую с backend (Buffer в памяти).
 * Используется только для случаев, когда файл уже есть на сервере —
 * для загрузки прямо из браузера используется getSignedUploadUrl() ниже.
 *
 * @param {Buffer|Uint8Array} fileBuffer — содержимое аудиофайла
 * @param {string} objectKey — путь/имя объекта в бакете, например "sessions/{therapistId}/{file}.webm"
 * @param {string} contentType — MIME-тип файла, например "audio/webm"
 * @returns {Promise<string>} objectKey — тот же ключ, который передали (для удобства использования дальше)
 */
export async function uploadAudioFile(fileBuffer, objectKey, contentType = "audio/webm") {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error("uploadAudioFile: пустой файл, нечего загружать");
  }
  if (!objectKey) {
    throw new Error("uploadAudioFile: не передан objectKey (путь к файлу в бакете)");
  }

  const client = getClient();
  const bucket = getBucketName();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fileBuffer,
      ContentType: contentType,
    })
  );

  return objectKey;
}

/**
 * Перезаписывает 44-байтный WAV-заголовок итогового файла на ПРАВИЛЬНЫЙ
 * размер данных, который стал известен только после того, как вся запись
 * была загружена (по частям, во время записи, когда итоговый размер ещё
 * не был известен).
 *
 * Зачем это нужно: при чанкованной записи первая часть (отправленная в
 * самом начале записи) содержит WAV-заголовок с заведомо неверным размером
 * data-чанка (он не может быть известен заранее). Многие парсеры WAV,
 * включая некоторые проверки на сервере распознавания, считают файл с
 * неверным заявленным размером повреждённым. Чтобы не рисковать, после
 * complete-upload мы:
 *   1. Узнаём реальный итоговый размер файла (HeadObject)
 *   2. Строим корректный 44-байтный заголовок с правильным размером
 *   3. Запускаем НОВЫЙ multipart upload на тот же objectKey:
 *      часть 1 — новый заголовок (обычный PutObject части, маленький),
 *      часть 2 — UploadPartCopy всего "тела" старого файла начиная
 *      с 44-го байта (то есть без старого, неверного заголовка)
 *   4. Завершаем upload — объект перезаписывается с верным заголовком,
 *      а аудиоданные при этом КОПИРУЮТСЯ на стороне Object Storage,
 *      не проходя повторно через сеть пользователя или наш сервер.
 *
 * @param {string} objectKey
 * @param {number} sampleRate
 * @returns {Promise<void>}
 */
export async function finalizeWavHeader(objectKey, sampleRate) {
  if (!objectKey) {
    throw new Error("finalizeWavHeader: не передан objectKey");
  }

  const client = getClient();
  const bucket = getBucketName();

  const headResult = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: objectKey })
  );
  const totalSize = headResult.ContentLength;
  if (!totalSize || totalSize <= 44) {
    throw new Error("finalizeWavHeader: файл слишком мал или пуст, нечего финализировать");
  }

  const dataSize = totalSize - 44; // первые 44 байта — это (неверный) заголовок первой части
  const header = buildWavHeader(dataSize, sampleRate);

  // S3 multipart upload требует, чтобы каждая часть (кроме последней) была
  // НЕ МЕНЬШЕ 5 МБ. Заголовок сам по себе — это всего 44 байта, поэтому
  // его нельзя отправить отдельной нелоследней частью. Решение: первая
  // часть нового файла — это [новый заголовок] + [первый кусок старых
  // аудиоданных], который мы СКАЧИВАЕМ с сервера и склеиваем с заголовком
  // в памяти (один раз, на стороне нашего backend, не на клиенте) — этого
  // кусочка должно быть с запасом больше 5 МБ. Всё, что осталось после
  // этого кусочка, копируется как вторая (последняя) часть через
  // UploadPartCopy — без скачивания на наш сервер, копирование происходит
  // внутри Object Storage.
  const FIRST_PART_DATA_BYTES = Math.min(dataSize, 6 * 1024 * 1024); // 6 МБ данных с запасом выше лимита в 5 МБ

  const firstChunkResponse = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Range: `bytes=44-${44 + FIRST_PART_DATA_BYTES - 1}`,
    })
  );
  const firstChunkBytes = await streamToBuffer(firstChunkResponse.Body);
  const firstPartBody = Buffer.concat([header, firstChunkBytes]);

  const createResult = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: objectKey, ContentType: "audio/wav" })
  );
  const uploadId = createResult.UploadId;

  try {
    const part1 = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: uploadId,
        PartNumber: 1,
        Body: firstPartBody,
      })
    );

    const remainingStart = 44 + FIRST_PART_DATA_BYTES;
    const parts = [{ PartNumber: 1, ETag: part1.ETag }];

    // Если в файле что-то осталось после первого куска — копируем остаток
    // как вторую (последнюю) часть. Для коротких записей, которые целиком
    // уместились в FIRST_PART_DATA_BYTES, второй части не будет вовсе.
    if (remainingStart < totalSize) {
      const part2 = await client.send(
        new UploadPartCopyCommand({
          Bucket: bucket,
          Key: objectKey,
          UploadId: uploadId,
          PartNumber: 2,
          CopySource: `${bucket}/${objectKey}`,
          CopySourceRange: `bytes=${remainingStart}-${totalSize - 1}`,
        })
      );
      parts.push({ PartNumber: 2, ETag: part2.CopyPartResult.ETag });
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  } catch (err) {
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId })
    ).catch(function() {});
    throw err;
  }
}

/**
 * Читает Node.js Readable stream (или web ReadableStream) целиком в Buffer.
 * Нужен для скачивания первого куска старого файла в finalizeWavHeader().
 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Строит стандартный 44-байтный WAV-заголовок (LINEAR16_PCM, моно) с
 * заданным размером данных. Используется при финализации заголовка на
 * сервере (см. finalizeWavHeader выше) после того, как стал известен
 * настоящий итоговый размер записи.
 *
 * @param {number} dataSize — размер аудиоданных в байтах (без заголовка)
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function buildWavHeader(dataSize, sampleRate) {
  const blockAlign = 2; // 16 бит, 1 канал
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

/**
 * Строит обычную (не подписанную) ссылку на объект.
 * Работает только если бакет публичный — у нас бакет приватный,
 * поэтому эта функция используется редко, в основном для отладки/логов.
 */
export function buildObjectStorageUrl(objectKey) {
  const bucket = getBucketName();
  return `${YANDEX_STORAGE_ENDPOINT}/${bucket}/${objectKey}`;
}

/**
 * Возвращает временную подписанную ссылку для СКАЧИВАНИЯ объекта (GET) —
 * её передаём в SpeechKit, чтобы он мог прочитать приватный файл.
 *
 * @param {string} objectKey
 * @param {number} expiresInSeconds — срок действия ссылки (по умолчанию 1 час)
 * @returns {Promise<string>} подписанный URL для GET-запроса
 */
export async function getSignedAudioUrl(objectKey, expiresInSeconds = 3600) {
  if (!objectKey) {
    throw new Error("getSignedAudioUrl: не передан objectKey");
  }

  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const client = getClient();
  const bucket = getBucketName();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
  });

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * Возвращает временную подписанную ссылку для ЗАГРУЗКИ объекта (PUT) —
 * браузер делает PUT-запрос с аудиофайлом в теле прямо на эту ссылку,
 * минуя наш backend (важно для больших файлов, которые не пройдут
 * через лимит размера запроса на Vercel).
 *
 * @param {string} objectKey — желаемое имя файла в бакете
 * @param {string} contentType — MIME-тип, который браузер укажет при PUT (должен совпадать)
 * @param {number} expiresInSeconds — срок действия ссылки (по умолчанию 10 минут —
 *   этого достаточно, чтобы браузер начал и закончил загрузку файла)
 * @returns {Promise<string>} подписанный URL для PUT-запроса
 */
export async function getSignedUploadUrl(objectKey, contentType = "audio/webm", expiresInSeconds = 600) {
  if (!objectKey) {
    throw new Error("getSignedUploadUrl: не передан objectKey");
  }

  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const client = getClient();
  const bucket = getBucketName();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

// ---------------------------------------------------------------------------
// Multipart upload — для длинных записей сессий (40-90 минут).
//
// Зачем: при обычном PutObjectCommand браузер должен держать ВЕСЬ аудиофайл
// целиком в памяти и отправить его одним запросом только после окончания
// записи. Для часовой записи это сотни МБ-гигабайты в памяти страницы —
// на мобильном Safari это приводит к убийству таба (page reload) до того,
// как запись успевает уйти на сервер, то есть запись теряется целиком.
//
// Решение: запись режется на части (~30-60 секунд звука каждая) прямо во
// время записи. Каждая часть сразу отправляется на сервер как очередная
// "часть" (part) multipart-загрузки и сразу же выбрасывается из памяти
// браузера. К моменту окончания записи (или к моменту, когда страница
// случайно/неожиданно перезагрузится) почти весь файл уже лежит на сервере —
// теряется максимум последний неотправленный чанк, а не вся запись.
//
// Протокол S3 multipart upload (Yandex Object Storage с ним совместим):
//   1. createMultipartUpload()      -> uploadId
//   2. getSignedPartUploadUrl() x N -> подписанный URL на каждую часть,
//      браузер делает PUT каждой части напрямую в Object Storage
//   3. completeMultipartUpload()    -> склеивает все части в один объект
//
// ВАЖНО: у S3 multipart upload есть ограничение — каждая часть (кроме
// последней) должна быть НЕ МЕНЬШЕ 5 МБ. Поэтому чанки на клиенте должны
// быть достаточно крупными (например 30-60 секунд аудио, это даёт
// несколько МБ на чанк при 16-бит/48kHz моно) — секундные чанки сюда
// не подойдут.
// ---------------------------------------------------------------------------

/**
 * Создаёт multipart upload и возвращает его ID. После этого нужно
 * запросить подписанные ссылки на части через getSignedPartUploadUrl().
 *
 * @param {string} objectKey — путь/имя итогового файла в бакете
 * @param {string} contentType — MIME-тип итогового файла, например "audio/wav"
 * @returns {Promise<string>} uploadId
 */
export async function createMultipartUpload(objectKey, contentType = "audio/wav") {
  if (!objectKey) {
    throw new Error("createMultipartUpload: не передан objectKey");
  }

  const client = getClient();
  const bucket = getBucketName();

  const result = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: contentType,
    })
  );

  if (!result.UploadId) {
    throw new Error("createMultipartUpload: Object Storage не вернул UploadId");
  }

  return result.UploadId;
}

/**
 * Возвращает подписанную ссылку для загрузки ОДНОЙ части multipart upload.
 * Браузер делает PUT с телом части напрямую на эту ссылку (минуя backend),
 * и должен сохранить заголовок ETag из ответа — он понадобится при
 * завершении загрузки (completeMultipartUpload).
 *
 * @param {string} objectKey
 * @param {string} uploadId — получен из createMultipartUpload()
 * @param {number} partNumber — номер части, начиная с 1 (не с 0!)
 * @param {number} expiresInSeconds
 * @returns {Promise<string>} подписанный URL для PUT-запроса этой части
 */
export async function getSignedPartUploadUrl(objectKey, uploadId, partNumber, expiresInSeconds = 600) {
  if (!objectKey) {
    throw new Error("getSignedPartUploadUrl: не передан objectKey");
  }
  if (!uploadId) {
    throw new Error("getSignedPartUploadUrl: не передан uploadId");
  }
  if (!partNumber || partNumber < 1) {
    throw new Error("getSignedPartUploadUrl: partNumber должен быть целым числом >= 1");
  }

  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const client = getClient();
  const bucket = getBucketName();

  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: objectKey,
    UploadId: uploadId,
    PartNumber: partNumber,
  });

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * Завершает multipart upload, склеивая все загруженные части в один
 * итоговый объект в бакете.
 *
 * @param {string} objectKey
 * @param {string} uploadId
 * @param {Array<{partNumber: number, eTag: string}>} parts — список частей
 *   в ПРАВИЛЬНОМ порядке (по возрастанию partNumber), с ETag, который
 *   браузер получил в ответ на каждый PUT-запрос части
 * @returns {Promise<string>} objectKey итогового файла
 */
export async function completeMultipartUpload(objectKey, uploadId, parts) {
  if (!objectKey) {
    throw new Error("completeMultipartUpload: не передан objectKey");
  }
  if (!uploadId) {
    throw new Error("completeMultipartUpload: не передан uploadId");
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("completeMultipartUpload: список частей пуст");
  }

  const client = getClient();
  const bucket = getBucketName();

  // S3 ожидает части строго отсортированными по возрастанию PartNumber
  const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sortedParts.map((p) => ({
          PartNumber: p.partNumber,
          ETag: p.eTag,
        })),
      },
    })
  );

  return objectKey;
}

/**
 * Отменяет multipart upload (например, если запись была прервана и
 * пользователь явно отказался от неё). Не обязательно вызывать всегда —
 * незавершённые multipart upload можно чистить отдельным lifecycle-правилом
 * в бакете, но явная отмена освобождает место сразу.
 *
 * @param {string} objectKey
 * @param {string} uploadId
 */
export async function abortMultipartUpload(objectKey, uploadId) {
  if (!objectKey || !uploadId) return;

  const client = getClient();
  const bucket = getBucketName();

  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: uploadId,
      })
    );
  } catch (err) {
    // Не критично, если отмена не удалась — просто залогируем
    console.error("abortMultipartUpload: не удалось отменить загрузку:", err);
  }
}

// ---------------------------------------------------------------------------
// Настройка CORS бакета.
//
// Зачем это нужно: записи дольше нескольких минут грузятся в Object Storage
// по частям (multipart upload) прямо из браузера. Для каждой части браузер
// должен прочитать заголовок ETag из ответа сервера — а по умолчанию CORS
// скрывает большинство заголовков ответа от JS, кроме небольшого "безопасного"
// списка, в который ETag не входит. Без явного ExposeHeaders: ["ETag"]
// загрузка каждой части молча проваливается на моменте чтения ETag, даже
// если сам PUT-запрос в Object Storage прошёл успешно.
//
// В текущей версии консоли Yandex Cloud визуального интерфейса для
// настройки CORS нет, поэтому конфигурация задаётся через S3 API.
// ---------------------------------------------------------------------------

/**
 * Устанавливает CORS-конфигурацию бакета, разрешающую загрузку (в том числе
 * по частям) с сайта приложения и чтение заголовка ETag в браузере.
 *
 * @param {string[]} allowedOrigins — список доменов, с которых разрешены
 *   запросы к бакету (например, ["https://therapy-notes-mvp.vercel.app"])
 */
export async function setBucketCors(allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error("setBucketCors: нужно передать хотя бы один origin");
  }

  const client = getClient();
  const bucket = getBucketName();

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: allowedOrigins,
            AllowedMethods: ["GET", "PUT", "POST", "HEAD", "DELETE"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    })
  );
}

/**
 * Возвращает текущую CORS-конфигурацию бакета — для проверки, что
 * настройка применилась так, как ожидалось.
 */
export async function getBucketCorsConfig() {
  const client = getClient();
  const bucket = getBucketName();

  try {
    const result = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    return result.CORSRules || [];
  } catch (err) {
    if (err.name === "NoSuchCORSConfiguration") {
      return [];
    }
    throw err;
  }
}
