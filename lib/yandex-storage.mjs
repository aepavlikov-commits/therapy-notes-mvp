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

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

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
