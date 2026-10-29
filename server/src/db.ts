import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

let pool: Pool | null = null;
let pglite: PGlite | null = null;

function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

/** Cria o Drizzle sobre Postgres real (DATABASE_URL) ou, sem ele,
 *  sobre PGlite (Postgres embarcado, mesmo dialeto) — usado para
 *  desenvolvimento local e para a verificação desta versão. No Render
 *  o caminho é sempre o Postgres do render.yaml. */
export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL?.trim();
  if (url && isPostgresUrl(url)) {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    const needsSsl =
      url.includes("sslmode=require") ||
      url.includes("sslmode=verify-full") ||
      (host !== "" && host !== "localhost" && host !== "127.0.0.1");
    pool = new Pool({
      connectionString: url,
      max: 5,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    return drizzlePg(pool, { schema });
  }
  const dataDir = process.env.PGLITE_DATA_DIR || "./data/pglite";
  pglite = new PGlite(dataDir);
  await pglite.waitReady;
  return drizzlePglite(pglite, { schema });
}

/** Cria todas as tabelas vazias a partir das migrations em
 *  migrations/*.sql, em ordem. Idempotente (CREATE TABLE IF NOT
 *  EXISTS / ADD COLUMN IF NOT EXISTS): rodar de novo não apaga
 *  dados. Não há migração de dados do gestor dentro do Muse — esta
 *  base começa vazia, como uma conta nova. */
export async function migrate(db: Db): Promise<void> {
  for (const file of ["001_init.sql", "002_admin_trial.sql", "003_sigma.sql"]) {
    const sqlText = readFileSync(
      join(import.meta.dir, "..", "..", "migrations", file),
      "utf8",
    );
    // Remove linhas de comentário ANTES de dividir: a primeira instrução
    // vem logo depois do cabeçalho comentado e seria descartada junto
    // com ele se o filtro olhasse o começo do bloco.
    const withoutComments = sqlText
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = withoutComments
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }
  }
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end().catch(() => {});
  if (pglite) await pglite.close().catch(() => {});
}
