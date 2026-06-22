// api/test-keys.js
//
// ВРЕМЕННЫЙ диагностический эндпоинт. Проверяет, валидны ли ключи доступа
// к Object Storage, выполняя самую простую возможную операцию — список
// объектов в бакете. Если она пройдёт успешно, а настройка CORS всё равно
// падает — значит, проблема именно в команде CORS, не в самих ключах.
//
// Использование: открыть в браузере
//   https://therapy-notes-mvp.vercel.app/api/test-keys
// После использования — удалить этот файл.

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

export default async function handler(req, res) {
  const accessKeyId = process.env.YANDEX_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.YANDEX_STORAGE_SECRET_KEY;
  const bucket = process.env.YANDEX_STORAGE_BUCKET;

  if (!accessKeyId || !secretAccessKey || !bucket) {
    return res.status(500).json({ error: "Не заданы переменные окружения для Object Storage" });
  }

  // Безопасно показываем только длину и первые несколько символов ключа —
  // этого достаточно для диагностики, но не раскрывает сам секрет
  const diagnostics = {
    accessKeyIdLength: accessKeyId.length,
    accessKeyIdPreview: accessKeyId.slice(0, 6) + "...",
    secretKeyLength: secretAccessKey.length,
    secretKeyPreview: secretAccessKey.slice(0, 4) + "...",
    bucket,
  };

  const client = new S3Client({
    region: "ru-central1",
    endpoint: "https://storage.yandexcloud.net",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  try {
    const result = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 5 })
    );

    return res.status(200).json({
      message: "Ключи валидны! Список объектов получен успешно.",
      objectCount: result.KeyCount || 0,
      diagnostics,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Ключи не сработали при простом запросе списка объектов",
      details: err.message,
      diagnostics,
    });
  }
}
