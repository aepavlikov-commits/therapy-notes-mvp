// /lib/gigachat.js
// Общая логика вызова GigaChat API.
// Authorization key теперь хранится на сервере как переменная окружения
// GIGACHAT_AUTH_KEY (см. README), а не вводится пользователем в браузере.

import { Agent } from "undici";
import fs from "node:fs";
import path from "node:path";

let dispatcher;
try {
  const certPath = path.join(process.cwd(), "api", "russian_trusted_root_ca.pem");
  const ca = fs.readFileSync(certPath);
  dispatcher = new Agent({ connect: { ca } });
} catch (e) {
  dispatcher = undefined;
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const authKey = process.env.GIGACHAT_AUTH_KEY;
  if (!authKey) {
    throw new Error(
      "GIGACHAT_AUTH_KEY не задан в переменных окружения сервера. Добавьте его в настройках проекта на Vercel."
    );
  }
  if (!dispatcher) {
    throw new Error("Сертификат НУЦ Минцифры не найден на сервере (api/russian_trusted_root_ca.pem).");
  }

  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

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
    dispatcher,
  });

  if (!oauthResponse.ok) {
    const errText = await oauthResponse.text();
    throw new Error(`Не удалось получить токен доступа от GigaChat: ${errText}`);
  }

  const oauthData = await oauthResponse.json();
  cachedToken = oauthData.access_token;
  cachedTokenExpiresAt = Date.now() + 25 * 60 * 1000;
  return cachedToken;
}

export async function callGigaChat(prompt, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const accessToken = await getAccessToken();

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
      dispatcher,
    });

    if (chatResponse.ok) {
      const chatData = await chatResponse.json();
      return chatData?.choices?.[0]?.message?.content || "";
    }

    const errText = await chatResponse.text();
    const isRateLimit = chatResponse.status === 429;

    if (isRateLimit && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      continue;
    }

    throw new Error(`Ошибка при запросе к GigaChat: ${errText}`);
  }
}
