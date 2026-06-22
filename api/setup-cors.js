// api/setup-cors.js
//
// ВРЕМЕННЫЙ одноразовый эндпоинт. Настраивает CORS-конфигурацию бакета
// Yandex Object Storage, чтобы браузер мог делать прямые PUT-запросы
// для загрузки аудиофайлов с сайта therapy-notes-mvp.vercel.app.
//
// Использование: один раз открыть в браузере
//   https://therapy-notes-mvp.vercel.app/api/setup-cors
// После успешного ответа ("CORS настроен") этот файл нужно УДАЛИТЬ —
// он не должен оставаться в проекте постоянно, так как открыт без
// какой-либо авторизации (любой, кто знает URL, может его вызвать).
//
// Использует переменные окружения, уже сохранённые на Vercel:
//   YANDEX_STORAGE_ACCESS_KEY_ID, YANDEX_STORAGE_SECRET_KEY, YANDEX_STORAGE_BUCKET

import { S3Client, PutBucketCorsCommand } from "@aws-sdk/client-s3";

export default async function handler(req, res) {
  const accessKeyId = process.env.YANDEX_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.YANDEX_STORAGE_SECRET_KEY;
  const bucket = process.env.YANDEX_STORAGE_BUCKET;

  if (!accessKeyId || !secretAccessKey || !bucket) {
    return res.status(500).json({ error: "Не заданы переменные окружения для Object Storage" });
  }

  const client = new S3Client({
    region: "ru-central1",
    endpoint: "https://storage.yandexcloud.net",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ["https://therapy-notes-mvp.vercel.app"],
              AllowedMethods: ["PUT", "GET", "HEAD"],
              AllowedHeaders: ["*"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      })
    );

    return res.status(200).json({
      message: "CORS настроен успешно. Теперь удалите этот файл (api/setup-cors.js) из репозитория — он больше не нужен и небезопасен в постоянном виде.",
    });
  } catch (err) {
    console.error("setup-cors: ошибка настройки CORS:", err);
    return res.status(500).json({ error: "Не удалось настроить CORS", details: err.message });
  }
}
