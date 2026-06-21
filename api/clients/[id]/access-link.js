// /api/clients/[id]/access-link.js
// POST /api/clients/:id/access-link -> сгенерировать (или вернуть существующую) уникальную ссылку для клиента

import { sql } from "../../../lib/db.mjs";
import { getTherapistIdFromRequest } from "../../../lib/auth.mjs";
import crypto from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Только POST-запросы поддерживаются" });
  }

  const therapistId = getTherapistIdFromRequest(req);
  if (!therapistId) {
    return res.status(401).json({ error: "Не авторизован. Войдите снова." });
  }

  const { id } = req.query;

  const clientCheck = await sql`
    SELECT id, access_token FROM clients WHERE id = ${id} AND therapist_id = ${therapistId}
  `;
  const client = clientCheck[0];
  if (!client) {
    return res.status(404).json({ error: "Клиент не найден" });
  }

  try {
    let token = client.access_token;
    if (!token) {
      token = crypto.randomBytes(24).toString("base64url");
      await sql`UPDATE clients SET access_token = ${token} WHERE id = ${id}`;
    }
    return res.status(200).json({ accessToken: token });
  } catch (err) {
    return res.status(500).json({ error: "Ошибка при создании ссылки доступа", details: err.message });
  }
}
