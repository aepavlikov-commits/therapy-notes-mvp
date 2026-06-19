// /lib/db.js
// Общее подключение к базе данных через Neon (используется Vercel под капотом
// для своих Postgres-баз). Переменная окружения DATABASE_URL добавляется
// автоматически при подключении базы данных к проекту на Vercel.

import { neon } from "@neondatabase/serverless";

export const sql = neon(process.env.DATABASE_URL);
