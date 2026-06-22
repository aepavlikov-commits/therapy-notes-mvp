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
const YANDEX_STORAGE_REGION = "ru-central1";

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
    forcePathStyle: true,
  });
}

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

export function buildObjectStorageUrl(objectKey) {
  const bucket = getBucketName();
  return `${YANDEX_STORAGE_ENDPOINT}/${bucket}/${objectKey}`;
}

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
