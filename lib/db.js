// /lib/db.js
// Общее подключение к базе данных. Vercel Postgres автоматически добавляет
// переменную окружения POSTGRES_URL при подключении базы к проекту —
// никаких паролей в коде хранить не нужно.

import { sql } from "@vercel/postgres";

export { sql };
