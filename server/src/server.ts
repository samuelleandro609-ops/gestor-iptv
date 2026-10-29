import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Actions } from "./actions";
import { createCtx } from "./ctx";
import { closeDb, createDb, migrate, type Db } from "./db";

// Servidor standalone do Gestor Flex: serve as páginas compiladas
// (client/dist) e o endpoint POST /actions, com o mesmo protocolo do
// cliente original — {action, args, actionCallId} -> {data} ou {error}.
// Sem SDK do Muse, sem login do Muse: a fatura pública abre só com o
// código secreto do link, validado pela ação getInvoice.

const PORT = Number(process.env.PORT ?? 3000);
const DIST = join(import.meta.dir, "..", "..", "client", "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

let db: Db;

async function main(): Promise<void> {
  db = await createDb();
  await migrate(db);
  const ctx = createCtx(db);

  // Sincronização de cobranças a cada 60 segundos — o equivalente ao
  // cron gestor-iptv-sync-payments do gestor dentro do Muse. Roda para
  // todas as contas, sem sessão: a própria ação só consulta cobranças
  // pendentes com mpPaymentId e nunca marca renovação sem a extensão
  // real no painel ter retornado sucesso (ver actions.ts).
  const syncTimer = setInterval(async () => {
    try {
      await (Actions.syncPendingPayments as any).handler(ctx, {});
    } catch (err) {
      console.error("[sync] falha na sincronização de cobranças:", err);
    }
  }, 60_000);
  syncTimer.unref?.();

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }

      if (url.pathname === "/actions" && req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Corpo inválido: esperado JSON." }, { status: 400 });
        }
        const actionName = typeof body?.action === "string" ? body.action : "";
        const def = (Actions as Record<string, any>)[actionName];
        if (!def) {
          return Response.json({ error: `Ação desconhecida: ${actionName}` }, { status: 404 });
        }
        const parsed = def.request.safeParse(body.args ?? {});
        if (!parsed.success) {
          return Response.json(
            { error: `Pedido inválido para ${actionName}: ${parsed.error.message}` },
            { status: 400 },
          );
        }
        try {
          const data = await def.handler(ctx, parsed.data);
          const checked = def.response.safeParse(data);
          if (!checked.success) {
            console.error(`[actions] resposta inválida de ${actionName}:`, checked.error.message);
            return Response.json(
              { error: `O servidor respondeu em formato inesperado (${actionName}).` },
              { status: 500 },
            );
          }
          return Response.json({ data: checked.data });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[actions] ${actionName}:`, message);
          return Response.json({ error: message }, { status: 400 });
        }
      }

      // Páginas compiladas (SPA): qualquer rota que não seja um arquivo
      // cai no index.html — é assim que #/fatura/<código> abre.
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (path === "/" || path === ".") path = "/index.html";
      const filePath = join(DIST, path);
      if (existsSync(filePath) && !filePath.endsWith("/")) {
        const file = Bun.file(filePath);
        return new Response(file, {
          headers: { "Content-Type": TYPES[extname(filePath)] ?? "application/octet-stream" },
        });
      }
      const index = Bun.file(join(DIST, "index.html"));
      return new Response(index, { headers: { "Content-Type": TYPES[".html"]! } });
    },
  });

  const shutdown = async () => {
    clearInterval(syncTimer);
    server.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`Gestor Flex (externo) ouvindo na porta ${server.port}`);
}

main().catch((err) => {
  console.error("Falha ao iniciar o servidor:", err);
  process.exit(1);
});
