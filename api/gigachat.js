// /api/gigachat.js
// Serverless-функция для Vercel.
// Принимает запрос от фронтенда с промптом, сама обменивает Authorization key
// на временный access token у GigaChat, и возвращает ответ модели.
//
// ВАЖНО: Authorization key передаётся в заголовке запроса с фронтенда
// (никогда не хранится в коде этого файла), поэтому он не "зашит" в backend
// и не виден в публичном репозитории.
//
// ВАЖНО про SSL: серверы GigaChat используют сертификат НУЦ Минцифры,
// которого нет в стандартном списке доверенных сертификатов Node.js.
// Поэтому здесь подключается локальный файл сертификата (russian_trusted_root_ca.pem),
// который должен лежать в той же папке /api. Скачать его можно один раз с
// https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
// (переименовать в .pem и положить в /api/russian_trusted_root_ca.pem).

import https from "node:https";
import fs from "node:fs";
import path from "node:path";

let httpsAgent;
try {
  const certPath = path.join(process.cwd(), "api", "russian_trusted_root_ca.pem");
  const ca = fs.readFileSync(certPath);
  httpsAgent = new https.Agent({ ca });
} catch (e) {
  // Сертификат не найден — запросы к GigaChat будут падать с ошибкой SSL,
  // пока файл не будет добавлен в проект (см. инструкцию в README).
  httpsAgent = undefined;
}

export default async function handler(req, res) {
  // Разрешаем CORS, чтобы фронтенд (любой домен) мог обращаться к этой функции
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Key");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Только POST-запросы поддерживаются" });
  }

  const authKey = req.headers["x-auth-key"];
  const { prompt } = req.body || {};

  if (!authKey) {
    return res.status(400).json({ error: "Не передан Authorization key (заголовок X-Auth-Key)" });
  }
  if (!prompt) {
    return res.status(400).json({ error: "Не передан prompt в теле запроса" });
  }
  if (!httpsAgent) {
    return res.status(500).json({
      error: "Сертификат НУЦ Минцифры не найден на сервере",
      details:
        "Скачайте сертификат с https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt, переименуйте в russian_trusted_root_ca.pem и положите в папку /api проекта, затем переразверните сайт.",
    });
  }

  try {
    // Шаг 1: обмениваем Authorization key на временный access token.
    // Токен живёт 30 минут, поэтому получаем новый при каждом запросе —
    // для объёма MVP это нормально, в проде стоит кэшировать токен на 25 минут.
    const rqUID = crypto.randomUUID();

    const oauthResponse = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        RqUID: rqUID,
        Authorization: `Basic ${authKey}`,
      },
      body: "scope=GIGACHAT_API_PERS",
      agent: httpsAgent,
    });

    if (!oauthResponse.ok) {
      const errText = await oauthResponse.text();
      return res.status(502).json({
        error: "Не удалось получить токен доступа от GigaChat",
        details: errText,
      });
    }

    const oauthData = await oauthResponse.json();
    const accessToken = oauthData.access_token;

    // Шаг 2: отправляем сам запрос к модели с полученным токеном.
    const chatResponse = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: "GigaChat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
      }),
      agent: httpsAgent,
    });

    if (!chatResponse.ok) {
      const errText = await chatResponse.text();
      return res.status(502).json({
        error: "Ошибка при запросе к GigaChat",
        details: errText,
      });
    }

    const chatData = await chatResponse.json();
    const text = chatData?.choices?.[0]?.message?.content || "";

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: "Внутренняя ошибка прокси", details: err.message });
  }
}
