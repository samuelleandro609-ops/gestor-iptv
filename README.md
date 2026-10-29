# Gestor Flex — versão externa (fora do Muse)

Versão standalone do gestor, para rodar fora do Muse (ex.: Render
Free), **sem tocar no artefato original** em
`~/workspace/ts-spaces/gestor-iptv/` (não editado, banco e sessão de
WhatsApp de lá intactos). Mesmas telas e mesmas ações do original,
com servidor próprio em Bun + Postgres.

## O que mudou em relação ao original

- **Servidor:** `server/src/server.ts` (Bun) serve `client/dist` e o
  endpoint `POST /actions` com o protocolo `{action, args} -> {data}`
  ou `{error}`. O `defineAction` do SDK do Muse foi substituído por
  um shim local (`server/src/sdk-shim.ts`); `ctx.db()` usa Drizzle
  sobre Postgres e `ctx.executePrivileged()` chama direto as funções
  do serviço de WhatsApp (`server/src/privileged.ts`).
- **Banco:** esquema SQLite (`drizzle-orm/sqlite-core`) convertido
  para Postgres (`drizzle-orm/pg-core`, `migrations/001_init.sql`).
  Datas de vencimento/criação viraram `timestamp(3)` (Date) e
  carimbos em milissegundos (`sessions.expires_at`,
  `panel_connection_tested_at`, `tested_at`, `synced_at`,
  `wa_qr_updated_at`) viraram `bigint` — milissegundos de 2026 não
  cabem em `integer` de 32 bits. Enums do SQLite viraram `text`
  (valores continuam validados por zod/telas). Sem `DATABASE_URL`,
  o servidor usa PGlite (Postgres embarcado, mesmo dialeto) para
  desenvolvimento local; no Render, o caminho é o Postgres do
  `render.yaml` via `node-postgres`.
- **Cliente:** `client/src/api.ts` reescrito com `fetch` (sem SDK);
  `main.tsx` usa um `QueryClient` próprio; `SafeAreaTopScrim` virou
  um componente local que não renderiza nada. Tema azul-marinho
  escuro, telas e textos **inalterados** (`App.tsx` só teve a
  importação do SafeArea trocada).
- **Sincronização de cobranças:** o cron do Muse virou um intervalo
  de 60 segundos dentro do próprio servidor (`syncPendingPayments`).
- **WhatsApp:** mesmo serviço Baileys v4 do original (QR Code,
  sessão persistente por conta, envio por arquivos), agora disparado
  por chamadas de função diretas. O binário do Node é procurado em
  `/usr/bin/node`, `/usr/local/bin/node` e, como último recurso, o
  próprio executável do Bun (o Dockerfile instala o Node).
- **Não portado / sem equivalente fora do Muse:** migração dos dados
  do gestor dentro do Muse (a base nova começa vazia — cadastrar de
  novo); publicação do artefato (não há mais artefato aqui).
- **Comportamentos honestos preservados:** renovação no painel só é
  dada como aplicada após extensão real com HTTP 2xx; pagamento
  aprovado sem extensão fica `aprovado_pendente_painel`, sem
  consumir crédito; token da API do painel e senhas nunca voltam
  para a tela; link da fatura só abre com o código secreto de 48
  caracteres.

## Rodar localmente

```sh
cd gestor-iptv-externo
bun install
bun run build:client
# Sem DATABASE_URL: usa PGlite em ./data/pglite
bun run start
# Com Postgres real:
# DATABASE_URL=postgres://usuario:senha@localhost:5432/gestor bun run start
```

Variáveis (ver `.env.example`, sem segredos): `PORT` (padrão 3000),
`DATABASE_URL`, `PUBLIC_BASE_URL`, `SESSION_SECRET` (gerado pelo
Render; reservado), `PGLITE_DATA_DIR`, `GESTOR_DATA_DIR`.

Abra http://localhost:3000 — crie uma conta (começa vazia) e use
normalmente. A fatura pública é `#/fatura/<código>` e abre sem login.

## Deploy no Render

Guia completo e corrigido em [`HOSPEDAGEM-RENDER.md`](HOSPEDAGEM-RENDER.md)
— caminho único pelo Blueprint (não crie o Postgres manualmente).

## Verificação feita (2026-10-28, dados de teste falsos)

Servidor local com PGlite + cliente compilado: conta criada e login,
servidor/plano/cliente de teste, fatura pública sem sessão com plano
e valor certos, código errado e número do cliente sozinho retornando
`found: false` sem vazar dados, novo link invalidando o antigo,
`createPix` sem Mercado Pago em `aguardando_configuracao` (nenhuma
cobrança gerada), diagnóstico da API do painel com endereço falso
retornando “não conectou” sem vazar o token, segunda conta vazia,
`syncPendingPayments` e status do WhatsApp desconectado sem inventar
QR Code.

**Não verificado:** deploy no Render, Postgres real via `node-postgres`
(o código do driver está pronto, mas nenhum servidor Postgres estava
disponível para teste — a verificação usou PGlite, mesmo dialeto),
Pix real de ponta a ponta, renovação automática no painel real e
leitura de QR Code com celular de verdade. Ver
`HOSPEDAGEM-RENDER.md`.
