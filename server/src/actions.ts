import { z } from "zod";
import { defineAction, type ActionsModule, type Ctx } from "./sdk-shim";
import { privileged } from "./privileged";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const okResponse = z.object({ ok: z.literal(true) });

function creditsForDays(days: number): number {
  return Math.round(days / 30);
}

function fmtBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function renderTemplate(
  tpl: string,
  vars: {
    nome: string;
    usuario: string;
    vencimento: string;
    novoVencimento?: string;
    dias?: number;
    valor?: string;
    plano?: string;
    link?: string;
    telefone?: string;
    diasVencido?: number;
  },
): string {
  return tpl
    .replaceAll("{nome}", vars.nome)
    .replaceAll("{usuario}", vars.usuario)
    .replaceAll("{vencimento}", vars.vencimento)
    .replaceAll("{novo_vencimento}", vars.novoVencimento ?? "")
    .replaceAll("{dias}", vars.dias != null ? String(vars.dias) : "")
    .replaceAll("{valor}", vars.valor ?? "")
    .replaceAll("{plano}", vars.plano ?? "")
    .replaceAll("{link}", vars.link ?? "")
    .replaceAll("{telefone}", vars.telefone ?? "")
    .replaceAll("{dias_vencido}", vars.diasVencido != null ? String(vars.diasVencido) : "");
}

const TEMPLATE_VENCE_HOJE =
  "Bom dia {nome}! 🔔\n\nSeu acesso vence hoje!\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!";
const TEMPLATE_VENCE_3_DIAS =
  "Bom dia {nome}! 🔔\n\nSeu acesso vence em 3 dias!\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!";
const TEMPLATE_RENOVADA =
  "Boa tarde {nome}! ✅\n\nSua renovação foi confirmada!\n\n📋 Plano: {plano}\n📅 Novo vencimento: {novo_vencimento}\n💰 Valor: {valor}\n\nObrigado pela confiança! Qualquer dúvida, fale conosco.";
const TEMPLATE_EXPIRADA =
  "Bom dia {nome}! 🔔\n\nSeu acesso venceu!\n\n📅 Vencimento: {vencimento}\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!";
const TEMPLATE_VENCE_AMANHA =
  "Bom dia {nome}! 🔔\n\nSeu acesso vence amanhã!\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!";

// Modelos antigos (padrão do sistema, com tudo numa frase só): contas
// que nunca personalizaram o modelo passam a ver o modelo novo, no
// estilo organizado pedido pela dona do gestor. Um modelo que ela
// mesma editou (diferente destes textos) nunca é trocado.
const LEGACY_TEMPLATES: Record<string, string[]> = {
  warnMessage: [
    "Olá, {nome}! Sua assinatura vence em {vencimento}. Renove para não ficar sem acesso: abra a sua fatura e pague com Pix: {link}",
    "Olá, {nome}! Sua assinatura vence em {vencimento}. Renove para não ficar sem acesso: toque no seu link de renovação e pague com Pix.",
  ],
  renewedMessage: [
    "Pagamento confirmado! ✅ Olá, {nome}! Sua assinatura foi renovada por {dias} dias. Novo vencimento: {novo_vencimento}. Usuário IPTV: {usuario}. Obrigado!",
  ],
  expiredMessage: [
    "Olá, {nome}. Sua assinatura expirou em {vencimento} (há {dias_vencido} dias). Para voltar a assistir, abra a sua fatura e pague com Pix: {link} Qualquer dúvida, é só chamar aqui.",
    "Olá, {nome}. Sua assinatura expirou em {vencimento}. Para voltar a assistir, renove pelo seu link de renovação e pague com Pix. Qualquer dúvida, é só chamar aqui.",
    "Bom dia {nome}! 🔔\n\nSeu acesso venceu em {vencimento}!\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!",
  ],
  chargeMessage: [
    "Olá, {nome}! Passando para lembrar da sua assinatura {plano}, no valor de {valor}, com vencimento em {vencimento}. Para renovar é rapidinho: abra a sua fatura e pague com Pix: {link} Qualquer dúvida, é só chamar aqui.",
    "Bom dia {nome}! 🔔\n\nPassando para lembrar da sua assinatura:\n\n📋 Plano: {plano}\n💰 Valor: {valor}\n📅 Vencimento: {vencimento}\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!",
  ],
};

function upgradeLegacyTemplate(value: string, legacy: string[], replacement: string): string {
  return legacy.includes(value.trim()) ? replacement : value;
}

const DEFAULTS = {
  warnDays: [3, 0] as number[],
  publicBaseUrl: "",
  invoiceTitle: "Renove sua assinatura",
  invoiceMessage:
    "Pague com Pix e sua conta é renovada assim que o pagamento for confirmado.",
  invoiceColor: "verde",
  warnMessage: TEMPLATE_VENCE_HOJE,
  warnSoonMessage: TEMPLATE_VENCE_3_DIAS,
  renewedMessage: TEMPLATE_RENOVADA,
  expiredMessage: TEMPLATE_EXPIRADA,
  chargeMessage: TEMPLATE_VENCE_AMANHA,
  mpAccessToken: "",
  mpPublicKey: "",
  mpVerified: false,
  mpAccountLabel: "",
  mpPayerEmail: "",
  mpEnvironment: "teste" as "teste" | "producao",
  liveMode: false,
  whatsappStatus: "desconectado" as "desconectado" | "conectado",
  whatsappPhone: "",
  waQrStatus: "desconectado",
  waQrPhone: "",
  waQrDetail: "",
  waQrImage: "",
  waQrUpdatedAt: 0,
  waBlockCalls: false,
  waTranscribeAudio: false,
  waAwayEnabled: false,
  waAwayMessage: "",
};

type SettingsObj = typeof DEFAULTS;

async function loadSettings(ctx: Ctx, ownerId: number): Promise<SettingsObj> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.ownerId, ownerId));
  const row = rows[0];
  if (!row) return { ...DEFAULTS };
  const warnDays = row.warnDays
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return {
    warnDays: warnDays.length ? warnDays : [3, 0],
    publicBaseUrl: row.publicBaseUrl ?? "",
    invoiceTitle: row.invoiceTitle,
    invoiceMessage: row.invoiceMessage,
    invoiceColor: row.invoiceColor,
    warnMessage: upgradeLegacyTemplate(row.warnMessage, LEGACY_TEMPLATES.warnMessage ?? [], TEMPLATE_VENCE_HOJE),
    warnSoonMessage: row.warnSoonMessage ?? DEFAULTS.warnSoonMessage,
    renewedMessage: upgradeLegacyTemplate(row.renewedMessage, LEGACY_TEMPLATES.renewedMessage ?? [], TEMPLATE_RENOVADA),
    expiredMessage: upgradeLegacyTemplate(row.expiredMessage, LEGACY_TEMPLATES.expiredMessage ?? [], TEMPLATE_EXPIRADA),
    chargeMessage: upgradeLegacyTemplate(
      row.chargeMessage ?? DEFAULTS.chargeMessage,
      LEGACY_TEMPLATES.chargeMessage ?? [],
      TEMPLATE_VENCE_AMANHA,
    ),
    mpAccessToken: row.mpAccessToken,
    mpPublicKey: row.mpPublicKey,
    mpVerified: row.mpVerified === 1,
    mpAccountLabel: row.mpAccountLabel,
    mpPayerEmail: row.mpPayerEmail ?? "",
    mpEnvironment: row.mpEnvironment,
    liveMode: row.liveMode === 1,
    whatsappStatus: row.whatsappStatus,
    whatsappPhone: row.whatsappPhone,
    waQrStatus: row.waQrStatus || "desconectado",
    waQrPhone: row.waQrPhone,
    waQrDetail: row.waQrDetail,
    waQrImage: row.waQrImage,
    waQrUpdatedAt: row.waQrUpdatedAt,
    waBlockCalls: row.waBlockCalls === 1,
    waTranscribeAudio: row.waTranscribeAudio === 1,
    waAwayEnabled: row.waAwayEnabled === 1,
    waAwayMessage: row.waAwayMessage ?? "",
  };
}

async function persistSettings(
  ctx: Ctx,
  ownerId: number,
  patch: Partial<{
    warnDays: string;
    publicBaseUrl: string;
    invoiceTitle: string;
    invoiceMessage: string;
    invoiceColor: string;
    warnMessage: string;
    warnSoonMessage: string;
    renewedMessage: string;
    expiredMessage: string;
    chargeMessage: string;
    mpAccessToken: string;
    mpPublicKey: string;
    mpVerified: number;
    mpAccountLabel: string;
    mpPayerEmail: string;
    mpEnvironment: "teste" | "producao";
    liveMode: number;
    whatsappStatus: "desconectado" | "conectado";
    whatsappPhone: string;
    waQrStatus: string;
    waQrPhone: string;
    waQrDetail: string;
    waQrImage: string;
    waQrUpdatedAt: number;
    waBlockCalls: number;
    waTranscribeAudio: number;
    waAwayEnabled: number;
    waAwayMessage: string;
  }>,
) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.ownerId, ownerId));
  if (rows[0]) {
    await db
      .update(schema.settings)
      .set(patch)
      .where(eq(schema.settings.ownerId, ownerId));
  } else {
    await db.insert(schema.settings).values({ ownerId, ...patch });
  }
}

// ---------------- Contas e sessões (login) ----------------
// O gestor é usado por várias pessoas: cada conta (accounts) é dona
// dos seus dados (owner_id em todas as tabelas) e conta nova começa
// vazia. A sessão guarda só o hash do token; a senha, só o hash
// PBKDF2 com sal. Nenhum dos dois é devolvido para a tela.

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
  return `${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split("$");
  if (!saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex).buffer as ArrayBuffer, iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits)) === hashHex;
}

async function createSession(ctx: Ctx, accountId: number): Promise<string> {
  const db = ctx.db<typeof schema>();
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = bytesToHex(raw);
  const tokenHash = await sha256Hex(token);
  await db.insert(schema.sessions).values({
    accountId,
    tokenHash,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return token;
}

// Código secreto do link público da fatura: 24 bytes aleatórios em
// hexadecimal (48 caracteres). Não é derivado do id do cliente, do
// nome nem de nada adivinhável — só quem recebe o link tem o código.
function generateInvoiceToken(): string {
  const raw = new Uint8Array(24);
  crypto.getRandomValues(raw);
  return bytesToHex(raw);
}

// Clientes antigos (criados antes do link secreto) ganham o código na
// primeira leitura: sem isso, o link deles continuaria sem código e a
// fatura não abriria. Gera uma vez só e guarda — o código fica estável
// até o dono pedir um novo em "Gerar novo link da fatura".
async function ensureInvoiceTokens(
  ctx: Ctx,
  rows: Array<typeof schema.clients.$inferSelect>,
): Promise<Map<number, string>> {
  const db = ctx.db<typeof schema>();
  const out = new Map<number, string>();
  for (const row of rows) {
    if (row.invoiceToken && row.invoiceToken.length >= 20) {
      out.set(row.id, row.invoiceToken);
    } else {
      const token = generateInvoiceToken();
      await db
        .update(schema.clients)
        .set({ invoiceToken: token })
        .where(eq(schema.clients.id, row.id));
      out.set(row.id, token);
    }
  }
  return out;
}

// Resolve a conta dona a partir do token de sessão enviado pelo
// cliente. Sem sessão válida, a ação para aqui: nada é lido nem
// gravado fora da conta de quem entrou.
async function requireAccount(ctx: Ctx, session: string | undefined): Promise<number> {
  if (!session) throw new Error("Faça login para continuar.");
  const db = ctx.db<typeof schema>();
  const tokenHash = await sha256Hex(session);
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, tokenHash));
  const row = rows[0];
  if (!row || row.expiresAt < Date.now()) {
    throw new Error("Sua sessão expirou. Faça login de novo.");
  }
  return row.accountId;
}

const sessionField = z.string().optional();

// O painel só é considerado conectado quando existe um servidor com o
// token da API salvo E o teste de autenticação dessa API já passou
// (apiVerified). A EXTENSÃO (o [+] do painel) é uma etapa separada:
// extendReady só é verdade quando uma extensão real já retornou sucesso
// (extendVerified). Até lá, pagamento aprovado fica "extensão pendente"
// e NENHUM crédito é dado como consumido.
async function loadPanelStatus(ctx: Ctx, ownerId: number): Promise<{
  connected: boolean;
  extendReady: boolean;
  detail: string;
  extendDetail: string;
}> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.servers).where(eq(schema.servers.ownerId, ownerId));
  const simpleConnected = rows.find((r) => (r.panelConnected ?? 0) === 1);
  if (simpleConnected) {
    return {
      connected: true,
      extendReady: simpleConnected.extendVerified === 1,
      detail: `Painel conectado: o servidor “${simpleConnected.name}” conectou com link, usuário e senha do painel. ${simpleConnected.panelConnectionDetail}`,
      extendDetail:
        simpleConnected.extendVerified === 1
          ? `Extensão verificada no servidor “${simpleConnected.name}”.`
          : "Extensão pendente: o servidor está conectado, mas nenhuma extensão real retornou sucesso ainda — se a API do painel responder erro (ex.: HTTP 400), a renovação fica pendente com o motivo, sem consumir crédito.",
    };
  }
  const verified = rows.find((r) => r.apiToken.length > 0 && r.apiVerified === 1);
  if (verified) {
    return {
      connected: true,
      extendReady: verified.extendVerified === 1,
      detail: `API do painel conectada: o teste de autenticação passou para o servidor “${verified.name}”.`,
      extendDetail:
        verified.extendVerified === 1
          ? `Extensão verificada no servidor “${verified.name}”: uma extensão real pela API já retornou sucesso.`
          : "Extensão pendente: a autenticação passou, mas nenhuma extensão real pela API retornou sucesso ainda. Confira caminho/método/corpo da extensão na aba Servidores e use o teste de extensão — ele renova de verdade e consome crédito.",
    };
  }
  const withToken = rows.find((r) => r.apiToken.length > 0);
  if (withToken) {
    return {
      connected: false,
      extendReady: false,
      detail:
        "Há um token da API do painel salvo, mas o teste de conexão ainda não passou. A renovação continua marcada como pendente até o teste de autenticação da API passar na aba Servidores.",
      extendDetail: "Extensão pendente: primeiro o teste de conexão da API precisa passar.",
    };
  }
  return {
    connected: false,
    extendReady: false,
    detail:
      "Nenhum servidor conectou ainda. Cadastre um servidor em Servidores → Novo Servidor só com o link do painel, o usuário e a senha: ao salvar, o gestor testa a conexão e mostra Conectado ou o motivo.",
    extendDetail: "Extensão pendente: nenhum servidor conectado ainda.",
  };
}

// Resolve o servidor que deve executar a extensão de um cliente: o
// servidor do próprio cliente; se ele não tiver, o primeiro servidor
// com autenticação da API aprovada.
async function resolvePanelServer(
  ctx: Ctx,
  client: typeof schema.clients.$inferSelect,
): Promise<typeof schema.servers.$inferSelect | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.servers).where(eq(schema.servers.ownerId, client.ownerId));
  if (client.serverId != null) {
    const own = rows.find((r) => r.id === client.serverId);
    if (own && own.apiToken.length > 0 && own.apiVerified === 1) return own;
  }
  return rows.find((r) => r.apiToken.length > 0 && r.apiVerified === 1) ?? null;
}

function renderExtendTemplate(
  tpl: string,
  vars: { usuario: string; senha: string; dias: number; creditos: number },
): string {
  return tpl
    .replaceAll("{usuario}", vars.usuario)
    .replaceAll("{senha}", vars.senha)
    .replaceAll("{dias}", String(vars.dias))
    .replaceAll("{creditos}", String(vars.creditos));
}

type PanelApiBaseInspection = {
  original: string;
  normalized: string;
  valid: boolean;
  error: string;
  warnings: string[];
};

// Confere a base da API antes de montar a URL do teste. HTTP 400 também
// pode nascer de uma URL mal montada: barra final, endpoint colado na
// base (caminho duplicado), porta errada/ausente ou caminho a mais.
function inspectPanelApiBase(raw: string): PanelApiBaseInspection {
  const warnings: string[] = [];
  const original = raw.trim();
  if (!original) {
    return {
      original,
      normalized: "",
      valid: false,
      error: "A base da API está vazia.",
      warnings,
    };
  }
  let candidate = original.replace(/\s+/g, "");
  if (candidate !== original) warnings.push("Havia espaços na base; eles foram removidos para o teste.");
  if (candidate.endsWith("/")) {
    candidate = candidate.replace(/\/+$/, "");
    warnings.push("A base terminava com barra (/). A barra final foi removida para a URL não ficar com caminho duplicado.");
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
    warnings.push("A base estava sem https:// no começo; o teste usou https:// automaticamente.");
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      original,
      normalized: "",
      valid: false,
      error: "A base da API não é um endereço válido. Ela precisa se parecer com https://mcapi.knewcms.com:2087.",
      warnings,
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      original,
      normalized: "",
      valid: false,
      error: `A base começa com “${url.protocol}”, mas a API precisa usar http:// ou https://.`,
      warnings,
    };
  }
  if (url.username || url.password) {
    warnings.push("A base tinha usuário/senha escritos dentro do endereço; eles foram ignorados no teste. Usuário e senha ficam nos campos próprios do servidor.");
    url.username = "";
    url.password = "";
  }
  if (url.search || url.hash) {
    warnings.push("A base tinha texto depois de ? ou #; essa parte foi removida porque não faz parte do endereço da API.");
    url.search = "";
    url.hash = "";
  }
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path !== url.pathname) warnings.push("A base tinha barras repetidas no caminho (//); elas foram corrigidas para uma só.");
  while (path.toLowerCase().endsWith("/auth/static-token")) {
    path = path.slice(0, -"/auth/static-token".length);
    warnings.push("Você colou o endereço completo do teste (/auth/static-token) no campo da base. Ele foi removido da base para o caminho não ficar duplicado.");
  }
  if (path.toLowerCase().endsWith("/auth")) {
    path = path.slice(0, -"/auth".length);
    warnings.push("A base terminava em /auth. Essa parte foi removida para o teste não chamar /auth/auth/static-token.");
  }
  path = path.replace(/\/+$/, "");
  if (path) {
    warnings.push(`A base tem um caminho extra (${path}). O teste chamou esse caminho + /auth/static-token. Se a API fica direto no endereço principal, apague esse caminho da base.`);
  }
  if (url.hostname === "mcapi.knewcms.com") {
    if (!url.port) {
      warnings.push("Falta a porta na base conhecida do painel. O endereço passado para este painel usa :2087 no final; sem a porta, a chamada pode cair no servidor errado.");
    } else if (url.port !== "2087") {
      warnings.push(`A porta da base é :${url.port}, mas o endereço passado para este painel usa :2087. Confira a porta.`);
    }
  } else if (url.port) {
    warnings.push(`A base usa a porta :${url.port}. Ela precisa ser exatamente a porta da API do painel.`);
  }
  const normalized = `${url.protocol}//${url.host}${path}`;
  if (normalized !== original) warnings.push(`Endereço usado no teste: ${normalized}/auth/static-token.`);
  return { original, normalized, valid: true, error: "", warnings: [...new Set(warnings)] };
}

function redactPanelSecrets(value: unknown, secrets: string[]): string {
  const redactText = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      if (secret && secret.length >= 3) {
        out = out.split(secret).join("••••••");
        out = out.split(encodeURIComponent(secret)).join("••••••");
      }
    }
    return out;
  };
  if (typeof value === "string") return redactText(value);
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, val]) => [
          key,
          /token|secret|password|senha|authorization/i.test(key) ? "••••••" : walk(val),
        ]),
      );
    }
    return item;
  };
  return redactText(JSON.stringify(walk(value), null, 2) ?? "");
}

// Lê o corpo da resposta sem vazar credenciais. Para JSON, preserva a
// mensagem/campos do erro e esconde somente valores de token/senha.
function sanitizePanelResponseBody(raw: string, secrets: string[], max = 900): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let shown: string;
  try {
    shown = redactPanelSecrets(JSON.parse(trimmed) as unknown, secrets);
  } catch {
    shown = redactPanelSecrets(trimmed, secrets);
  }
  return shown.length > max ? `${shown.slice(0, max)}\n…[resposta cortada no gestor]` : shown;
}

function panelResponseFailureMessage(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    const explicitFalse = obj.success === false || obj.ok === false;
    const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
    if (!explicitFalse && !obj.error && !["error", "failed", "invalid", "erro"].includes(status)) return null;
    const err = obj.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      return String((err as { message: string }).message);
    }
    if (typeof obj.message === "string") return obj.message;
    return "A API respondeu HTTP de sucesso, mas o conteúdo da resposta indica erro.";
  } catch {
    return null;
  }
}

// Executa a extensão REAL do usuário exato na API do painel — o
// equivalente ao botão [+] Estender da lista de usuários. Usa o
// caminho/método/corpo editáveis salvos no servidor. Retorna sucesso
// somente com HTTP 2xx; qualquer outra resposta é falha, sem fingir.
async function panelExtendUser(
  server: typeof schema.servers.$inferSelect,
  args: { iptvUser: string; iptvPass: string; days: number },
): Promise<{ ok: boolean; detail: string }> {
  const baseCheck = inspectPanelApiBase(server.apiBase);
  if (!baseCheck.valid) return { ok: false, detail: `A base da API do painel está inválida: ${baseCheck.error}` };
  const base = baseCheck.normalized;
  if (!server.apiToken)
    return {
      ok: false,
      detail: `Extensão pendente do usuário ${args.iptvUser}: o servidor está conectado com link, usuário e senha do painel, mas a chamada de extensão da API deste painel pede o token da API e nenhum token está salvo neste servidor. Nada foi renovado no painel e nenhum crédito foi consumido. O token pode ser salvo em Servidores → Editar → Opções avançadas.`,
    };
  const credits = creditsForDays(args.days);
  const vars = { usuario: args.iptvUser, senha: args.iptvPass, dias: args.days, creditos: credits };
  const path = renderExtendTemplate(server.extendPath || "/users/extend", vars);
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const method = (server.extendMethod || "POST").toUpperCase();
  const bodyText = renderExtendTemplate(server.extendBody ?? "", vars);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${server.apiToken}`,
      },
      body: method === "GET" ? undefined : bodyText || undefined,
      signal: AbortSignal.timeout(20000),
    });
    const rawBody = await res.text().catch(() => "");
    const shownBody = sanitizePanelResponseBody(rawBody, [server.apiToken, args.iptvPass], 500);
    const failureMessage = panelResponseFailureMessage(rawBody);
    if (res.ok && !failureMessage) {
      return {
        ok: true,
        detail: `A API do painel aceitou a extensão (HTTP ${res.status}) do usuário ${args.iptvUser} por ${args.days} dias (${credits} crédito${credits > 1 ? "s" : ""}).${shownBody ? ` Resposta da API: ${shownBody}` : ""}`,
      };
    }
    return {
      ok: false,
      detail: `A API do painel não concluiu a extensão do usuário ${args.iptvUser}: HTTP ${res.status}${failureMessage ? ` — ${failureMessage}` : ""}. ${shownBody ? `Resposta da API: ${shownBody}. ` : ""}Nada foi dado como renovado. Confira caminho/método/corpo da extensão na aba Servidores.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail: `Não foi possível alcançar a API do painel para estender o usuário ${args.iptvUser}: ${sanitizePanelResponseBody(message, [server.apiToken, args.iptvPass], 300)}. Nada foi dado como renovado.`,
    };
  }
}

// Testa a autenticação da API do painel. A mensagem exata da API
// (HTTP 400 com "username should not be empty" / "password should not
// be empty") mostra que ela pede usuário e senha do painel nos campos
// username e password — não um token solto. Por isso o teste tenta
// PRIMEIRO as variações com {username, password} do painel salvo
// neste servidor e só depois as variações com o token salvo; se a
// API emitir um token na resposta, ele é guardado neste servidor
// para as chamadas de extensão (nunca exibido). HTTP 400 é erro de
// formato/campo, não "token errado". Só HTTP 2xx sem erro declarado
// no corpo marca conectado. Nenhum crédito é consumido.
type PanelAuthAttempt = {
  id: string;
  label: string;
  description: string;
  httpStatus: number | null;
  responseBody: string;
  error: string;
  success: boolean;
};

type PanelDiagnostic = {
  testedAt: string;
  endpoint: string;
  baseOriginal: string;
  baseNormalized: string;
  baseWarnings: string[];
  classification: string;
  headline: string;
  winningVariant: string;
  responseBody: string;
  attempts: PanelAuthAttempt[];
  steps: string[];
};

type PanelTestResult = {
  connected: boolean;
  detail: string;
  diagnostic: PanelDiagnostic;
  issuedToken?: string;
};

// Token emitido pela API na resposta de autenticação (campos comuns:
// token, accessToken, access_token, staticToken, static_token, ou
// dentro de data). Nunca é exibido: só é guardado no servidor.
function extractPanelIssuedToken(rawBody: string): string {
  try {
    const data = JSON.parse(rawBody) as unknown;
    const candidates: unknown[] = [];
    const walk = (value: unknown, depth: number): void => {
      if (depth > 3 || !value || typeof value !== "object") return;
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (/^(token|accesstoken|access_token|statictoken|static_token)$/i.test(key)) candidates.push(val);
        walk(val, depth + 1);
      }
    };
    walk(data, 0);
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length >= 10) return candidate.trim();
    }
  } catch {}
  return "";
}

function panelCorrectionSteps(classification: string): string[] {
  const common = [
    "Confira a base: ela deve ser somente o endereço da API, por exemplo https://mcapi.knewcms.com:2087, sem /auth/static-token no final e sem barra sobrando.",
    "A API deste painel pede usuário e senha do painel nos campos username e password. O gestor envia os que já estão salvos neste servidor — confira em Servidores → Editar se são o usuário e a senha do painel (não os de um cliente IPTV). Se a API emitir um token, o gestor guarda ele sozinho quando o teste passar.",
    "Se o painel emitir um token estático separado, cole somente ele no campo “Token da API do painel” (Opções avançadas). Não cole usuário/senha do painel, token do Mercado Pago, nem aspas ou espaços junto.",
    "Salve o servidor depois de trocar a base, o usuário, a senha ou o token e toque em “Testar conexão” de novo. O gestor só marca conectado quando uma variação responder sucesso.",
  ];
  if (classification === "http_400_formato_ou_campo") {
    return [
      "Leia primeiro a mensagem exata da API mostrada abaixo: no HTTP 400, ela costuma dizer qual campo faltou ou qual formato foi recusado.",
      ...common,
      "Se todas as variações voltarem HTTP 400, o painel está pedindo um formato diferente do token estático conhecido. Não continue trocando a senha do painel: o problema é a chamada de autenticação da API.",
    ];
  }
  if (classification === "token_recusado") {
    return [
      "A API respondeu, mas recusou a credencial. Confira o usuário e a senha do painel salvos neste servidor (Servidores → Editar) — a API pede os campos username e password.",
      ...common.slice(0, 3),
    ];
  }
  if (classification === "base_ou_caminho_errado") {
    return [
      "A API respondeu que o endereço/caminho não existe. Confira se a base é a da API (não o link da tela de login do painel) e se a porta está certa.",
      ...common,
    ];
  }
  if (classification === "sem_resposta") {
    return [
      "O gestor não recebeu resposta da API. Confira se a base e a porta estão certas e se o painel está fora do ar; tente novamente em alguns minutos.",
      ...common.slice(0, 2),
    ];
  }
  return common;
}

async function panelTestConnection(
  apiBase: string,
  token: string,
  username = "",
  password = "",
): Promise<PanelTestResult> {
  const base = inspectPanelApiBase(apiBase);
  const testedAt = new Date().toISOString();
  const endpoint = base.valid ? `${base.normalized}/auth/static-token` : "";
  const makeDiagnostic = (
    classification: string,
    headline: string,
    attempts: PanelAuthAttempt[],
    winningVariant = "",
  ): PanelDiagnostic => {
    const withHttp = [...attempts].reverse().find((a) => a.httpStatus != null);
    return {
      testedAt,
      endpoint,
      baseOriginal: base.original,
      baseNormalized: base.normalized,
      baseWarnings: base.warnings,
      classification,
      headline,
      winningVariant,
      responseBody: withHttp?.responseBody ?? "",
      attempts,
      steps: panelCorrectionSteps(classification),
    };
  };

  if (!base.valid) {
    const diagnostic = makeDiagnostic("base_invalida", `Não conectou: ${base.error}`, []);
    return { connected: false, detail: diagnostic.headline, diagnostic };
  }
  const hasCredentials = username.trim().length > 0 && password.length > 0;
  if (!token && !hasCredentials) {
    const diagnostic = makeDiagnostic(
      "sem_credencial",
      "Não conectou: a API do painel pede usuário e senha do painel (campos username e password) e nenhum token está salvo para este servidor. Confira o usuário e a senha do painel salvos neste servidor e toque em “Testar conexão” de novo.",
      [],
    );
    return { connected: false, detail: diagnostic.headline, diagnostic };
  }

  const json = { "Content-Type": "application/json", Accept: "application/json" };
  const credentialBody = JSON.stringify({ username: username.trim(), password });
  const variants: Array<{
    id: string;
    label: string;
    description: string;
    headers: Record<string, string>;
    body?: string;
  }> = [
    // A API pede username + password: estas variações vão primeiro.
    ...(hasCredentials
      ? [
          {
            id: "json_username_password",
            label: "Corpo {username, password}",
            description: "Corpo JSON com os campos username e password do painel salvo neste servidor, sem cabeçalho de token.",
            headers: { ...json },
            body: credentialBody,
          },
          {
            id: "form_username_password",
            label: "Formulário {username, password}",
            description: "Corpo de formulário (application/x-www-form-urlencoded) com username e password do painel.",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ username: username.trim(), password }).toString(),
          },
          ...(token
            ? [
                {
                  id: "json_username_password_token",
                  label: "Corpo {username, password, token}",
                  description: "Corpo JSON com username, password e o token salvo.",
                  headers: { ...json },
                  body: JSON.stringify({ username: username.trim(), password, token }),
                },
                {
                  id: "json_username_password_bearer",
                  label: "Corpo {username, password} + Bearer",
                  description: "Corpo JSON com username e password, mais o cabeçalho Authorization: Bearer com o token salvo.",
                  headers: { ...json, Authorization: `Bearer ${token}` },
                  body: credentialBody,
                },
              ]
            : []),
        ]
      : []),
    // Variações só com o token salvo (só existem se houver token).
    ...(token
      ? [
    {
      id: "bearer_e_json_token",
      label: "Bearer + corpo {token}",
      description: "Authorization: Bearer com o token e corpo JSON com o campo token (forma usada antes).",
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ token }),
    },
    {
      id: "json_token_sem_bearer",
      label: "Só corpo {token}",
      description: "Corpo JSON com o campo token, sem o cabeçalho Authorization.",
      headers: { ...json },
      body: JSON.stringify({ token }),
    },
    {
      id: "bearer_sem_corpo",
      label: "Só Bearer, sem corpo",
      description: "Somente o cabeçalho Authorization: Bearer, sem corpo JSON.",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    },
    {
      id: "x_static_token",
      label: "Cabeçalho X-Static-Token",
      description: "Token no cabeçalho X-Static-Token e também no corpo JSON {token}.",
      headers: { ...json, "X-Static-Token": token },
      body: JSON.stringify({ token }),
    },
    {
      id: "x_api_key",
      label: "Cabeçalho X-API-Key",
      description: "Token somente no cabeçalho X-API-Key, sem corpo.",
      headers: { Accept: "application/json", "X-API-Key": token },
    },
    {
      id: "form_token",
      label: "Formulário token",
      description: "Corpo de formulário (application/x-www-form-urlencoded) com o campo token e Bearer.",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams({ token }).toString(),
    },
    {
      id: "json_staticToken",
      label: "Corpo {staticToken}",
      description: "Corpo JSON com o campo staticToken (camelCase) e Bearer.",
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ staticToken: token }),
    },
    {
      id: "json_static_token",
      label: "Corpo {static_token}",
      description: "Corpo JSON com o campo static_token e Bearer.",
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ static_token: token }),
    },
    {
      id: "json_access_token",
      label: "Corpo {access_token}",
      description: "Corpo JSON com o campo access_token e Bearer.",
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ access_token: token }),
    },
      ]
      : []),
  ];

  const attempts: PanelAuthAttempt[] = [];
  for (const variant of variants) {
    let attempt: PanelAuthAttempt;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: variant.headers,
        body: variant.body,
        signal: AbortSignal.timeout(10000),
      });
      const rawBody = await res.text().catch(() => "");
      const failureMessage = panelResponseFailureMessage(rawBody);
      const success = res.ok && !failureMessage;
      attempt = {
        id: variant.id,
        label: variant.label,
        description: variant.description,
        httpStatus: res.status,
        responseBody: sanitizePanelResponseBody(rawBody, [token, password], 500),
        error: failureMessage ?? "",
        success,
      };
      attempts.push(attempt);
      if (success) {
        const issuedToken = extractPanelIssuedToken(rawBody);
        const headline = issuedToken
          ? `Conectou: a variação “${variant.label}” foi aceita pela API do painel (HTTP ${res.status}). A API emitiu um token, que o gestor guardou neste servidor (sem exibir) para as chamadas de extensão. O painel passa a ser tratado como conectado neste gestor.`
          : `Conectou: a variação “${variant.label}” foi aceita pela API do painel (HTTP ${res.status}). O painel passa a ser tratado como conectado neste gestor.`;
        const diagnostic = makeDiagnostic("conectado", headline, attempts, variant.label);
        return { connected: true, detail: headline, diagnostic, issuedToken: issuedToken || undefined };
      }
      if (res.status === 429) break;
    } catch (e) {
      const rawMessage = e instanceof Error ? e.message : String(e);
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || /timed out|timeout/i.test(rawMessage));
      attempt = {
        id: variant.id,
        label: variant.label,
        description: variant.description,
        httpStatus: null,
        responseBody: "",
        error: timedOut
          ? "A API não respondeu dentro de 10 segundos."
          : `Não houve resposta da API: ${sanitizePanelResponseBody(rawMessage, [token, password], 240)}`,
        success: false,
      };
      attempts.push(attempt);
      // Sem resposta de rede, repetir os outros formatos só repetiria a
      // mesma falha de alcance; paramos e classificamos como inacessível.
      break;
    }
  }

  const statuses = attempts.map((a) => a.httpStatus).filter((s): s is number => s != null);
  let classification = "falha_autenticacao";
  let headline = "Não conectou: nenhuma variação de autenticação foi aceita pela API do painel. A renovação continua pendente e nenhum crédito foi consumido.";
  if (statuses.length === 0) {
    classification = "sem_resposta";
    headline = "Não conectou: a API do painel não respondeu. Ela pode estar fora do ar, ou a base/porta salva leva a um endereço que não responde. A renovação continua pendente e nenhum crédito foi consumido.";
  } else if (statuses.includes(400)) {
    classification = "http_400_formato_ou_campo";
    headline = "Não conectou: a API respondeu HTTP 400. Isso é erro de formato/campo da chamada de autenticação (corpo, cabeçalho ou campo esperado), não prova de token errado. O gestor tentou as variações comuns uma de cada vez; veja a mensagem exata da API e cada tentativa abaixo. A renovação continua pendente e nenhum crédito foi consumido.";
  } else if (statuses.includes(401) || statuses.includes(403)) {
    classification = "token_recusado";
    headline = `Não conectou: a API recusou a credencial (HTTP ${statuses.includes(401) ? 401 : 403}). Confira o diagnóstico abaixo e gere um token estático novo se precisar. A renovação continua pendente e nenhum crédito foi consumido.`;
  } else if (statuses.includes(404)) {
    classification = "base_ou_caminho_errado";
    headline = "Não conectou: a API respondeu HTTP 404. A base ou a porta provavelmente leva a um endereço sem o endpoint /auth/static-token. A renovação continua pendente e nenhum crédito foi consumido.";
  } else if (statuses.some((s) => s >= 500)) {
    classification = "erro_servidor_painel";
    headline = `Não conectou: a API do painel respondeu erro interno (HTTP ${statuses.find((s) => s >= 500)}). Isso é falha do lado do painel neste momento. A renovação continua pendente e nenhum crédito foi consumido.`;
  } else if (statuses.includes(429)) {
    classification = "limite_de_tentativas";
    headline = "Não conectou: a API respondeu HTTP 429 (muitas tentativas). Espere alguns minutos antes de testar de novo. A renovação continua pendente e nenhum crédito foi consumido.";
  }
  const diagnostic = makeDiagnostic(classification, headline, attempts);
  return { connected: false, detail: headline, diagnostic };
}


// ---------------- WhatsApp por QR Code (único caminho) ----------------
// O pareamento é feito pelo serviço de sessão interno do gestor
// (módulo privilegiado): um processo persistente por conta que fala
// com o WhatsApp e devolve o QR Code real. O estado abaixo é só o
// espelho gravado do que o serviço informou — QR nunca é inventado.

type WaServiceStatus = {
  running: boolean;
  status: string;
  phone: string;
  qrImage: string;
  detail: string;
  updatedAt: number;
};

function mapWaServiceStatus(st: WaServiceStatus): {
  status: string;
  phone: string;
  detail: string;
  image: string;
} {
  switch (st.status) {
    case "conectado":
      return {
        status: "conectado",
        phone: st.phone,
        detail:
          st.detail ||
          "WhatsApp conectado pelo QR Code. Ele fica conectado até você desconectar aqui no gestor.",
        image: "",
      };
    case "aguardando_leitura":
      return {
        status: "aguardando_leitura",
        phone: "",
        detail:
          st.detail ||
          "QR Code pronto: abra o WhatsApp do celular em Aparelhos conectados e leia o código.",
        image: st.qrImage,
      };
    case "iniciando":
      return {
        status: "gerando",
        phone: "",
        detail: st.detail || "Gerando um QR Code novo para você ler com o celular…",
        image: "",
      };
    case "erro":
      return {
        status: "indisponivel",
        phone: "",
        detail:
          st.detail ||
          "O serviço de sessão do WhatsApp não conseguiu abrir a conexão. Toque em “Gerar QR Code” para tentar de novo.",
        image: "",
      };
    default:
      return {
        status: "desconectado",
        phone: "",
        detail:
          st.detail ||
          "WhatsApp desconectado. Toque em “Gerar QR Code” e leia o código com o celular.",
        image: "",
      };
  }
}

function qrStateFromSettings(s: SettingsObj): z.infer<typeof qrWhatsappResponse> {
  return {
    status: s.waQrStatus || "desconectado",
    phone: s.waQrPhone,
    detail: s.waQrDetail,
    imageDataUrl: s.waQrImage ? s.waQrImage : null,
    updatedAt: s.waQrUpdatedAt,
  };
}

async function persistQrState(
  ctx: Ctx,
  ownerId: number,
  patch: { status: string; phone?: string; detail: string; image?: string },
): Promise<z.infer<typeof qrWhatsappResponse>> {
  const now = Date.now();
  const qrPatch: {
    waQrStatus: string;
    waQrDetail: string;
    waQrUpdatedAt: number;
    whatsappStatus: "desconectado" | "conectado";
    waQrPhone?: string;
    waQrImage?: string;
  } = {
    waQrStatus: patch.status,
    waQrDetail: patch.detail,
    waQrUpdatedAt: now,
    whatsappStatus: patch.status === "conectado" ? "conectado" : "desconectado",
  };
  if (patch.phone !== undefined) qrPatch.waQrPhone = patch.phone;
  if (patch.image !== undefined) qrPatch.waQrImage = patch.image;
  await persistSettings(ctx, ownerId, qrPatch);
  const s = await loadSettings(ctx, ownerId);
  return qrStateFromSettings(s);
}

// Aplica a renovação de UM pagamento aprovado. Só é chamada no modo
// produção (modo ao vivo ligado + pagamento real confirmado no Mercado
// Pago). Renova SOMENTE o usuário IPTV exato deste cliente, somando os
// dias do plano a partir de hoje; créditos = dias/30.
async function applyRenewal(
  ctx: Ctx,
  client: typeof schema.clients.$inferSelect,
  plan: typeof schema.plans.$inferSelect,
  amountCents: number,
  source: string,
): Promise<{ renewalId: number; newExpires: Date; message: string }> {
  const db = ctx.db<typeof schema>();
  const settingsObj = await loadSettings(ctx, client.ownerId);
  const credits = creditsForDays(plan.days);
  const now = new Date();
  const newExpires = new Date(now.getTime() + plan.days * 24 * 60 * 60 * 1000);
  const message = renderTemplate(settingsObj.renewedMessage, {
    nome: client.name,
    usuario: client.iptvUser,
    vencimento: fmtDate(client.expiresAt),
    novoVencimento: fmtDate(newExpires),
    dias: plan.days,
    valor: fmtBRL(amountCents),
    plano: plan.name,
  });
  const inserted = await db
    .insert(schema.renewals)
    .values({
      ownerId: client.ownerId,
      clientId: client.id,
      clientName: client.name,
      iptvUser: client.iptvUser,
      planName: plan.name,
      days: plan.days,
      credits,
      amountCents,
      oldExpiresAt: client.expiresAt,
      newExpiresAt: newExpires,
      source,
      message,
    })
    .returning({ id: schema.renewals.id });
  const renewal = inserted[0];
  if (!renewal) throw new Error("applyRenewal: insert returned no rows");
  await db
    .update(schema.clients)
    .set({ expiresAt: newExpires, status: "ativo" })
    .where(eq(schema.clients.id, client.id));
  // Consumo real de créditos do servidor do cliente: a renovação foi
  // aplicada, então o saldo desce pelos créditos do plano — multiplicado
  // pelo número de telas quando o servidor cobra por telas. O saldo
  // nunca fica negativo e cada consumo fica no controle de créditos.
  if (client.serverId != null) {
    const serverRows = await db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.id, client.serverId));
    const server = serverRows[0];
    if (server) {
      const multiplier =
        server.chargeByScreens === 1 && client.screens != null && client.screens > 0
          ? client.screens
          : 1;
      const consumed = credits * multiplier;
      if (consumed > 0) {
        const newBalance = Math.max(0, (server.creditsBalance ?? 0) - consumed);
        const realDelta = newBalance - (server.creditsBalance ?? 0);
        await db
          .update(schema.servers)
          .set({ creditsBalance: newBalance })
          .where(eq(schema.servers.id, server.id));
        if (realDelta !== 0) {
          await db.insert(schema.serverCreditLogs).values({
            ownerId: client.ownerId,
            serverId: server.id,
            delta: realDelta,
            balanceAfter: newBalance,
            note: `Renovação de ${client.name} (${plan.days} dias${multiplier > 1 ? ` × ${multiplier} telas` : ""})`,
          });
        }
      }
    }
  }
  return { renewalId: renewal.id, newExpires, message };
}

// Envia a mensagem de confirmação da renovação pelo WhatsApp conectado
// por QR Code, logo depois de um pagamento real confirmado. Nunca
// trava nem desfaz a renovação: se o WhatsApp não estiver conectado,
// sem número ou sem resposta, volta só o motivo em texto simples,
// que fica registrado no detalhe da cobrança.
async function sendRenewalConfirmation(
  ctx: Ctx,
  client: typeof schema.clients.$inferSelect,
  message: string,
): Promise<string> {
  const to = (client.whatsapp ?? "").replace(/\D/g, "");
  if (!to) {
    return "Mensagem de confirmação não enviada: este cliente não tem número de WhatsApp cadastrado.";
  }
  try {
    const result = await ctx.executePrivileged(privileged.waSend, {
      accountId: client.ownerId,
      to,
      text: message,
    });
    return result.sent
      ? "Mensagem de confirmação enviada automaticamente pelo WhatsApp ✓"
      : `Mensagem de confirmação não enviada: ${result.detail}`;
  } catch (e) {
    return `Mensagem de confirmação não enviada: ${String(e)}`;
  }
}

// Executa (ou bloqueia) a extensão automática de um cliente respeitando
// as configurações do servidor dele: o interruptor "Renovação
// automática no painel", o modo de integração (nenhuma/própria/
// vinculada) e o teste de autenticação da API. Quando algo impede, o
// detalhe explica o motivo — nada é dado como renovado.
async function panelExtendForClient(
  ctx: Ctx,
  client: typeof schema.clients.$inferSelect,
  days: number,
): Promise<{
  panelServer: typeof schema.servers.$inferSelect | null;
  extend: { ok: boolean; detail: string };
}> {
  const db = ctx.db<typeof schema>();
  let own: typeof schema.servers.$inferSelect | undefined;
  if (client.serverId != null) {
    const rows = await db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.id, client.serverId));
    own = rows[0];
  }
  if (own) {
    if (own.autoRenewEnabled !== 1) {
      return {
        panelServer: null,
        extend: {
          ok: false,
          detail: `A renovação automática está desligada nas configurações do servidor “${own.name}”. Ligue o interruptor “Renovação automática no painel” em Servidores → Editar para o gestor estender sozinho. Por enquanto, nada foi renovado no painel e nenhum crédito foi consumido.`,
        },
      };
    }
    if ((own.integrationMode ?? "propria") === "nenhuma") {
      return {
        panelServer: null,
        extend: {
          ok: false,
          detail: `O servidor “${own.name}” está sem integração com o painel IPTV selecionada. Escolha uma integração em Servidores → Editar para a renovação automática funcionar. Nada foi renovado e nenhum crédito foi consumido.`,
        },
      };
    }
    if ((own.integrationMode ?? "propria") === "vinculada") {
      // Integração vinculada = um painel cadastrado na aba Integrações
      // (provider WPlay) desta mesma conta. Ela fornece URL, usuário e
      // senha do painel; a chamada de extensão usa a configuração de
      // API/extensão salva neste servidor apontando para essa URL.
      const linkedRows = own.panelIntegrationId != null
        ? await db
            .select()
            .from(schema.integrations)
            .where(eq(schema.integrations.id, own.panelIntegrationId))
        : [];
      const linked = linkedRows[0];
      if (!linked || linked.ownerId !== client.ownerId) {
        return {
          panelServer: null,
          extend: {
            ok: false,
            detail: `O servidor “${own.name}” está no modo de integração vinculada, mas nenhuma integração válida desta conta está vinculada a ele. Vincule um painel em Integrações ou em Servidores → Editar. Nada foi renovado e nenhum crédito foi consumido.`,
          },
        };
      }
      if (!own.apiToken || own.apiVerified !== 1) {
        return {
          panelServer: null,
          extend: {
            ok: false,
            detail: `A integração “${linked.name}” está vinculada ao servidor “${own.name}”, mas o teste de conexão da API do painel ainda não passou para este servidor — a renovação fica pendente e nenhum crédito foi consumido. Confira o diagnóstico em Servidores.`,
          },
        };
      }
      const effective = {
        ...own,
        panelUrl: linked.url,
        panelUser: linked.panelUser,
        panelPass: linked.panelPass,
        apiBase: own.apiBase || linked.url,
      };
      const extend = await panelExtendUser(effective, {
        iptvUser: client.iptvUser,
        iptvPass: client.iptvPass,
        days,
      });
      return { panelServer: own, extend };
    }
    // Modo "própria": a renovação usa a conexão DESTE servidor (o do
    // próprio cliente) e estende o usuário IPTV exato do cliente, com
    // o usuário/senha IPTV guardados no cadastro dele. A base da API
    // é a configurada no servidor ou, no cadastro simples, o próprio
    // link do painel. Se a API responder erro (ex.: HTTP 400) ou
    // exigir um token que não está salvo, a extensão volta como
    // pendente com o motivo — nada é dado como renovado e nenhum
    // crédito é consumido.
    const effective = { ...own, apiBase: own.apiBase || own.panelUrl };
    const extend = await panelExtendUser(effective, {
      iptvUser: client.iptvUser,
      iptvPass: client.iptvPass,
      days,
    });
    return { panelServer: own, extend };
  }
  const panelServer = await resolvePanelServer(ctx, client);
  if (!panelServer) {
    return {
      panelServer: null,
      extend: {
        ok: false,
        detail:
          "Nenhum servidor com a API do painel conectada (teste de autenticação aprovado) foi encontrado para este cliente.",
      },
    };
  }
  const extend = await panelExtendUser(panelServer, {
    iptvUser: client.iptvUser,
    iptvPass: client.iptvPass,
    days,
  });
  return { panelServer, extend };
}

async function loadClientAndPlan(ctx: Ctx, clientId: number) {
  const db = ctx.db<typeof schema>();
  const clientRows = await db
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId));
  const client = clientRows[0];
  if (!client) throw new Error("Cliente não encontrado.");
  if (client.planId == null) {
    throw new Error(
      "Este cliente está sem plano. Edite o cliente e escolha um plano antes de gerar o Pix.",
    );
  }
  const planRows = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.id, client.planId));
  const plan = planRows[0];
  if (!plan) throw new Error("Plano do cliente não encontrado.");
  return { client, plan };
}

type MpCreateResult =
  | { kind: "created"; mpPaymentId: string; pixCode: string | null; status: string }
  | { kind: "failed"; detail: string };

// Chama a API real do Mercado Pago para criar uma cobrança Pix com o
// access token salvo pela dona do gestor. Nunca inclui o token em erros.
async function mpCreatePix(
  token: string,
  args: { amountCents: number; clientName: string; clientId: number; payerEmail: string },
): Promise<MpCreateResult> {
  // A API do Mercado Pago exige payer.email em formato válido e
  // recusava o antigo "cliente@gestor-iptv.local" ("payer.email must
  // be a valid email") — era isso que impedia qualquer Pix de ser
  // gerado. O e-mail usado é o da própria conta do Mercado Pago da
  // dona do gestor (lido de /users/me); o reserva abaixo só entra se
  // a conta não devolver e-mail nenhum, e mantém o formato válido.
  const payerEmail =
    args.payerEmail && /.+@.+\..+/.test(args.payerEmail)
      ? args.payerEmail
      : `cliente${args.clientId}@gestor-iptv.com`;
  try {
    const res = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `gestor-${args.clientId}-${Date.now()}`,
      },
      body: JSON.stringify({
        transaction_amount: args.amountCents / 100,
        description: `Renovação IPTV — ${args.clientName}`,
        payment_method_id: "pix",
        external_reference: `gestor-cliente-${args.clientId}`,
        metadata: { gestor_client_id: args.clientId },
        payer: { email: payerEmail },
      }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "message" in data
          ? String((data as { message: unknown }).message)
          : `HTTP ${res.status}`;
      return {
        kind: "failed",
        detail: `O Mercado Pago recusou a criação da cobrança: ${msg}. Confira o access token e o ambiente (teste/produção) na aba Pagamentos.`,
      };
    }
    const d = data as {
      id?: number | string;
      status?: string;
      point_of_interaction?: {
        transaction_data?: { qr_code?: string };
      };
    };
    return {
      kind: "created",
      mpPaymentId: d.id != null ? String(d.id) : "",
      pixCode: d.point_of_interaction?.transaction_data?.qr_code ?? null,
      status: d.status ?? "pending",
    };
  } catch {
    return {
      kind: "failed",
      detail:
        "Não foi possível falar com o Mercado Pago a partir do gestor nesta tentativa. A cobrança ficou registrada como falha — nenhum Pix foi gerado e nada foi cobrado. Tente de novo em alguns instantes.",
    };
  }
}

async function mpGetPaymentStatus(
  token: string,
  mpPaymentId: string,
): Promise<{ ok: boolean; status: string; detail: string }> {
  try {
    const res = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(mpPaymentId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return {
        ok: false,
        status: "",
        detail: `O Mercado Pago respondeu HTTP ${res.status} ao consultar o pagamento.`,
      };
    }
    const data = (await res.json()) as { status?: string };
    return { ok: true, status: data.status ?? "", detail: "" };
  } catch {
    return {
      ok: false,
      status: "",
      detail: "Não foi possível consultar o Mercado Pago nesta tentativa.",
    };
  }
}

async function mpTestConnection(
  token: string,
): Promise<{ connected: boolean; accountLabel: string; email: string; detail: string }> {
  try {
    const res = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "message" in data
          ? String((data as { message: unknown }).message)
          : `HTTP ${res.status}`;
      return {
        connected: false,
        accountLabel: "",
        email: "",
        detail: `O Mercado Pago não aceitou a consulta com este access token: ${msg}.`,
      };
    }
    const d = data as { id?: number | string; nickname?: string; email?: string };
    return {
      connected: true,
      accountLabel: d.nickname
        ? String(d.nickname)
        : d.id != null
          ? `Conta Mercado Pago #${String(d.id)}`
          : "Conta Mercado Pago",
      email: d.email ? String(d.email) : "",
      detail: "Access token aceito pelo Mercado Pago. A conta está pronta para criar cobranças Pix neste ambiente.",
    };
  } catch {
    return {
      connected: false,
      accountLabel: "",
      email: "",
      detail:
        "Não foi possível alcançar o Mercado Pago a partir do gestor nesta tentativa. Nada foi alterado; tente testar novamente em alguns instantes.",
    };
  }
}

// Sonda real de um painel IPTV pela URL: segue redirecionamentos e
// devolve status HTTP, tempo, título da página e servidor web. Não
// inventa nada: se a rede ou o painel falharem, o erro vai no detail.
async function probePanelUrl(
  rawUrl: string,
): Promise<{
  reachable: boolean;
  httpStatus: number;
  finalUrl: string;
  title: string;
  serverHeader: string;
  ms: number;
  error: string;
}> {
  const started = Date.now();
  try {
    const res = await fetch(rawUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
      headers: { Accept: "text/html,application/json" },
    });
    const text = await res.text().catch(() => "");
    const titleMatch = text.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    return {
      reachable: res.status < 500,
      httpStatus: res.status,
      finalUrl: res.url || rawUrl,
      title: titleMatch?.[1]?.trim() ?? "",
      serverHeader: res.headers.get("server") ?? "",
      ms: Date.now() - started,
      error: res.status >= 500 ? `o painel respondeu HTTP ${res.status}` : "",
    };
  } catch (e) {
    return {
      reachable: false,
      httpStatus: 0,
      finalUrl: rawUrl,
      title: "",
      serverHeader: "",
      ms: Date.now() - started,
      error:
        e instanceof Error
          ? `não houve resposta do painel (${e.message})`
          : "não houve resposta do painel",
    };
  }
}

// Tenta a API pública estilo Xtream (player_api.php) com o usuário e a
// senha SALVOS da integração. Só devolve auth_ok quando o painel
// confirma o login (user_info.auth === 1) — é essa confirmação que o
// Sync IDs e o teste de login usam.
async function probeXtreamApi(
  baseUrl: string,
  user: string,
  pass: string,
): Promise<{ kind: "auth_ok" | "auth_fail" | "unavailable"; info: string }> {
  try {
    const base = baseUrl.replace(/\/+$/, "");
    const url = `${base}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { kind: "unavailable", info: "" };
    const data: unknown = await res.json().catch(() => null);
    if (!data || typeof data !== "object" || !("user_info" in data)) {
      return { kind: "unavailable", info: "" };
    }
    const ui = (data as { user_info?: Record<string, unknown> }).user_info ?? {};
    if (Number(ui.auth) !== 1) return { kind: "auth_fail", info: "" };
    const parts: string[] = [];
    if (ui.username) parts.push(`usuário ${String(ui.username)}`);
    if (ui.status) parts.push(`status ${String(ui.status)}`);
    if (ui.exp_date) {
      const exp = new Date(Number(ui.exp_date) * 1000);
      if (!Number.isNaN(exp.getTime())) parts.push(`validade ${fmtDate(exp)}`);
    }
    if (ui.max_connections != null) parts.push(`conexões máximas ${String(ui.max_connections)}`);
    if (ui.created_at) {
      const created = new Date(Number(ui.created_at) * 1000);
      if (!Number.isNaN(created.getTime())) parts.push(`criado em ${fmtDate(created)}`);
    }
    return { kind: "auth_ok", info: parts.join(" • ") };
  } catch {
    return { kind: "unavailable", info: "" };
  }
}

// Teste de conexão SIMPLES de um servidor: usa só link do painel +
// usuário + senha (igual ao gestor que a dona usa). Conectado exige o
// painel respondendo no link e, quando o painel oferece a API pública
// de login (player_api), o login confirmado; se a API recusar o
// usuário/senha, NÃO marca conectado. Quando o painel não oferece
// essa confirmação automática, "conectado" significa: o painel
// respondeu neste link e as credenciais ficaram salvas — o detalhe
// diz isso com todas as letras, sem fingir uma confirmação que o
// painel não deu.
async function probeServerConnection(
  panelUrl: string,
  panelUser: string,
  panelPass: string,
): Promise<{ connected: boolean; detail: string }> {
  const probe = await probePanelUrl(panelUrl);
  if (!probe.reachable) {
    return {
      connected: false,
      detail:
        probe.httpStatus >= 500
          ? `Não conectou: o painel respondeu com erro (HTTP ${probe.httpStatus}). Tente de novo em alguns minutos; se continuar assim, confira o link do painel.`
          : "Não conectou: não houve resposta do painel neste link. Confira o link do painel — copie o endereço exatamente como você abre o painel — e tente de novo.",
    };
  }
  const xtream = await probeXtreamApi(panelUrl, panelUser, panelPass);
  if (xtream.kind === "auth_fail") {
    return {
      connected: false,
      detail:
        "Não conectou: o painel respondeu neste link, mas recusou este usuário e senha. Confira o usuário e a senha de acesso ao painel e salve de novo.",
    };
  }
  if (xtream.kind === "auth_ok") {
    return {
      connected: true,
      detail: `Conectado: o painel respondeu (HTTP ${probe.httpStatus}) e confirmou o login deste usuário.${xtream.info ? ` Dados da conta no painel: ${xtream.info}.` : ""}`,
    };
  }
  return {
    connected: true,
    detail: `Conectado: o painel respondeu (HTTP ${probe.httpStatus}) neste link e o usuário e a senha ficaram salvos no gestor para as renovações. Este painel não confirma o login automaticamente pela API pública, então se uma renovação falhar por credencial, o motivo aparece aqui e na cobrança — nada é dado como renovado sem confirmação.`,
  };
}

const paymentShape = z.object({
  id: z.number(),
  clientId: z.number(),
  clientName: z.string(),
  amountCents: z.number(),
  days: z.number(),
  credits: z.number(),
  mode: z.string(),
  status: z.string(),
  mpPaymentId: z.string().nullable(),
  pixCode: z.string().nullable(),
  couponCode: z.string().nullable(),
  discountCents: z.number(),
  detail: z.string(),
  wouldExpireAt: z.string().nullable(),
  appliedRenewalId: z.number().nullable(),
  createdAt: z.string(),
});

const panelAttemptSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  httpStatus: z.number().nullable(),
  responseBody: z.string(),
  error: z.string(),
  success: z.boolean(),
});

const panelDiagnosticSchema = z.object({
  testedAt: z.string(),
  endpoint: z.string(),
  baseOriginal: z.string(),
  baseNormalized: z.string(),
  baseWarnings: z.array(z.string()),
  classification: z.string(),
  headline: z.string(),
  winningVariant: z.string(),
  responseBody: z.string(),
  attempts: z.array(panelAttemptSchema),
  steps: z.array(z.string()),
});

const panelTestResponse = z.object({
  connected: z.boolean(),
  detail: z.string(),
  diagnostic: panelDiagnosticSchema,
});

function parsePanelDiagnostic(raw: string): z.infer<typeof panelDiagnosticSchema> | null {
  if (!raw) return null;
  try {
    const parsed = panelDiagnosticSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const qrWhatsappResponse = z.object({
  status: z.string(),
  phone: z.string(),
  detail: z.string(),
  imageDataUrl: z.string().nullable(),
  updatedAt: z.number(),
});

const stateResponse = z.object({
  servers: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      panelUrl: z.string(),
      panelUser: z.string(),
      hasPass: z.boolean(),
      panelConnected: z.boolean(),
      panelConnectionDetail: z.string(),
      panelConnectionTestedAt: z.string().nullable(),
      apiBase: z.string(),
      hasApiToken: z.boolean(),
      apiVerified: z.boolean(),
      apiStatusDetail: z.string(),
      apiDiagnostic: panelDiagnosticSchema.nullable(),
      extendPath: z.string(),
      extendMethod: z.string(),
      extendBody: z.string(),
      extendVerified: z.boolean(),
      extendStatusDetail: z.string(),
      identifier: z.string(),
      initialCredits: z.number(),
      creditsBalance: z.number(),
      costPerCreditCents: z.number(),
      chargeByScreens: z.boolean(),
      notes: z.string(),
      active: z.boolean(),
      integrationMode: z.string(),
      integrationServerId: z.number().nullable(),
      panelIntegrationId: z.number().nullable(),
      autoRenewEnabled: z.boolean(),
      sendVia: z.string(),
      appName: z.string(),
      appDownloadUrl: z.string(),
      downloaderCode: z.string(),
      serverUrl: z.string(),
      serverUrlBackup: z.string(),
      epgUrl: z.string(),
      pixEnabled: z.boolean(),
      pixInstructions: z.string(),
    }),
  ),
  creditLogs: z.array(
    z.object({
      id: z.number(),
      serverId: z.number(),
      serverName: z.string(),
      delta: z.number(),
      balanceAfter: z.number(),
      note: z.string(),
      createdAt: z.string(),
    }),
  ),
  integrations: z.array(
    z.object({
      id: z.number(),
      provider: z.string(),
      name: z.string(),
      url: z.string(),
      panelUser: z.string(),
      hasPass: z.boolean(),
      status: z.string(),
      testDetail: z.string(),
      testedAt: z.string().nullable(),
      panelInfo: z.string(),
      syncDetail: z.string(),
      syncedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  accountEmail: z.string(),
  plans: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      days: z.number(),
      credits: z.number(),
      priceCents: z.number(),
    }),
  ),
  clients: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      whatsapp: z.string().nullable(),
      iptvUser: z.string(),
      hasPass: z.boolean(),
      serverId: z.number().nullable(),
      serverName: z.string().nullable(),
      planId: z.number().nullable(),
      planName: z.string().nullable(),
      planDays: z.number().nullable(),
      planCredits: z.number().nullable(),
      priceOverrideCents: z.number().nullable(),
      effectivePriceCents: z.number(),
      expiresAt: z.string(),
      status: z.string(),
      isTest: z.boolean(),
      referredBy: z.string().nullable(),
      app: z.string(),
      device: z.string(),
      screens: z.number().nullable(),
      source: z.string(),
      extraPanel: z.string(),
      listState: z.string(),
      invoiceToken: z.string(),
      createdAt: z.string(),
    }),
  ),
  renewals: z.array(
    z.object({
      id: z.number(),
      clientId: z.number(),
      clientName: z.string(),
      iptvUser: z.string(),
      planName: z.string(),
      days: z.number(),
      credits: z.number(),
      amountCents: z.number(),
      oldExpiresAt: z.string().nullable(),
      newExpiresAt: z.string(),
      source: z.string(),
      message: z.string(),
      createdAt: z.string(),
    }),
  ),
  payments: z.array(paymentShape),
  warnDays: z.array(z.number()),
  publicBaseUrl: z.string(),
  invoiceTitle: z.string(),
  invoiceMessage: z.string(),
  invoiceColor: z.string(),
  warnMessage: z.string(),
  warnSoonMessage: z.string(),
  renewedMessage: z.string(),
  expiredMessage: z.string(),
  chargeMessage: z.string(),
  mpConfigured: z.boolean(),
  mpPublicKeyMasked: z.string(),
  mpVerified: z.boolean(),
  mpAccountLabel: z.string(),
  mpEnvironment: z.string(),
  liveMode: z.boolean(),
  panelConnected: z.boolean(),
  panelStatus: z.string(),
  panelStatusDetail: z.string(),
  panelExtendReady: z.boolean(),
  panelExtendDetail: z.string(),
  whatsappStatus: z.string(),
  whatsappPhone: z.string(),
  qrWhatsappStatus: z.string(),
  qrWhatsappPhone: z.string(),
  qrWhatsappDetail: z.string(),
  qrWhatsappImage: z.string().nullable(),
  qrWhatsappUpdatedAt: z.number(),
  waBlockCalls: z.boolean(),
  waTranscribeAudio: z.boolean(),
  waAwayEnabled: z.boolean(),
  waAwayMessage: z.string(),
  expenses: z.array(
    z.object({
      id: z.number(),
      description: z.string(),
      amountCents: z.number(),
      spentOn: z.string(),
    }),
  ),
  coupons: z.array(
    z.object({
      id: z.number(),
      code: z.string(),
      percentOff: z.number(),
      active: z.boolean(),
    }),
  ),
});

export const Actions = {
  getState: defineAction({
    request: z.object({ session: sessionField }),
    response: stateResponse,
    async handler(ctx, args): Promise<z.infer<typeof stateResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const [serverRows, planRows, clientRows, renewalRows, paymentRows, expenseRows, couponRows, creditLogRows, integrationRows, accountRows, s, panel] =
        await Promise.all([
          db.select().from(schema.servers).where(eq(schema.servers.ownerId, ownerId)).orderBy(asc(schema.servers.id)),
          db.select().from(schema.plans).where(eq(schema.plans.ownerId, ownerId)).orderBy(asc(schema.plans.days)),
          db.select().from(schema.clients).where(eq(schema.clients.ownerId, ownerId)).orderBy(asc(schema.clients.expiresAt)),
          db.select().from(schema.renewals).where(eq(schema.renewals.ownerId, ownerId)).orderBy(desc(schema.renewals.id)).limit(100),
          db.select().from(schema.payments).where(eq(schema.payments.ownerId, ownerId)).orderBy(desc(schema.payments.id)).limit(100),
          db.select().from(schema.expenses).where(eq(schema.expenses.ownerId, ownerId)).orderBy(desc(schema.expenses.spentOn), desc(schema.expenses.id)),
          db.select().from(schema.coupons).where(eq(schema.coupons.ownerId, ownerId)).orderBy(asc(schema.coupons.id)),
          db.select().from(schema.serverCreditLogs).where(eq(schema.serverCreditLogs.ownerId, ownerId)).orderBy(desc(schema.serverCreditLogs.id)).limit(100),
          db.select().from(schema.integrations).where(eq(schema.integrations.ownerId, ownerId)).orderBy(asc(schema.integrations.id)),
          db.select().from(schema.accounts).where(eq(schema.accounts.id, ownerId)),
          loadSettings(ctx, ownerId),
          loadPanelStatus(ctx, ownerId),
        ]);
      const serverById = new Map<number, typeof schema.servers.$inferSelect>(serverRows.map((x) => [x.id, x]));
      const planById = new Map<number, typeof schema.plans.$inferSelect>(planRows.map((x) => [x.id, x]));
      const invoiceTokens = await ensureInvoiceTokens(ctx, clientRows);
      return {
        servers: serverRows.map((x) => ({
          id: x.id,
          name: x.name,
          panelUrl: x.panelUrl,
          panelUser: x.panelUser,
          hasPass: x.panelPass.length > 0,
          panelConnected: (x.panelConnected ?? 0) === 1,
          panelConnectionDetail: x.panelConnectionDetail ?? "",
          panelConnectionTestedAt: x.panelConnectionTestedAt
            ? new Date(x.panelConnectionTestedAt).toISOString()
            : null,
          apiBase: x.apiBase,
          hasApiToken: x.apiToken.length > 0,
          apiVerified: x.apiVerified === 1,
          apiStatusDetail: x.apiStatusDetail,
          apiDiagnostic: parsePanelDiagnostic(x.apiDiagnostic),
          extendPath: x.extendPath,
          extendMethod: x.extendMethod,
          extendBody: x.extendBody,
          extendVerified: x.extendVerified === 1,
          extendStatusDetail: x.extendStatusDetail,
          identifier: x.identifier ?? "",
          initialCredits: x.initialCredits ?? 0,
          creditsBalance: x.creditsBalance ?? 0,
          costPerCreditCents: x.costPerCreditCents ?? 0,
          chargeByScreens: x.chargeByScreens === 1,
          notes: x.notes ?? "",
          active: x.active !== 0,
          integrationMode: x.integrationMode ?? "propria",
          integrationServerId: x.integrationServerId ?? null,
          panelIntegrationId: x.panelIntegrationId ?? null,
          autoRenewEnabled: x.autoRenewEnabled === 1,
          sendVia: x.sendVia ?? "padrao",
          appName: x.appName ?? "",
          appDownloadUrl: x.appDownloadUrl ?? "",
          downloaderCode: x.downloaderCode ?? "",
          serverUrl: x.serverUrl ?? "",
          serverUrlBackup: x.serverUrlBackup ?? "",
          epgUrl: x.epgUrl ?? "",
          pixEnabled: x.pixEnabled !== 0,
          pixInstructions: x.pixInstructions ?? "",
        })),
        creditLogs: creditLogRows.map((l) => ({
          id: l.id,
          serverId: l.serverId,
          serverName: serverById.get(l.serverId)?.name ?? "Servidor removido",
          delta: l.delta,
          balanceAfter: l.balanceAfter,
          note: l.note,
          createdAt: l.createdAt.toISOString(),
        })),
        plans: planRows.map((x) => ({
          id: x.id,
          name: x.name,
          days: x.days,
          credits: creditsForDays(x.days),
          priceCents: x.priceCents,
        })),
        clients: clientRows.map((c) => {
          const plan = c.planId != null ? planById.get(c.planId) : undefined;
          const server = c.serverId != null ? serverById.get(c.serverId) : undefined;
          return {
            id: c.id,
            name: c.name,
            whatsapp: c.whatsapp ?? null,
            iptvUser: c.iptvUser,
            hasPass: c.iptvPass.length > 0,
            serverId: c.serverId ?? null,
            serverName: server?.name ?? null,
            planId: c.planId ?? null,
            planName: plan?.name ?? null,
            planDays: plan?.days ?? null,
            planCredits: plan ? creditsForDays(plan.days) : null,
            priceOverrideCents: c.priceOverrideCents ?? null,
            effectivePriceCents: c.priceOverrideCents ?? plan?.priceCents ?? 0,
            expiresAt: c.expiresAt.toISOString(),
            status: c.status,
            isTest: c.isTest === 1,
            referredBy: c.referredBy ?? null,
            app: c.app ?? "",
            device: c.device ?? "",
            screens: c.screens ?? null,
            source: c.source ?? "",
            extraPanel: c.extraPanel ?? "",
            listState: c.listState ?? "normal",
            invoiceToken: invoiceTokens.get(c.id) ?? c.invoiceToken ?? "",
            createdAt: c.createdAt.toISOString(),
          };
        }),
        renewals: renewalRows.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          clientName: r.clientName,
          iptvUser: r.iptvUser,
          planName: r.planName,
          days: r.days,
          credits: r.credits,
          amountCents: r.amountCents,
          oldExpiresAt: r.oldExpiresAt ? r.oldExpiresAt.toISOString() : null,
          newExpiresAt: r.newExpiresAt.toISOString(),
          source: r.source,
          message: r.message,
          createdAt: r.createdAt.toISOString(),
        })),
        payments: paymentRows.map((p) => ({
          id: p.id,
          clientId: p.clientId,
          clientName: p.clientName,
          amountCents: p.amountCents,
          days: p.days,
          credits: p.credits,
          mode: p.mode,
          status: p.status,
          mpPaymentId: p.mpPaymentId ?? null,
          pixCode: p.pixCode ?? null,
          couponCode: p.couponCode ?? null,
          discountCents: p.discountCents ?? 0,
          detail: p.detail,
          wouldExpireAt: p.wouldExpireAt ? p.wouldExpireAt.toISOString() : null,
          appliedRenewalId: p.appliedRenewalId ?? null,
          createdAt: p.createdAt.toISOString(),
        })),
        warnDays: s.warnDays,
        publicBaseUrl: s.publicBaseUrl,
        invoiceTitle: s.invoiceTitle,
        invoiceMessage: s.invoiceMessage,
        invoiceColor: s.invoiceColor,
        warnMessage: s.warnMessage,
        warnSoonMessage: s.warnSoonMessage,
        renewedMessage: s.renewedMessage,
        expiredMessage: s.expiredMessage,
        chargeMessage: s.chargeMessage,
        mpConfigured: s.mpAccessToken.length > 0,
        mpPublicKeyMasked: s.mpPublicKey ? `${s.mpPublicKey.slice(0, 14)}…` : "",
        mpVerified: s.mpVerified,
        mpAccountLabel: s.mpAccountLabel,
        mpEnvironment: s.mpEnvironment,
        liveMode: s.liveMode,
        panelConnected: panel.connected,
        panelStatus: panel.connected ? "conectado" : "nao_conectado",
        panelStatusDetail: panel.detail,
        panelExtendReady: panel.extendReady,
        panelExtendDetail: panel.extendDetail,
        whatsappStatus: s.waQrStatus === "conectado" ? "conectado" : "desconectado",
        whatsappPhone: s.whatsappPhone,
        qrWhatsappStatus: s.waQrStatus,
        qrWhatsappPhone: s.waQrPhone,
        qrWhatsappDetail: s.waQrDetail,
        qrWhatsappImage: s.waQrImage ? s.waQrImage : null,
        qrWhatsappUpdatedAt: s.waQrUpdatedAt,
        waBlockCalls: s.waBlockCalls,
        waTranscribeAudio: s.waTranscribeAudio,
        waAwayEnabled: s.waAwayEnabled,
        waAwayMessage: s.waAwayMessage,
        expenses: expenseRows.map((e) => ({
          id: e.id,
          description: e.description,
          amountCents: e.amountCents,
          spentOn: e.spentOn,
        })),
        coupons: couponRows.map((c) => ({
          id: c.id,
          code: c.code,
          percentOff: c.percentOff,
          active: c.active === 1,
        })),
        integrations: integrationRows.map((x) => ({
          id: x.id,
          provider: x.provider,
          name: x.name,
          url: x.url,
          panelUser: x.panelUser,
          hasPass: x.panelPass.length > 0,
          status: x.status,
          testDetail: x.testDetail,
          testedAt: x.testedAt ? new Date(x.testedAt).toISOString() : null,
          panelInfo: x.panelInfo,
          syncDetail: x.syncDetail,
          syncedAt: x.syncedAt ? new Date(x.syncedAt).toISOString() : null,
          createdAt: x.createdAt.toISOString(),
        })),
        accountEmail: accountRows[0]?.email ?? "", 
      };
    },
  }),

  // Página pública da fatura: abre SEM login do gestor, mas SOMENTE
  // com o código secreto do link da fatura daquele cliente
  // (#/fatura/<código>). O número sequencial do cliente não abre mais
  // a fatura — antes, trocar o número na URL mostrava a fatura de
  // outro cliente. Devolve SOMENTE os dados de fatura deste cliente:
  // nenhuma senha, nenhum outro cliente ou servidor.
  getInvoice: defineAction({
    request: z.object({ token: z.string().min(1).max(120) }),
    response: z.object({
      found: z.boolean(),
      clientId: z.number(),
      clientName: z.string(),
      iptvUser: z.string(),
      serverName: z.string().nullable(),
      planId: z.number().nullable(),
      planName: z.string().nullable(),
      planDays: z.number().nullable(),
      planCredits: z.number().nullable(),
      effectivePriceCents: z.number(),
      expiresAt: z.string(),
      invoiceTitle: z.string(),
      invoiceMessage: z.string(),
      invoiceColor: z.string(),
      mpConfigured: z.boolean(),
      mpVerified: z.boolean(),
      liveMode: z.boolean(),
      panelConnected: z.boolean(),
      whatsappConnected: z.boolean(),
      serverPixEnabled: z.boolean(),
      serverPixInstructions: z.string(),
      serverAppName: z.string().nullable(),
      serverAppDownloadUrl: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const token = args.token.trim();
      const preClient =
        token.length >= 20
          ? await db
              .select()
              .from(schema.clients)
              .where(eq(schema.clients.invoiceToken, token))
          : [];
      const foundClient = preClient[0];
      const invoiceOwnerId = foundClient?.ownerId ?? 0;
      const s = await loadSettings(ctx, invoiceOwnerId);
      const panel = await loadPanelStatus(ctx, invoiceOwnerId);
      const base = {
        found: false,
        clientId: foundClient?.id ?? 0,
        clientName: "",
        iptvUser: "",
        serverName: null,
        planId: null,
        planName: null,
        planDays: null,
        planCredits: null,
        effectivePriceCents: 0,
        expiresAt: new Date().toISOString(),
        invoiceTitle: s.invoiceTitle,
        invoiceMessage: s.invoiceMessage,
        invoiceColor: s.invoiceColor,
        mpConfigured: s.mpAccessToken.length > 0,
        mpPublicKeyMasked: s.mpPublicKey ? `${s.mpPublicKey.slice(0, 14)}…` : "",
        mpVerified: s.mpVerified,
        liveMode: s.liveMode,
        panelConnected: panel.connected,
        whatsappConnected: s.waQrStatus === "conectado",
        serverPixEnabled: true,
        serverPixInstructions: "",
        serverAppName: null,
        serverAppDownloadUrl: null,
      };
      const client = foundClient;
      if (!client) return base;
      let plan: typeof schema.plans.$inferSelect | undefined;
      if (client.planId != null) {
        const planRows = await db
          .select()
          .from(schema.plans)
          .where(eq(schema.plans.id, client.planId));
        plan = planRows[0];
      }
      let serverName: string | null = null;
      let serverPixEnabled = true;
      let serverPixInstructions = "";
      let serverAppName: string | null = null;
      let serverAppDownloadUrl: string | null = null;
      if (client.serverId != null) {
        const serverRows = await db
          .select()
          .from(schema.servers)
          .where(eq(schema.servers.id, client.serverId));
        const srv = serverRows[0];
        serverName = srv?.name ?? null;
        if (srv) {
          serverPixEnabled = srv.pixEnabled !== 0;
          serverPixInstructions = srv.pixInstructions ?? "";
          serverAppName = srv.appName ? srv.appName : null;
          serverAppDownloadUrl = srv.appDownloadUrl ? srv.appDownloadUrl : null;
        }
      }
      return {
        ...base,
        found: true,
        clientName: client.name,
        iptvUser: client.iptvUser,
        serverName,
        serverPixEnabled,
        serverPixInstructions,
        serverAppName,
        serverAppDownloadUrl,
        planId: client.planId ?? null,
        planName: plan?.name ?? null,
        planDays: plan?.days ?? null,
        planCredits: plan ? creditsForDays(plan.days) : null,
        effectivePriceCents: client.priceOverrideCents ?? plan?.priceCents ?? 0,
        expiresAt: client.expiresAt.toISOString(),
      };
    },
  }),

  saveServer: defineAction({
    // Cadastro simples, igual ao gestor que a dona usa: o formulário
    // principal pede APENAS link do painel, usuário e senha. Todo o
    // resto é opcional (fica nas "Opções avançadas" da tela): sem o
    // campo, o cadastro usa o padrão na criação e mantém o valor salvo
    // na edição. O nome, quando não informado, é derivado do link do
    // painel (o nome do host) para o servidor aparecer na lista.
    request: z.object({
      session: sessionField,
      id: z.number().int().positive().optional(),
      name: z.string().max(200).optional(),
      panelUrl: z.string().min(1).max(500),
      panelUser: z.string().min(1).max(200),
      panelPass: z.string().max(500),
      apiBase: z.string().max(500).optional(),
      apiToken: z.string().max(600).optional(),
      clearApiToken: z.boolean().optional(),
      extendPath: z.string().max(500).optional(),
      extendMethod: z.enum(["POST", "PUT", "PATCH", "GET"]).optional(),
      extendBody: z.string().max(2000).optional(),
      identifier: z.string().max(60).optional(),
      initialCredits: z.number().int().min(0).max(1000000).optional(),
      costPerCreditCents: z.number().int().min(0).max(100000000).optional(),
      chargeByScreens: z.boolean().optional(),
      notes: z.string().max(1000).optional(),
      integrationMode: z.enum(["nenhuma", "propria", "vinculada"]).optional(),
      panelIntegrationId: z.number().int().positive().nullable().optional(),
      autoRenewEnabled: z.boolean().optional(),
      sendVia: z.enum(["padrao", "whatsapp"]).optional(),
      appName: z.string().max(200).optional(),
      appDownloadUrl: z.string().max(500).optional(),
      downloaderCode: z.string().max(100).optional(),
      serverUrl: z.string().max(500).optional(),
      serverUrlBackup: z.string().max(500).optional(),
      epgUrl: z.string().max(500).optional(),
      pixEnabled: z.boolean().optional(),
      pixInstructions: z.string().max(1000).optional(),
    }),
    response: z.object({
      id: z.number(),
      connected: z.boolean(),
      connectionDetail: z.string(),
    }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();

      // --- Cadastro simples: só link, usuário e senha são exigidos ---
      let panelUrl = args.panelUrl.trim();
      if (panelUrl && !/^https?:\/\//i.test(panelUrl)) panelUrl = `https://${panelUrl}`;
      panelUrl = panelUrl.replace(/\/+$/, "");
      const panelUser = args.panelUser.trim();
      if (!panelUrl) throw new Error("Informe o link do painel.");
      if (!panelUser) throw new Error("Informe o usuário do painel.");

      const existingRows = args.id
        ? await db.select().from(schema.servers).where(eq(schema.servers.id, args.id))
        : [];
      const existing = existingRows[0];
      if (args.id && (!existing || existing.ownerId !== ownerId)) {
        throw new Error("Servidor não encontrado.");
      }
      if (!args.id && !args.panelPass) {
        throw new Error("Informe a senha do painel para acessar o servidor.");
      }
      const panelPass = args.panelPass ? args.panelPass : (existing?.panelPass ?? "");

      // Nome automático quando não informado: o host do link do painel
      // (ex.: "painel.seuservidor.com"). Dá para trocar depois em
      // Editar → Opções avançadas.
      let name = (args.name ?? "").trim();
      if (!name && existing) name = existing.name;
      if (!name) {
        try {
          name = new URL(panelUrl).hostname.replace(/^www\./, "") || panelUser;
        } catch {
          name = panelUser;
        }
      }

      // Campos avançados: sem o campo na chamada, a edição MANTÉM o
      // valor salvo e a criação usa o padrão.
      const keep = <T,>(value: T | undefined, saved: T | undefined, fallback: T): T =>
        value !== undefined ? value : saved !== undefined ? saved : fallback;
      const keepText = (value: string | undefined, saved: string | undefined, fallback = ""): string =>
        value !== undefined ? value.trim() : saved !== undefined ? saved : fallback;

      const integrationMode = keep(
        args.integrationMode,
        existing?.integrationMode as "nenhuma" | "propria" | "vinculada" | undefined,
        "propria",
      );
      const panelIntegrationId =
        integrationMode === "vinculada"
          ? keep(args.panelIntegrationId, existing?.panelIntegrationId, null)
          : null;
      if (integrationMode === "vinculada") {
        if (!panelIntegrationId) {
          throw new Error("Selecione qual integração de painel vincular, ou escolha “API deste servidor”.");
        }
        const intRows = await db
          .select()
          .from(schema.integrations)
          .where(eq(schema.integrations.id, panelIntegrationId));
        if (!intRows[0] || intRows[0].ownerId !== ownerId) {
          throw new Error("Integração de painel não encontrada nesta conta.");
        }
      }

      const apiBaseRaw = keepText(args.apiBase, existing?.apiBase);
      const baseCheck = inspectPanelApiBase(apiBaseRaw);
      if (apiBaseRaw && !baseCheck.valid) {
        throw new Error(`Base da API inválida: ${baseCheck.error}`);
      }
      const apiBase = apiBaseRaw ? baseCheck.normalized : "";
      const baseNote = baseCheck.warnings.length
        ? ` Correções/conferências da base: ${baseCheck.warnings.join(" ")}`
        : "";
      const clearApiToken = args.clearApiToken ?? false;
      const token = clearApiToken
        ? ""
        : args.apiToken !== undefined && args.apiToken.trim()
          ? args.apiToken.trim()
          : (existing?.apiToken ?? "");
      const extendPath = keepText(args.extendPath, existing?.extendPath, "/users/extend") || "/users/extend";
      const extendMethod = keep(args.extendMethod, existing?.extendMethod as "POST" | "PUT" | "PATCH" | "GET" | undefined, "POST");
      const extendBody = keep(
        args.extendBody,
        existing?.extendBody,
        '{"username":"{usuario}","days":{dias},"credits":{creditos}}',
      );
      const initialCredits = existing ? 0 : (args.initialCredits ?? 0);

      const extra = {
        identifier: keepText(args.identifier, existing?.identifier),
        costPerCreditCents: keep(args.costPerCreditCents, existing?.costPerCreditCents, 0),
        chargeByScreens: keep(args.chargeByScreens, existing ? existing.chargeByScreens === 1 : undefined, false) ? 1 : 0,
        notes: keepText(args.notes, existing?.notes),
        integrationMode,
        panelIntegrationId,
        // No cadastro simples (sem o campo), a renovação automática já
        // nasce ligada para usar esta conexão; nas Opções avançadas o
        // interruptor manda.
        autoRenewEnabled: keep(args.autoRenewEnabled, existing ? existing.autoRenewEnabled === 1 : undefined, true) ? 1 : 0,
        sendVia: keep(args.sendVia, existing?.sendVia as "padrao" | "whatsapp" | undefined, "padrao"),
        appName: keepText(args.appName, existing?.appName),
        appDownloadUrl: keepText(args.appDownloadUrl, existing?.appDownloadUrl),
        downloaderCode: keepText(args.downloaderCode, existing?.downloaderCode),
        serverUrl: keepText(args.serverUrl, existing?.serverUrl),
        serverUrlBackup: keepText(args.serverUrlBackup, existing?.serverUrlBackup),
        epgUrl: keepText(args.epgUrl, existing?.epgUrl),
        pixEnabled: keep(args.pixEnabled, existing ? existing.pixEnabled !== 0 : undefined, true) ? 1 : 0,
        pixInstructions: keepText(args.pixInstructions, existing?.pixInstructions),
      };

      // --- Teste REAL da conexão com link + usuário + senha ---
      const connection = await probeServerConnection(panelUrl, panelUser, panelPass);
      const connectionFields = {
        panelConnected: connection.connected ? 1 : 0,
        panelConnectionDetail: connection.detail,
        panelConnectionTestedAt: Date.now(),
      };

      if (existing) {
        const apiChanged = token !== existing.apiToken || apiBase !== existing.apiBase;
        const extendChanged =
          extendPath !== existing.extendPath ||
          extendMethod !== existing.extendMethod ||
          extendBody !== existing.extendBody;
        await db
          .update(schema.servers)
          .set({
            name,
            panelUrl,
            panelUser,
            panelPass,
            apiBase,
            apiToken: token,
            apiVerified: apiChanged ? 0 : existing.apiVerified,
            apiStatusDetail: apiChanged
              ? token
                ? `Token da API salvo. Toque em “Testar conexão” para validar a autenticação — a renovação fica pendente até o teste passar.${baseNote}`
                : baseNote
              : existing.apiStatusDetail,
            apiDiagnostic: apiChanged ? "" : existing.apiDiagnostic,
            extendPath,
            extendMethod,
            extendBody,
            extendVerified: apiChanged || extendChanged ? 0 : existing.extendVerified,
            extendStatusDetail:
              apiChanged || extendChanged
                ? "Extensão pendente: a configuração da extensão mudou. Um teste de extensão real (que renova e consome crédito) precisa passar para voltar a valer."
                : existing.extendStatusDetail,
            ...extra,
            ...connectionFields,
          })
          .where(eq(schema.servers.id, existing.id));
        ctx.invalidateQueries();
        return { id: existing.id, connected: connection.connected, connectionDetail: connection.detail };
      }
      const result = await db
        .insert(schema.servers)
        .values({
          ownerId,
          name,
          panelUrl,
          panelUser,
          panelPass,
          apiBase,
          apiToken: token,
          apiVerified: 0,
          apiStatusDetail: token
            ? `Token da API salvo. Toque em “Testar conexão” para validar a autenticação — a renovação fica pendente até o teste passar.${baseNote}`
            : baseNote,
          apiDiagnostic: "",
          extendPath,
          extendMethod,
          extendBody,
          extendVerified: 0,
          extendStatusDetail: "",
          initialCredits,
          creditsBalance: initialCredits,
          ...extra,
          ...connectionFields,
        })
        .returning({ id: schema.servers.id });
      const inserted = result[0];
      if (!inserted) throw new Error("saveServer: insert returned no rows");
      if (initialCredits > 0) {
        await db.insert(schema.serverCreditLogs).values({
          ownerId,
          serverId: inserted.id,
          delta: initialCredits,
          balanceAfter: initialCredits,
          note: "Créditos iniciais do cadastro do servidor",
        });
      }
      ctx.invalidateQueries();
      return { id: inserted.id, connected: connection.connected, connectionDetail: connection.detail };
    }
  }),

  // Recarga de créditos de um servidor: soma ao saldo atual e registra
  // a movimentação no controle detalhado de créditos.
  addServerCredits: defineAction({
    request: z.object({
      session: sessionField,
      serverId: z.number().int().positive(),
      amount: z.number().int().positive().max(1000000),
      note: z.string().max(300),
    }),
    response: z.object({ creditsBalance: z.number() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, args.serverId));
      const server = rows[0];
      if (!server || server.ownerId !== ownerId) throw new Error("Servidor não encontrado.");
      const newBalance = (server.creditsBalance ?? 0) + args.amount;
      await db
        .update(schema.servers)
        .set({ creditsBalance: newBalance })
        .where(eq(schema.servers.id, server.id));
      await db.insert(schema.serverCreditLogs).values({
        ownerId,
        serverId: server.id,
        delta: args.amount,
        balanceAfter: newBalance,
        note: args.note.trim() || "Recarga de créditos",
      });
      ctx.invalidateQueries();
      return { creditsBalance: newBalance };
    },
  }),

  // Liga/desliga um servidor (interruptor do cartão). Servidor
  // desligado continua visível e editável; o estado fica salvo.
  setServerActive: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive(),
      active: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, args.id));
      if (!rows[0] || rows[0].ownerId !== ownerId) throw new Error("Servidor não encontrado.");
      await db
        .update(schema.servers)
        .set({ active: args.active ? 1 : 0 })
        .where(eq(schema.servers.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Testa a conexão SIMPLES deste servidor com o link, o usuário e a
  // senha salvos (o mesmo teste que roda ao salvar). Atualiza o status
  // Conectado / Não conectou e o motivo em linguagem simples. A senha
  // nunca é devolvida.
  testServerConnection: defineAction({
    request: z.object({ session: sessionField, serverId: z.number().int().positive() }),
    response: z.object({ connected: z.boolean(), detail: z.string() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, args.serverId));
      const server = rows[0];
      if (!server || server.ownerId !== ownerId) throw new Error("Servidor não encontrado.");
      const result = await probeServerConnection(server.panelUrl, server.panelUser, server.panelPass);
      await db
        .update(schema.servers)
        .set({
          panelConnected: result.connected ? 1 : 0,
          panelConnectionDetail: result.detail,
          panelConnectionTestedAt: Date.now(),
        })
        .where(eq(schema.servers.id, server.id));
      ctx.invalidateQueries();
      return result;
    },
  }),

  // Testa a conexão com a API do painel usando o usuário e a senha do
  // painel salvos neste servidor (e o token, se houver). A resposta traz o diagnóstico completo (variações, HTTP,
  // corpo da API sem o token e passos de correção) — o token nunca é
  // devolvido. Enquanto o teste não passar, a renovação segue pendente.
  testPanelApi: defineAction({
    request: z.object({ session: sessionField, serverId: z.number().int().positive() }),
    response: panelTestResponse,
    async handler(ctx, args): Promise<z.infer<typeof panelTestResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, args.serverId));
      const server = rows[0];
      const ownerId = await requireAccount(ctx, args.session);
      if (!server || server.ownerId !== ownerId) throw new Error("Servidor não encontrado.");
      // A API pede usuário e senha do painel: o teste envia os salvos
      // neste servidor (e o token, se houver). Se a API emitir um
      // token, ele fica guardado neste servidor para as extensões.
      const result = await panelTestConnection(
        server.apiBase,
        server.apiToken,
        server.panelUser,
        server.panelPass,
      );
      await db
        .update(schema.servers)
        .set({
          apiVerified: result.connected ? 1 : 0,
          ...(result.issuedToken ? { apiToken: result.issuedToken } : {}),
          apiStatusDetail: result.detail,
          apiDiagnostic: JSON.stringify(result.diagnostic),
        })
        .where(eq(schema.servers.id, server.id));
      ctx.invalidateQueries();
      // O token emitido (se houve) já foi guardado acima; ele nunca
      // volta na resposta.
      return { connected: result.connected, detail: result.detail, diagnostic: result.diagnostic };
    },
  }),

  // Teste REAL de extensão: executa a chamada de extensão da API no
  // usuário exato do cliente escolhido, pela duração do plano dele.
  // ATENÇÃO: isto renova de verdade no painel e CONSOME os créditos do
  // plano. Se a API aceitar, a renovação é registrada, o vencimento do
  // cliente é atualizado e o servidor passa a "extensão verificada".
  testPanelExtend: defineAction({
    request: z.object({
      session: sessionField,
      serverId: z.number().int().positive(),
      clientId: z.number().int().positive(),
    }),
    response: z.object({
      extended: z.boolean(),
      detail: z.string(),
      newExpiresAt: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const serverRows = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, args.serverId));
      const server = serverRows[0];
      const ownerId = await requireAccount(ctx, args.session);
      if (!server || server.ownerId !== ownerId) throw new Error("Servidor não encontrado.");
      if (server.apiVerified !== 1) {
        return {
          extended: false,
          detail:
            "Antes do teste de extensão, toque em “Testar conexão” até a autenticação da API passar (ela usa o usuário e a senha do painel salvos neste servidor e guarda o token emitido, se houver). Nenhuma extensão foi tentada e nenhum crédito foi consumido.",
          newExpiresAt: null,
        };
      }
      const { client, plan } = await loadClientAndPlan(ctx, args.clientId);
      if (client.ownerId !== ownerId) throw new Error("Cliente não encontrado nesta conta.");
      const result = await panelExtendUser(server, {
        iptvUser: client.iptvUser,
        iptvPass: client.iptvPass,
        days: plan.days,
      });
      if (!result.ok) {
        await db
          .update(schema.servers)
          .set({ extendVerified: 0, extendStatusDetail: `Extensão pendente: ${result.detail}` })
          .where(eq(schema.servers.id, server.id));
        ctx.invalidateQueries();
        return { extended: false, detail: result.detail, newExpiresAt: null };
      }
      const applied = await applyRenewal(ctx, client, plan, client.priceOverrideCents ?? plan.priceCents, "painel_extensao_teste");
      await db
        .update(schema.servers)
        .set({
          extendVerified: 1,
          extendStatusDetail: `Extensão verificada: ${result.detail} Renovação registrada para ${client.name} (${plan.days} dias, ${creditsForDays(plan.days)} crédito(s)).`,
        })
        .where(eq(schema.servers.id, server.id));
      ctx.invalidateQueries();
      return {
        extended: true,
        detail: `${result.detail} A renovação foi registrada no gestor e o vencimento do cliente foi atualizado.`,
        newExpiresAt: applied.newExpires.toISOString(),
      };
    },
  }),

  deleteServer: defineAction({
    request: z.object({ session: sessionField, id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, args.id));
      if (!rows[0] || rows[0].ownerId !== ownerId) throw new Error("Servidor não encontrado.");
      await db.delete(schema.servers).where(eq(schema.servers.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  savePlan: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive().optional(),
      name: z.string().min(1),
      days: z.number().int().positive(),
      priceCents: z.number().int().min(0),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      if (args.days % 30 !== 0) {
        throw new Error("Os dias do plano precisam ser múltiplos de 30 (30, 60, 90...), porque 1 crédito do painel vale 30 dias.");
      }
      const db = ctx.db<typeof schema>();
      if (args.id) {
        const existing = await db
          .select()
          .from(schema.plans)
          .where(eq(schema.plans.id, args.id));
        if (!existing[0] || existing[0].ownerId !== ownerId) throw new Error("Plano não encontrado.");
        await db
          .update(schema.plans)
          .set({ name: args.name, days: args.days, priceCents: args.priceCents })
          .where(eq(schema.plans.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db
        .insert(schema.plans)
        .values({ ownerId, name: args.name, days: args.days, priceCents: args.priceCents })
        .returning({ id: schema.plans.id });
      const inserted = result[0];
      if (!inserted) throw new Error("savePlan: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deletePlan: defineAction({
    request: z.object({ session: sessionField, id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const planRows = await db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, args.id));
      if (!planRows[0] || planRows[0].ownerId !== ownerId) throw new Error("Plano não encontrado.");
      await db.delete(schema.plans).where(eq(schema.plans.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  saveClient: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive().optional(),
      name: z.string().min(1),
      whatsapp: z.string().max(30),
      iptvUser: z.string().min(1),
      iptvPass: z.string(),
      serverId: z.number().int().positive().nullable(),
      planId: z.number().int().positive().nullable(),
      priceOverrideCents: z.number().int().min(0).nullable(),
      expiresAt: z.string().min(1),
      status: z.enum(["ativo", "pausado"]),
      isTest: z.boolean(),
      referredBy: z.string().max(120),
      app: z.string().max(60).optional().default(""),
      device: z.string().max(60).optional().default(""),
      screens: z.number().int().min(1).max(99).nullable().optional().default(null),
      source: z.string().max(60).optional().default(""),
      extraPanel: z.string().max(60).optional().default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      if (args.serverId != null) {
        const srv = await db
          .select()
          .from(schema.servers)
          .where(eq(schema.servers.id, args.serverId));
        if (!srv[0] || srv[0].ownerId !== ownerId) throw new Error("Servidor não encontrado nesta conta.");
      }
      if (args.planId != null) {
        const pln = await db
          .select()
          .from(schema.plans)
          .where(eq(schema.plans.id, args.planId));
        if (!pln[0] || pln[0].ownerId !== ownerId) throw new Error("Plano não encontrado nesta conta.");
      }
      const expires = new Date(args.expiresAt);
      if (Number.isNaN(expires.getTime())) throw new Error("Data de vencimento inválida.");
      let iptvPass = args.iptvPass;
      if (args.id && !iptvPass) {
        const existing = await db
          .select()
          .from(schema.clients)
          .where(eq(schema.clients.id, args.id));
        if (existing[0] && existing[0].ownerId !== ownerId) throw new Error("Cliente não encontrado.");
        iptvPass = existing[0]?.iptvPass ?? "";
      }
      if (!iptvPass) throw new Error("Informe a senha IPTV do cliente.");
      const whatsapp = args.whatsapp.trim();
      const referredBy = args.referredBy.trim();
      const values = {
        ownerId,
        name: args.name,
        whatsapp: whatsapp ? whatsapp : null,
        iptvUser: args.iptvUser,
        iptvPass,
        serverId: args.serverId,
        planId: args.planId,
        priceOverrideCents: args.priceOverrideCents,
        expiresAt: expires,
        status: args.status,
        isTest: args.isTest ? 1 : 0,
        referredBy: referredBy ? referredBy : null,
        app: args.app.trim(),
        device: args.device.trim(),
        screens: args.screens,
        source: args.source.trim(),
        extraPanel: args.extraPanel.trim(),
      };
      if (args.id) {
        const existingRows = await db
          .select()
          .from(schema.clients)
          .where(eq(schema.clients.id, args.id));
        if (!existingRows[0] || existingRows[0].ownerId !== ownerId) throw new Error("Cliente não encontrado.");
        await db
          .update(schema.clients)
          .set({
            ...values,
            invoiceToken:
              existingRows[0].invoiceToken && existingRows[0].invoiceToken.length >= 20
                ? existingRows[0].invoiceToken
                : generateInvoiceToken(),
          })
          .where(eq(schema.clients.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db
        .insert(schema.clients)
        .values({ ...values, invoiceToken: generateInvoiceToken() })
        .returning({ id: schema.clients.id });
      const inserted = result[0];
      if (!inserted) throw new Error("saveClient: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteClient: defineAction({
    request: z.object({ session: sessionField, id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, args.id));
      if (!rows[0] || rows[0].ownerId !== ownerId) throw new Error("Cliente não encontrado.");
      await db.delete(schema.clients).where(eq(schema.clients.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Move o cliente entre a lista normal, Arquivados e Lixeira. Não
  // apaga nada: excluir de verdade é o deleteClient, usado na lixeira.
  setClientListState: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive(),
      state: z.enum(["normal", "arquivado", "lixeira"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, args.id));
      if (!rows[0] || rows[0].ownerId !== ownerId) throw new Error("Cliente não encontrado.");
      await db
        .update(schema.clients)
        .set({ listState: args.state })
        .where(eq(schema.clients.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // ---------------- Mercado Pago ----------------

  saveMercadoPago: defineAction({
    request: z.object({
      session: sessionField,
      accessToken: z.string().max(400),
      publicKey: z.string().max(400),
      environment: z.enum(["teste", "producao"]),
      liveMode: z.boolean(),
      clearCredentials: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const s = await loadSettings(ctx, ownerId);
      const token = args.clearCredentials
        ? ""
        : args.accessToken.trim()
          ? args.accessToken.trim()
          : s.mpAccessToken;
      const publicKey = args.clearCredentials
        ? ""
        : args.publicKey.trim()
          ? args.publicKey.trim()
          : s.mpPublicKey;
      const tokenChanged = token !== s.mpAccessToken;
      const verified = args.clearCredentials || tokenChanged ? false : s.mpVerified;
      if (args.liveMode && !verified) {
        throw new Error(
          'Antes de ligar o modo ao vivo, salve o access token e toque em "Testar conexão". O modo ao vivo só é liberado depois que o Mercado Pago aceita a credencial.',
        );
      }
      const liveModeEffective = args.liveMode && args.environment === "producao" && verified;
      await persistSettings(ctx, ownerId, {
        mpAccessToken: token,
        mpPublicKey: publicKey,
        mpVerified: verified ? 1 : 0,
        mpAccountLabel: verified ? s.mpAccountLabel : "",
        mpPayerEmail: verified ? s.mpPayerEmail : "",
        mpEnvironment: args.environment,
        liveMode: liveModeEffective && !args.clearCredentials ? 1 : 0,
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  testMercadoPago: defineAction({
    request: z.object({ session: sessionField }),
    response: z.object({
      connected: z.boolean(),
      accountLabel: z.string(),
      detail: z.string(),
    }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const s = await loadSettings(ctx, ownerId);
      if (!s.mpAccessToken) {
        return {
          connected: false,
          accountLabel: "",
          detail: "Nenhum access token está salvo. Cole a credencial no campo acima, salve e teste novamente.",
        };
      }
      const result = await mpTestConnection(s.mpAccessToken);
      await persistSettings(ctx, ownerId, {
        mpVerified: result.connected ? 1 : 0,
        mpAccountLabel: result.connected ? result.accountLabel : "",
        mpPayerEmail: result.connected ? result.email : "",
        liveMode: result.connected ? (s.liveMode ? 1 : 0) : 0,
      });
      // Resultado em linguagem simples: conectado ou não conectado, e
      // se falhou, o motivo provável e o que corrigir — sem expor a
      // credencial em nenhum momento.
      const tokenKind = s.mpAccessToken.startsWith("TEST-")
        ? "teste"
        : s.mpAccessToken.startsWith("APP_USR-")
          ? "producao"
          : "desconhecido";
      const keyKind = !s.mpPublicKey
        ? "ausente"
        : s.mpPublicKey.startsWith("TEST-")
          ? "teste"
          : s.mpPublicKey.startsWith("APP_USR-")
            ? "producao"
            : "desconhecido";
      let detail = result.detail;
      if (!result.connected) {
        if (
          keyKind !== "ausente" &&
          keyKind !== "desconhecido" &&
          tokenKind !== "desconhecido" &&
          keyKind !== tokenKind
        ) {
          detail =
            "Não conectado: a Public Key e o Access Token não combinam — um deles é de TESTE e o outro é de PRODUÇÃO. Pegue os dois do mesmo lugar no Mercado Pago (Suas integrações → Meios de pagamento → Credenciais) e salve de novo.";
        } else if (/401|403|unauthorized|invalid|recusou/i.test(result.detail)) {
          detail =
            "Não conectado: o Mercado Pago recusou o Access Token — ele pode estar errado, incompleto, vencido ou ser de outra conta. Gere um token novo no Mercado Pago (Suas integrações → Meios de pagamento → Credenciais de produção ou de teste), cole inteiro aqui, salve e teste outra vez. A Public Key sozinha não conecta: quem conecta é o Access Token.";
        } else if (/alcançar|rede|instantes/i.test(result.detail)) {
          detail =
            "Não conectado: houve um problema de rede ao falar com o Mercado Pago nesta tentativa. Nada foi alterado. Espere alguns instantes e toque em Testar de novo.";
        } else {
          detail = `Não conectado: ${result.detail} Confira se o Access Token foi colado inteiro e salve antes de testar.`;
        }
      } else {
        if (tokenKind === "teste") {
          detail = `${result.detail} Atenção: este token é de TESTE — serve para validar o fluxo, mas NÃO recebe dinheiro de verdade. Para cobrar dos clientes, salve as credenciais de PRODUÇÃO e ligue o modo ao vivo.`;
        } else if (s.mpEnvironment === "teste" && tokenKind === "producao") {
          detail = `${result.detail} Atenção: o token é de PRODUÇÃO, mas o ambiente marcado aqui é Teste. Troque o ambiente para Produção para as credenciais combinarem.`;
        }
        if (keyKind === "ausente") {
          detail += " A Public Key ainda não foi salva — ela não impede este teste (quem conecta é o Access Token), mas salve-a também para completar o cadastro.";
        }
      }
      ctx.invalidateQueries();
      return {
        connected: result.connected,
        accountLabel: result.accountLabel,
        detail,
      };
    },
  }),

  // Gera a cobrança Pix de um cliente. O MODO decide o risco:
  // - validacao (padrão, ou sempre que o modo ao vivo estiver desligado):
  //   a confirmação NUNCA chama o painel e NENHUM crédito é consumido.
  // - producao (só com modo ao vivo ligado + ambiente produção + pagamento
  //   real aprovado): aí sim a renovação é aplicada.
  createPix: defineAction({
    request: z.object({
      session: sessionField,
      clientId: z.number().int().positive(),
      mode: z.enum(["validacao", "producao"]),
      couponCode: z.string().max(40).optional(),
      // Página pública da fatura: o código secreto do link daquele
      // cliente. Sem ele, só o dono logado (sessão da própria conta)
      // pode gerar cobrança para o cliente.
      invoiceToken: z.string().max(120).optional(),
    }),
    response: paymentShape,
    async handler(ctx, args): Promise<z.infer<typeof paymentShape>> {
      const db = ctx.db<typeof schema>();
      const { client, plan } = await loadClientAndPlan(ctx, args.clientId);
      if (args.invoiceToken) {
        if (
          !client.invoiceToken ||
          client.invoiceToken.length < 20 ||
          args.invoiceToken.trim() !== client.invoiceToken
        ) {
          throw new Error(
            "Este link de fatura não é mais válido. Peça ao responsável um link novo da sua fatura.",
          );
        }
      } else {
        const ownerId = await requireAccount(ctx, args.session);
        if (client.ownerId !== ownerId) throw new Error("Cliente não encontrado nesta conta.");
      }
      const s = await loadSettings(ctx, client.ownerId);
      const panel = await loadPanelStatus(ctx, client.ownerId);
      const fullAmountCents = client.priceOverrideCents ?? plan.priceCents;
      // Cupom de desconto digitado na página da fatura: só vale se o
      // código existir e estiver ativo na aba Cupons. O valor cobrado
      // (amountCents) já vai abatido; o desconto fica registrado.
      let couponCode: string | null = null;
      let discountCents = 0;
      let couponNote = "";
      const rawCoupon = (args.couponCode ?? "").trim().toUpperCase();
      if (rawCoupon) {
        const couponRows = await db
          .select()
          .from(schema.coupons)
          .where(eq(schema.coupons.ownerId, client.ownerId));
        const coupon = couponRows.find(
          (c) => c.active === 1 && c.code.toUpperCase() === rawCoupon,
        );
        if (coupon) {
          couponCode = coupon.code;
          discountCents = Math.floor((fullAmountCents * coupon.percentOff) / 100);
          couponNote = ` Cupom ${coupon.code} aplicado: ${coupon.percentOff}% de desconto (${fmtBRL(discountCents)}) sobre o valor cheio de ${fmtBRL(fullAmountCents)}.`;
        } else {
          couponNote = ` O cupom informado (${rawCoupon}) não foi aplicado: código não encontrado ou inativo.`;
        }
      }
      const amountCents = fullAmountCents - discountCents;
      const credits = creditsForDays(plan.days);
      const effectiveMode: "validacao" | "producao" =
        args.mode === "producao" && s.liveMode && s.mpEnvironment === "producao"
          ? "producao"
          : "validacao";

      let status: "pendente" | "aguardando_configuracao" | "falhou" = "pendente";
      let mpPaymentId: string | null = null;
      let pixCode: string | null = null;
      let detail = "";

      // Aba PIX do servidor: se a renovação Pix deste servidor estiver
      // desligada, nenhuma cobrança é criada no Mercado Pago.
      let serverPixBlocked = false;
      if (client.serverId != null) {
        const srvRows = await db
          .select()
          .from(schema.servers)
          .where(eq(schema.servers.id, client.serverId));
        if (srvRows[0] && srvRows[0].pixEnabled === 0) serverPixBlocked = true;
      }

      if (serverPixBlocked) {
        status = "falhou";
        detail =
          "A renovação com Pix está desligada nas configurações do servidor deste cliente (Servidores → Editar → aba PIX). Nenhuma cobrança foi criada no Mercado Pago e nada foi cobrado.";
      } else if (effectiveMode === "validacao" && s.mpAccessToken && s.mpEnvironment === "producao") {
        status = "falhou";
        detail =
          "Validação com Pix pagável não é gerada usando credenciais de produção: alguém poderia pagar dinheiro real e a confirmação de validação não renovaria a conta. Para validar, use credenciais/ambiente de Teste do Mercado Pago; para dinheiro real, use uma cobrança ao vivo.";
      } else if (!s.mpAccessToken) {
        status = "aguardando_configuracao";
        detail =
          "Access token do Mercado Pago ainda não configurado. Salve suas credenciais na aba Pagamentos do gestor para gerar o Pix real — sem sair desta página e sem colar a chave em nenhum chat.";
      } else {
        // E-mail do pagador exigido pela API: usa o e-mail da conta do
        // Mercado Pago já salvo; se ainda não houver (conta testada
        // antes desta correção), busca agora em /users/me e salva.
        let payerEmail = s.mpPayerEmail;
        if (!payerEmail) {
          const me = await mpTestConnection(s.mpAccessToken);
          if (me.connected && me.email) {
            payerEmail = me.email;
            await persistSettings(ctx, client.ownerId, { mpPayerEmail: payerEmail });
          }
        }
        const created = await mpCreatePix(s.mpAccessToken, {
          amountCents,
          clientName: client.name,
          clientId: client.id,
          payerEmail,
        });
        if (created.kind === "created") {
          mpPaymentId = created.mpPaymentId || null;
          pixCode = created.pixCode;
          detail =
            s.mpEnvironment === "teste"
              ? "Cobrança criada no ambiente de TESTE do Mercado Pago: nenhum dinheiro real se move e nenhum crédito do painel é consumido."
              : effectiveMode === "producao"
                ? panel.connected
                  ? "Pix real criado no Mercado Pago. A página consulta o Mercado Pago automaticamente; quando o pagamento for aprovado, o gestor executa a extensão daquele usuário na API do painel (duração do plano; 1 crédito = 30 dias) e só marca como renovado se a API aceitar."
                  : "Pix real criado no Mercado Pago. A página consulta o Mercado Pago automaticamente; se o pagamento for aprovado, ele ficará marcado como extensão pendente porque a API do painel ainda não está conectada — nenhum crédito será dado como consumido."
                : "Pix criado no Mercado Pago, mas em modo de validação porque o modo ao vivo não está totalmente ligado. A confirmação não renova o painel e não consome crédito.";
        } else {
          status = "falhou";
          detail = created.detail;
        }
      }

      if (couponNote) detail = detail ? `${detail}${couponNote}` : couponNote.trim();

      const inserted = await db
        .insert(schema.payments)
        .values({
          ownerId: client.ownerId,
          clientId: client.id,
          clientName: client.name,
          amountCents,
          days: plan.days,
          credits,
          mode: effectiveMode,
          status,
          mpPaymentId,
          pixCode,
          couponCode,
          discountCents,
          detail,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("createPix: insert returned no rows");
      ctx.invalidateQueries();
      return {
        id: row.id,
        clientId: row.clientId,
        clientName: row.clientName,
        amountCents: row.amountCents,
        days: row.days,
        credits: row.credits,
        mode: row.mode,
        status: row.status,
        mpPaymentId: row.mpPaymentId ?? null,
        pixCode: row.pixCode ?? null,
        couponCode: row.couponCode ?? null,
        discountCents: row.discountCents ?? 0,
        detail: row.detail,
        wouldExpireAt: row.wouldExpireAt ? row.wouldExpireAt.toISOString() : null,
        appliedRenewalId: row.appliedRenewalId ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    },
  }),

  // Consulta o status real no Mercado Pago. Se aprovado:
  // - validacao: registra o que aconteceria (novo vencimento calculado),
  //   SEM aplicar e SEM consumir crédito.
  // - producao: aplica a renovação de verdade (1 vez só por cobrança).
  checkPaymentStatus: defineAction({
    request: z.object({
      session: sessionField,
      paymentId: z.number().int().positive(),
      // Página pública da fatura: o código secreto do link do cliente
      // dono desta cobrança. Sem ele, só o dono logado pode consultar.
      invoiceToken: z.string().max(120).optional(),
    }),
    response: z.object({
      status: z.string(),
      detail: z.string(),
      applied: z.boolean(),
      newExpiresAt: z.string().nullable(),
      message: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, args.paymentId));
      const payment = rows[0];
      const s = await loadSettings(ctx, payment?.ownerId ?? 0);
      if (!payment) throw new Error("Cobrança não encontrada.");
      // Autorização: página pública só com o código secreto do link
      // da fatura do cliente dono desta cobrança; sem o código, só o
      // dono logado na própria conta pode consultar.
      if (args.invoiceToken) {
        const clientRows = await db
          .select()
          .from(schema.clients)
          .where(eq(schema.clients.id, payment.clientId));
        const ownerClient = clientRows[0];
        if (
          !ownerClient ||
          !ownerClient.invoiceToken ||
          ownerClient.invoiceToken.length < 20 ||
          args.invoiceToken.trim() !== ownerClient.invoiceToken
        ) {
          throw new Error(
            "Este link de fatura não é mais válido. Peça ao responsável um link novo da sua fatura.",
          );
        }
      } else {
        const ownerId = await requireAccount(ctx, args.session);
        if (payment.ownerId !== ownerId) throw new Error("Cobrança não encontrada nesta conta.");
      }
      if (payment.appliedRenewalId != null) {
        return {
          status: payment.status,
          detail: "Esta cobrança já foi confirmada e a renovação já foi aplicada uma vez. Nada é aplicado de novo.",
          applied: true,
          newExpiresAt: payment.wouldExpireAt ? payment.wouldExpireAt.toISOString() : null,
          message: "",
        };
      }
      if (payment.status === "aprovado_pendente_painel") {
        // O pagamento já está confirmado no Mercado Pago; o que falta é
        // a extensão no painel. Tenta executar a extensão REAL de novo.
        const { client, plan } = await loadClientAndPlan(ctx, payment.clientId);
        const { panelServer, extend } = await panelExtendForClient(ctx, client, plan.days);
        if (!extend.ok || !panelServer) {
          return {
            status: payment.status,
            detail: `O pagamento está confirmado, mas a extensão no painel continua pendente: ${extend.detail} Nenhum crédito foi dado como consumido.`,
            applied: false,
            newExpiresAt: payment.wouldExpireAt ? payment.wouldExpireAt.toISOString() : null,
            message: "",
          };
        }
        if (panelServer.extendVerified !== 1) {
          await db
            .update(schema.servers)
            .set({
              extendVerified: 1,
              extendStatusDetail: `Extensão verificada: ${extend.detail}`,
            })
            .where(eq(schema.servers.id, panelServer.id));
        }
        const applied = await applyRenewal(ctx, client, plan, payment.amountCents, "mercado_pago");
        const waNote = await sendRenewalConfirmation(ctx, client, applied.message);
        await db
          .update(schema.payments)
          .set({
            status: "aprovado",
            wouldExpireAt: applied.newExpires,
            appliedRenewalId: applied.renewalId,
            detail: `Extensão concluída no painel nesta nova tentativa: ${extend.detail} Créditos do plano: ${String(payment.credits)}. ${waNote}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.payments.id, payment.id));
        ctx.invalidateQueries();
        return {
          status: "aprovado",
          detail: "Extensão concluída no painel e renovação aplicada.",
          applied: true,
          newExpiresAt: applied.newExpires.toISOString(),
          message: applied.message,
        };
      }
      if (!payment.mpPaymentId) {
        return {
          status: payment.status,
          detail:
            "Esta cobrança não tem um pagamento no Mercado Pago para consultar (credenciais não configuradas ou criação falhou). Gere uma nova cobrança depois de salvar o access token.",
          applied: false,
          newExpiresAt: null,
          message: "",
        };
      }
      if (!s.mpAccessToken) {
        return {
          status: payment.status,
          detail: "Access token não está mais salvo no gestor. Salve as credenciais na aba Pagamentos para consultar.",
          applied: false,
          newExpiresAt: null,
          message: "",
        };
      }
      const check = await mpGetPaymentStatus(s.mpAccessToken, payment.mpPaymentId);
      if (!check.ok) {
        return {
          status: payment.status,
          detail: check.detail,
          applied: false,
          newExpiresAt: null,
          message: "",
        };
      }
      const mpStatus = check.status;
      if (mpStatus === "approved") {
        if (payment.mode === "validacao") {
          const { client, plan } = await loadClientAndPlan(ctx, payment.clientId);
          const would = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
          const message = renderTemplate(s.renewedMessage, {
            nome: client.name,
            usuario: client.iptvUser,
            vencimento: fmtDate(client.expiresAt),
            novoVencimento: fmtDate(would),
            dias: plan.days,
            valor: fmtBRL(payment.amountCents),
            plano: plan.name,
          });
          await db
            .update(schema.payments)
            .set({
              status: "aprovado",
              wouldExpireAt: would,
              detail:
                "Pagamento aprovado no Mercado Pago — VALIDAÇÃO: a renovação NÃO foi aplicada no painel e NENHUM crédito foi consumido. O novo vencimento calculado aparece só como demonstração.",
              updatedAt: new Date(),
            })
            .where(eq(schema.payments.id, payment.id));
          ctx.invalidateQueries();
          return {
            status: "aprovado",
            detail:
              "Aprovado em modo de validação: painel não foi chamado e nenhum crédito foi consumido.",
            applied: false,
            newExpiresAt: would.toISOString(),
            message,
          };
        }
        // Produção: o pagamento real foi confirmado. Agora o gestor
        // executa a extensão REAL na API do painel (o [+] Estender
        // daquele usuário, pela duração do plano). Só se a API aceitar
        // é que a renovação é aplicada aqui e os créditos contam como
        // consumidos; se a API recusar ou estiver fora, fica pendente.
        const { client, plan } = await loadClientAndPlan(ctx, payment.clientId);
        const { panelServer, extend } = await panelExtendForClient(ctx, client, plan.days);
        if (!extend.ok || !panelServer) {
          const would = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
          await db
            .update(schema.payments)
            .set({
              status: "aprovado_pendente_painel",
              wouldExpireAt: would,
              detail:
                `Pagamento real aprovado no Mercado Pago, mas a extensão no painel NÃO foi concluída: ${extend.detail} Nenhum crédito foi dado como consumido e o vencimento não foi alterado. Não trate esta cobrança como renovação automática concluída.`,
              updatedAt: new Date(),
            })
            .where(eq(schema.payments.id, payment.id));
          ctx.invalidateQueries();
          return {
            status: "aprovado_pendente_painel",
            detail:
              "Pagamento confirmado no Mercado Pago, mas a extensão no painel está pendente: a API não concluiu a renovação e nenhum crédito foi dado como consumido.",
            applied: false,
            newExpiresAt: would.toISOString(),
            message: "",
          };
        }
        if (panelServer.extendVerified !== 1) {
          await db
            .update(schema.servers)
            .set({
              extendVerified: 1,
              extendStatusDetail: `Extensão verificada: ${extend.detail}`,
            })
            .where(eq(schema.servers.id, panelServer.id));
        }
        const applied = await applyRenewal(ctx, client, plan, payment.amountCents, "mercado_pago");
        const waNote = await sendRenewalConfirmation(ctx, client, applied.message);
        await db
          .update(schema.payments)
          .set({
            status: "aprovado",
            wouldExpireAt: applied.newExpires,
            appliedRenewalId: applied.renewalId,
            detail:
              `Pagamento real aprovado e extensão concluída no painel: ${extend.detail} Vencimento atualizado no gestor. Créditos do plano: ${String(payment.credits)}. ${waNote}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.payments.id, payment.id));
        ctx.invalidateQueries();
        return {
          status: "aprovado",
          detail: "Pagamento aprovado, extensão concluída no painel e renovação aplicada.",
          applied: true,
          newExpiresAt: applied.newExpires.toISOString(),
          message: applied.message,
        };
      }
      if (mpStatus === "rejected" || mpStatus === "cancelled") {
        await db
          .update(schema.payments)
          .set({ status: "recusado", updatedAt: new Date() })
          .where(eq(schema.payments.id, payment.id));
        ctx.invalidateQueries();
        return {
          status: "recusado",
          detail: "O Mercado Pago marcou este pagamento como recusado/cancelado.",
          applied: false,
          newExpiresAt: null,
          message: "",
        };
      }
      return {
        status: payment.status,
        detail: `O Mercado Pago ainda mostra este pagamento como “${mpStatus || "pendente"}”. Peça para o cliente concluir o Pix e verifique de novo.`,
        applied: false,
        newExpiresAt: null,
        message: "",
      };
    },
  }),

  // Consulta automaticamente as cobranças pendentes no Mercado Pago.
  // Esta é a confirmação ativa do gestor: ela não depende de a fatura
  // estar aberta e nunca aplica duas vezes a mesma cobrança.
  syncPendingPayments: defineAction({
    request: z.object({}),
    response: z.object({
      checked: z.number(),
      approvedValidation: z.number(),
      pendingPanel: z.number(),
      applied: z.number(),
      rejected: z.number(),
      detail: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      // Sincronização automática (agendada): roda para TODAS as contas,
      // usando as credenciais de Mercado Pago da conta dona de cada
      // cobrança — os dados nunca se misturam entre contas.
      const settingsByOwner = new Map<number, SettingsObj>();
      const settingsFor = async (ownerId: number): Promise<SettingsObj> => {
        const cached = settingsByOwner.get(ownerId);
        if (cached) return cached;
        const loaded = await loadSettings(ctx, ownerId);
        settingsByOwner.set(ownerId, loaded);
        return loaded;
      };
      const pending = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.status, "pendente"))
        .orderBy(asc(schema.payments.id));
      let checked = 0;
      let approvedValidation = 0;
      let pendingPanel = 0;
      let applied = 0;
      let rejected = 0;
      for (const payment of pending.slice(0, 25)) {
        if (!payment.mpPaymentId) continue;
        const s = await settingsFor(payment.ownerId);
        if (!s.mpAccessToken) continue;
        const check = await mpGetPaymentStatus(s.mpAccessToken, payment.mpPaymentId);
        if (!check.ok) continue;
        checked += 1;
        if (check.status === "approved") {
          const { client, plan } = await loadClientAndPlan(ctx, payment.clientId);
          const would = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
          if (payment.mode === "validacao") {
            approvedValidation += 1;
            await db
              .update(schema.payments)
              .set({
                status: "aprovado",
                wouldExpireAt: would,
                detail:
                  "Pagamento aprovado consultado automaticamente — VALIDAÇÃO: painel não chamado e nenhum crédito consumido.",
                updatedAt: new Date(),
              })
              .where(eq(schema.payments.id, payment.id));
          } else {
            // Produção: executa a extensão REAL na API do painel antes
            // de dar qualquer renovação como aplicada.
            const { panelServer, extend } = await panelExtendForClient(ctx, client, plan.days);
            if (!extend.ok || !panelServer) {
              pendingPanel += 1;
              await db
                .update(schema.payments)
                .set({
                  status: "aprovado_pendente_painel",
                  wouldExpireAt: would,
                  detail: `Pagamento real aprovado consultado automaticamente, mas a extensão no painel NÃO foi concluída: ${extend.detail} Nenhum crédito foi dado como consumido e o vencimento ficou inalterado.`,
                  updatedAt: new Date(),
                })
                .where(eq(schema.payments.id, payment.id));
            } else {
              if (panelServer.extendVerified !== 1) {
                await db
                  .update(schema.servers)
                  .set({
                    extendVerified: 1,
                    extendStatusDetail: `Extensão verificada: ${extend.detail}`,
                  })
                  .where(eq(schema.servers.id, panelServer.id));
              }
              const result = await applyRenewal(ctx, client, plan, payment.amountCents, "mercado_pago");
              applied += 1;
              const waNote = await sendRenewalConfirmation(ctx, client, result.message);
              await db
                .update(schema.payments)
                .set({
                  status: "aprovado",
                  wouldExpireAt: result.newExpires,
                  appliedRenewalId: result.renewalId,
                  detail: `Pagamento real aprovado, extensão concluída no painel e renovação aplicada uma única vez. ${waNote}`,
                  updatedAt: new Date(),
                })
                .where(eq(schema.payments.id, payment.id));
            }
          }
        } else if (check.status === "rejected" || check.status === "cancelled") {
          rejected += 1;
          await db
            .update(schema.payments)
            .set({ status: "recusado", updatedAt: new Date() })
            .where(eq(schema.payments.id, payment.id));
        }
      }
      ctx.invalidateQueries();
      return {
        checked,
        approvedValidation,
        pendingPanel,
        applied,
        rejected,
        detail:
          checked === 0
            ? "Nenhuma cobrança pendente precisou de consulta agora."
            : "Consulta automática concluída.",
      };
    },
  }),

  // Simula a confirmação de pagamento SOMENTE em modo validação — serve
  // para testar o fluxo inteiro (mensagem de renovação, novo vencimento
  // calculado) SEM chamar o painel e SEM consumir crédito. Em produção
  // esta ação se recusa: lá, só pagamento real confirmado renova.
  simulatePaymentApproved: defineAction({
    request: z.object({ session: sessionField, paymentId: z.number().int().positive() }),
    response: z.object({
      status: z.string(),
      detail: z.string(),
      newExpiresAt: z.string().nullable(),
      message: z.string(),
    }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, args.paymentId));
      const payment = rows[0];
      if (!payment || payment.ownerId !== ownerId) throw new Error("Cobrança não encontrada.");
      const s = await loadSettings(ctx, payment.ownerId);
      if (payment.mode !== "validacao") {
        throw new Error(
          "Simulação não é permitida em cobrança de produção. No modo ao vivo, só um pagamento real confirmado no Mercado Pago renova a conta.",
        );
      }
      if (payment.status === "aprovado") {
        return {
          status: "aprovado",
          detail: "Esta cobrança de validação já estava marcada como aprovada.",
          newExpiresAt: payment.wouldExpireAt ? payment.wouldExpireAt.toISOString() : null,
          message: "",
        };
      }
      const { client, plan } = await loadClientAndPlan(ctx, payment.clientId);
      const would = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
      const message = renderTemplate(s.renewedMessage, {
        nome: client.name,
        usuario: client.iptvUser,
        vencimento: fmtDate(client.expiresAt),
        novoVencimento: fmtDate(would),
        dias: plan.days,
        valor: fmtBRL(payment.amountCents),
        plano: plan.name,
      });
      await db
        .update(schema.payments)
        .set({
          status: "aprovado",
          wouldExpireAt: would,
          detail:
            "Confirmação SIMULADA na validação: o painel NÃO foi chamado, o vencimento real do cliente NÃO mudou e NENHUM crédito foi consumido. Serve só para conferir o fluxo e a mensagem.",
          updatedAt: new Date(),
        })
        .where(eq(schema.payments.id, payment.id));
      ctx.invalidateQueries();
      return {
        status: "aprovado",
        detail:
          "Validação concluída sem renovar no painel: nenhum crédito consumido.",
        newExpiresAt: would.toISOString(),
        message,
      };
    },
  }),

  // ---------------- WhatsApp ----------------

  saveWhatsApp: defineAction({
    request: z.object({ session: sessionField, phone: z.string().max(30) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      await persistSettings(ctx, ownerId, { whatsappPhone: args.phone.trim() });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Inicia o pareamento por QR Code: sobe o serviço de sessão
  // interno do gestor (processo persistente desta conta) e espera o
  // QR Code real aparecer. Nenhum QR é desenhado/inventado aqui: a
  // imagem vem do serviço de sessão, que fala com o WhatsApp.
  startWhatsAppQr: defineAction({
    request: z.object({ session: sessionField }),
    response: qrWhatsappResponse,
    privileged: [privileged.waStart, privileged.waStatus],
    async handler(ctx, args): Promise<z.infer<typeof qrWhatsappResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      await ctx.executePrivileged(privileged.waStart, { accountId: ownerId });
      let raw = await ctx.executePrivileged(privileged.waStatus, { accountId: ownerId });
      let mapped = mapWaServiceStatus(raw);
      // Espera até ~12s pelo QR (ou pela reconexão automática de uma
      // sessão já salva): a tela continua consultando depois disso.
      // Se o serviço ENCERRAR no meio da geração (processo morto e
      // estado desconectado), não adianta esperar: avisa como
      // indisponível, para a tela mostrar o motivo e o botão de
      // tentar de novo em vez de um “gerando” eterno. Uma leitura
      // morta isolada não basta: bem na religação, a leitura pode
      // bater na janela entre o processo antigo sair e o novo
      // gravar o próprio status — só depois de 3 leituras mortas
      // seguidas (~4,5s) é que a sessão é dada como encerrada.
      let deadReads = 0;
      for (let i = 0; i < 8 && !mapped.image && mapped.status !== "conectado" && mapped.status !== "indisponivel"; i++) {
        if (!raw.running && mapped.status === "desconectado") {
          deadReads++;
          if (deadReads >= 3) break;
        } else {
          deadReads = 0;
        }
        await new Promise((r) => setTimeout(r, 1500));
        raw = await ctx.executePrivileged(privileged.waStatus, { accountId: ownerId });
        mapped = mapWaServiceStatus(raw);
      }
      if (!raw.running && mapped.status === "desconectado" && deadReads >= 3) {
        mapped = {
          status: "indisponivel",
          phone: "",
          image: "",
          detail:
            "O serviço de sessão do WhatsApp encerrou antes de emitir o QR Code nesta tentativa. Toque em “Gerar QR Code” para tentar de novo.",
        };
      }
      // Serviço AINDA no ar trabalhando (ex.: acabou de descartar
      // uma sessão salva revogada e está gerando o pareamento
      // novo): o estado gravado pode mostrar “desconectado” por um
      // instante, mas a geração não acabou. Reportar “gerando”
      // mantém a tela verificando a cada 3 segundos até o QR Code
      // aparecer ou a sessão conectar — em vez de a tela desistir
      // no meio e o QR nunca aparecer para a dona da conta.
      if (mapped.status === "desconectado" && raw.running) {
        mapped = {
          status: "gerando",
          phone: "",
          image: "",
          detail: "Abrindo a sessão do WhatsApp… o QR Code aparece em alguns segundos.",
        };
      }
      const result = await persistQrState(ctx, ownerId, mapped);
      ctx.invalidateQueries();
      return result;
    },
  }),

  // A tela chama esta verificação a cada poucos segundos enquanto
  // gera/aguarda/conecta. Ela lê o estado REAL do serviço de sessão
  // desta conta e grava no estado do gestor.
  getWhatsAppQrStatus: defineAction({
    request: z.object({ session: sessionField }),
    response: qrWhatsappResponse,
    privileged: [privileged.waStatus],
    async handler(ctx, args): Promise<z.infer<typeof qrWhatsappResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const stored = await loadSettings(ctx, ownerId);
      const service = await ctx.executePrivileged(privileged.waStatus, {
        accountId: ownerId,
      });
      const mappedRaw = mapWaServiceStatus(service);
      // Mesmo cuidado da geração: serviço no ar com estado
      // transitório “desconectado” (descartando sessão revogada e
      // gerando pareamento novo) não é desconexão final — manter
      // “gerando” para a tela continuar verificando até o QR.
      const mapped =
        mappedRaw.status === "desconectado" && service.running
          ? {
              status: "gerando",
              phone: "",
              image: "",
              detail: "Abrindo a sessão do WhatsApp… o QR Code aparece em alguns segundos.",
            }
          : mappedRaw;
      // Depois de um Desconectar manual, o estado gravado manda até o
      // serviço confirmar o encerramento da sessão.
      if (
        stored.waQrStatus === "desconectado" &&
        mapped.status === "conectado" &&
        stored.waQrUpdatedAt > service.updatedAt
      ) {
        return qrStateFromSettings(stored);
      }
      if (
        mapped.status !== stored.waQrStatus ||
        mapped.phone !== stored.waQrPhone ||
        mapped.image !== (stored.waQrImage || "") ||
        mapped.detail !== stored.waQrDetail
      ) {
        const result = await persistQrState(ctx, ownerId, mapped);
        ctx.invalidateQueries();
        return result;
      }
      return qrStateFromSettings(stored);
    },
  }),

  // Desconecta o WhatsApp desta conta: o serviço encerra a sessão no
  // WhatsApp (logout) e apaga a autenticação salva.
  disconnectWhatsAppQr: defineAction({
    request: z.object({ session: sessionField }),
    response: qrWhatsappResponse,
    privileged: [privileged.waStop],
    async handler(ctx, args): Promise<z.infer<typeof qrWhatsappResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      await ctx.executePrivileged(privileged.waStop, { accountId: ownerId });
      const result = await persistQrState(ctx, ownerId, {
        status: "desconectado",
        phone: "",
        image: "",
        detail:
          "WhatsApp desconectado por você. Para conectar de novo, toque em “Gerar QR Code” e leia o código com o celular.",
      });
      ctx.invalidateQueries();
      return result;
    },
  }),

  // Salva as preferências do dispositivo WhatsApp (cartão do
  // dispositivo): bloqueio de chamadas, transcrição de áudios e
  // mensagem de ausência. Ficam guardadas no gestor.
  saveWhatsAppPrefs: defineAction({
    request: z.object({
      session: sessionField,
      blockCalls: z.boolean(),
      transcribeAudio: z.boolean(),
      awayEnabled: z.boolean(),
      awayMessage: z.string().max(500),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      await persistSettings(ctx, ownerId, {
        waBlockCalls: args.blockCalls ? 1 : 0,
        waTranscribeAudio: args.transcribeAudio ? 1 : 0,
        waAwayEnabled: args.awayEnabled ? 1 : 0,
        waAwayMessage: args.awayMessage.trim(),
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // ---------------- Despesas (custos do dashboard) ----------------

  saveExpense: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive().optional(),
      description: z.string().min(1).max(200),
      amountCents: z.number().int().min(1),
      spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const values = {
        ownerId,
        description: args.description.trim(),
        amountCents: args.amountCents,
        spentOn: args.spentOn,
      };
      if (args.id) {
        const existing = await db
          .select()
          .from(schema.expenses)
          .where(eq(schema.expenses.id, args.id));
        if (!existing[0] || existing[0].ownerId !== ownerId) throw new Error("Despesa não encontrada.");
        await db.update(schema.expenses).set(values).where(eq(schema.expenses.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const inserted = await db
        .insert(schema.expenses)
        .values(values)
        .returning({ id: schema.expenses.id });
      const row = inserted[0];
      if (!row) throw new Error("saveExpense: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteExpense: defineAction({
    request: z.object({ session: sessionField, id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.id, args.id));
      if (!rows[0] || rows[0].ownerId !== ownerId) throw new Error("Despesa não encontrada.");
      await db.delete(schema.expenses).where(eq(schema.expenses.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // ---------------- Cupons de desconto ----------------

  saveCoupon: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive().optional(),
      code: z.string().min(2).max(30),
      percentOff: z.number().int().min(1).max(90),
      active: z.boolean(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const code = args.code.trim().toUpperCase();
      if (!code) throw new Error("Informe o código do cupom.");
      const all = await db
        .select()
        .from(schema.coupons)
        .where(eq(schema.coupons.ownerId, ownerId));
      const clash = all.find((c) => c.id !== args.id && c.code.toUpperCase() === code);
      if (clash) throw new Error(`Já existe um cupom com o código ${code}.`);
      const values = { ownerId, code, percentOff: args.percentOff, active: args.active ? 1 : 0 };
      if (args.id) {
        const existing = all.find((c) => c.id === args.id);
        if (!existing) throw new Error("Cupom não encontrado.");
        await db.update(schema.coupons).set(values).where(eq(schema.coupons.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const inserted = await db
        .insert(schema.coupons)
        .values(values)
        .returning({ id: schema.coupons.id });
      const row = inserted[0];
      if (!row) throw new Error("saveCoupon: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteCoupon: defineAction({
    request: z.object({ session: sessionField, id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.coupons)
        .where(eq(schema.coupons.id, args.id));
      if (!rows[0] || rows[0].ownerId !== ownerId) throw new Error("Cupom não encontrado.");
      await db.delete(schema.coupons).where(eq(schema.coupons.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  saveSettings: defineAction({
    request: z.object({
      session: sessionField,
      warnDays: z.array(z.number().int().min(0).max(60)).max(6),
      invoiceTitle: z.string().min(1).max(120),
      invoiceMessage: z.string().min(1).max(500),
      invoiceColor: z.enum(["verde", "azul", "roxo", "coral", "grafite"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const unique = [...new Set(args.warnDays)].sort((a, b) => b - a);
      const value = unique.length ? unique.join(",") : "0";
      await persistSettings(ctx, ownerId, {
        warnDays: value,
        invoiceTitle: args.invoiceTitle,
        invoiceMessage: args.invoiceMessage,
        invoiceColor: args.invoiceColor,
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Endereço público do gestor fora do Muse (hospedagem gratuita no
  // Render): quando salvo, todos os links de fatura das mensagens
  // passam a usar este endereço, para o cliente abrir a fatura sem
  // login do Muse. Nenhum segredo é guardado aqui — é só o endereço
  // público do site, o mesmo que aparece no painel do Render.
  saveHostingSettings: defineAction({
    request: z.object({
      session: sessionField,
      publicBaseUrl: z.string().max(300),
    }),
    response: z.object({ publicBaseUrl: z.string() }),
    async handler(ctx, args): Promise<{ publicBaseUrl: string }> {
      const ownerId = await requireAccount(ctx, args.session);
      const raw = args.publicBaseUrl.trim();
      if (!raw) {
        await persistSettings(ctx, ownerId, { publicBaseUrl: "" });
        ctx.invalidateQueries();
        return { publicBaseUrl: "" };
      }
      let cleaned = raw.replace(/\s+/g, "");
      if (!/^https:\/\//i.test(cleaned)) {
        throw new Error(
          "O endereço público precisa começar com https:// — copie o endereço completo do seu serviço no Render (ele se parece com https://gestor-iptv.onrender.com).",
        );
      }
      cleaned = cleaned.split("#")[0]!.replace(/\/+$/, "");
      try {
        const u = new URL(cleaned);
        if (u.protocol !== "https:" || !u.hostname.includes(".")) {
          throw new Error("invalid");
        }
      } catch {
        throw new Error(
          "Este endereço não parece válido. Copie o endereço do serviço no painel do Render, parecido com https://gestor-iptv.onrender.com, sem nada depois.",
        );
      }
      await persistSettings(ctx, ownerId, { publicBaseUrl: cleaned });
      ctx.invalidateQueries();
      return { publicBaseUrl: cleaned };
    },
  }),

  // Troca o código secreto do link da fatura de um cliente: o link
  // antigo para de funcionar na hora e só o link novo (com o código
  // novo) abre a fatura. Usado quando um link foi compartilhado com
  // quem não devia, ou para aposentar os links antigos.
  regenerateInvoiceLink: defineAction({
    request: z.object({
      session: sessionField,
      clientId: z.number().int().positive(),
    }),
    response: z.object({ invoiceToken: z.string() }),
    async handler(ctx, args): Promise<{ invoiceToken: string }> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, args.clientId));
      if (!rows[0] || rows[0].ownerId !== ownerId) {
        throw new Error("Cliente não encontrado nesta conta.");
      }
      const invoiceToken = generateInvoiceToken();
      await db
        .update(schema.clients)
        .set({ invoiceToken })
        .where(eq(schema.clients.id, args.clientId));
      ctx.invalidateQueries();
      return { invoiceToken };
    },
  }),

  saveMessageTemplates: defineAction({
    request: z.object({
      session: sessionField,
      warnMessage: z.string().min(1).max(1000),
      warnSoonMessage: z.string().min(1).max(1000).optional(),
      renewedMessage: z.string().min(1).max(1000),
      expiredMessage: z.string().min(1).max(1000),
      chargeMessage: z.string().min(1).max(1000).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      await persistSettings(ctx, ownerId, {
        warnMessage: args.warnMessage,
        ...(args.warnSoonMessage !== undefined
          ? { warnSoonMessage: args.warnSoonMessage }
          : {}),
        renewedMessage: args.renewedMessage,
        expiredMessage: args.expiredMessage,
        ...(args.chargeMessage !== undefined
          ? { chargeMessage: args.chargeMessage }
          : {}),
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Envio AUTOMÁTICO de mensagem ao cliente pelo WhatsApp conectado
  // por QR Code desta conta (botão "Enviar mensagem" na lista de
  // clientes). A mensagem final (modelo já montado com as tags do
  // cliente) vai para o serviço de sessão, que entrega direto no
  // WhatsApp do cliente — sem wa.me, sem copiar e colar. O retorno
  // diz se enviou ou o motivo simples de não ter enviado.
  sendWhatsAppMessage: defineAction({
    request: z.object({
      session: sessionField,
      clientId: z.number().int().positive(),
      text: z.string().min(1).max(2000),
    }),
    response: z.object({
      sent: z.boolean(),
      detail: z.string(),
      to: z.string(),
    }),
    privileged: [privileged.waSend],
    async handler(
      ctx,
      args,
    ): Promise<{ sent: boolean; detail: string; to: string }> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, args.clientId));
      const client = rows[0];
      if (!client || client.ownerId !== ownerId) {
        return {
          sent: false,
          detail: "Cliente não encontrado nesta conta.",
          to: "",
        };
      }
      const to = (client.whatsapp ?? "").replace(/\D/g, "");
      if (!to) {
        return {
          sent: false,
          detail:
            "Este cliente não tem número de WhatsApp cadastrado. Edite o cliente e cadastre o número para poder enviar.",
          to: "",
        };
      }
      const result = await ctx.executePrivileged(privileged.waSend, {
        accountId: ownerId,
        to,
        text: args.text,
      });
      return { sent: result.sent, detail: result.detail, to };
    },
  }),

  // ---------------- Contas (login) ----------------

  register: defineAction({
    request: z.object({
      email: z.string().min(3).max(200),
      password: z.string().min(6).max(200),
    }),
    response: z.object({
      token: z.string(),
      email: z.string(),
      claimedLegacy: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("Digite um e-mail válido.");
      }
      const existing = await db.select().from(schema.accounts);
      if (existing.some((a) => a.email.toLowerCase() === email)) {
        throw new Error("Já existe uma conta com este e-mail. Toque em Entrar.");
      }
      const isFirstAccount = existing.length === 0;
      const passHash = await hashPassword(args.password);
      const inserted = await db
        .insert(schema.accounts)
        .values({ email, passHash })
        .returning({ id: schema.accounts.id });
      const account = inserted[0];
      if (!account) throw new Error("Não foi possível criar a conta.");
      // A PRIMEIRA conta criada herda os dados que já existiam no
      // gestor de quando ele era de uma pessoa só (owner_id = 0). Toda
      // conta criada depois começa do zero, vazia.
      let claimedLegacy = false;
      if (isFirstAccount) {
        const tables = [
          schema.servers,
          schema.plans,
          schema.clients,
          schema.renewals,
          schema.payments,
          schema.expenses,
          schema.coupons,
          schema.serverCreditLogs,
          schema.integrations,
          schema.settings,
        ];
        for (const t of tables) {
          await db.update(t).set({ ownerId: account.id }).where(eq(t.ownerId, 0));
        }
        claimedLegacy = true;
      }
      const token = await createSession(ctx, account.id);
      ctx.invalidateQueries();
      return { token, email, claimedLegacy };
    },
  }),

  login: defineAction({
    request: z.object({
      email: z.string().min(3).max(200),
      password: z.string().min(1).max(200),
    }),
    response: z.object({ token: z.string(), email: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const rows = await db.select().from(schema.accounts);
      const account = rows.find((a) => a.email.toLowerCase() === email);
      // Motivo específico e simples: a pessoa precisa saber SE o
      // problema é o e-mail (conta não existe) ou a senha (errada) —
      // uma mensagem única para os dois casos deixava ela tentando
      // sem saber o que corrigir.
      if (!account) {
        throw new Error(
          "Não existe conta com este e-mail. Confira o e-mail digitado ou toque em Criar conta para fazer uma nova.",
        );
      }
      if (!(await verifyPassword(args.password, account.passHash))) {
        throw new Error(
          "A senha está errada para este e-mail. Confira a senha e tente de novo.",
        );
      }
      const token = await createSession(ctx, account.id);
      ctx.invalidateQueries();
      return { token, email: account.email };
    },
  }),

  logout: defineAction({
    request: z.object({ session: sessionField }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (args.session) {
        const db = ctx.db<typeof schema>();
        const tokenHash = await sha256Hex(args.session);
        await db
          .delete(schema.sessions)
          .where(eq(schema.sessions.tokenHash, tokenHash));
      }
      return { ok: true as const };
    },
  }),

  me: defineAction({
    request: z.object({ session: sessionField }),
    response: z.object({ loggedIn: z.boolean(), email: z.string() }),
    async handler(ctx, args) {
      if (!args.session) return { loggedIn: false, email: "" };
      try {
        const ownerId = await requireAccount(ctx, args.session);
        const db = ctx.db<typeof schema>();
        const rows = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, ownerId));
        return { loggedIn: true, email: rows[0]?.email ?? "" };
      } catch {
        return { loggedIn: false, email: "" };
      }
    },
  }),

  // ---------------- Integrações de painéis IPTV (WPlay) ----------------

  saveIntegration: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive().optional(),
      name: z.string().min(1).max(120),
      url: z.string().min(1).max(500),
      panelUser: z.string().min(1).max(200),
      panelPass: z.string().max(300),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      let url = args.url.trim();
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      url = url.replace(/\/+$/, "");
      const values = {
        name: args.name.trim(),
        url,
        panelUser: args.panelUser.trim(),
      };
      if (args.id) {
        const rows = await db
          .select()
          .from(schema.integrations)
          .where(eq(schema.integrations.id, args.id));
        const existing = rows[0];
        if (!existing || existing.ownerId !== ownerId) {
          throw new Error("Integração não encontrada nesta conta.");
        }
        await db
          .update(schema.integrations)
          .set({
            ...values,
            panelPass: args.panelPass ? args.panelPass : existing.panelPass,
          })
          .where(eq(schema.integrations.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      if (!args.panelPass) throw new Error("Informe a senha do painel.");
      const inserted = await db
        .insert(schema.integrations)
        .values({
          ownerId,
          provider: "wplay",
          ...values,
          panelPass: args.panelPass,
        })
        .returning({ id: schema.integrations.id });
      const row = inserted[0];
      if (!row) throw new Error("saveIntegration: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteIntegration: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, args.id));
      if (!rows[0] || rows[0].ownerId !== ownerId) {
        throw new Error("Integração não encontrada nesta conta.");
      }
      // Servidores vinculados a ela voltam para "sem integração" —
      // nada fica apontando para uma integração que não existe mais.
      await db
        .update(schema.servers)
        .set({ panelIntegrationId: null, integrationMode: "nenhuma" })
        .where(eq(schema.servers.panelIntegrationId, args.id));
      await db
        .delete(schema.integrations)
        .where(eq(schema.integrations.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  testIntegration: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive(),
    }),
    response: z.object({
      status: z.string(),
      detail: z.string(),
    }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, args.id));
      const integration = rows[0];
      if (!integration || integration.ownerId !== ownerId) {
        throw new Error("Integração não encontrada nesta conta.");
      }
      const probe = await probePanelUrl(integration.url);
      let loginNote = "";
      const xtream = await probeXtreamApi(integration.url, integration.panelUser, integration.panelPass);
      if (xtream.kind === "auth_ok") {
        loginNote = " E o login foi CONFIRMADO pela API do painel (usuário e senha aceitos).";
      } else if (xtream.kind === "auth_fail") {
        loginNote = " A página do painel respondeu, mas a API do painel NÃO aceitou este usuário/senha — confira as credenciais.";
      } else {
        loginNote = " A página do painel respondeu; a confirmação automática do login não é oferecida por este painel, então usuário/senha não puderam ser validados por aqui.";
      }
      const status = probe.reachable && xtream.kind !== "auth_fail" ? "ativo" : "falhou";
      const detail = probe.reachable
        ? `Conexão OK: o painel respondeu (HTTP ${probe.httpStatus}) em ${probe.ms} ms.${loginNote}`
        : `Não conectou: ${probe.error} Confira a URL do servidor e tente de novo.`;
      await db
        .update(schema.integrations)
        .set({ status, testDetail: detail, testedAt: Date.now() })
        .where(eq(schema.integrations.id, integration.id));
      ctx.invalidateQueries();
      return { status, detail };
    },
  }),

  integrationInfo: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive(),
    }),
    response: z.object({ info: z.string() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, args.id));
      const integration = rows[0];
      if (!integration || integration.ownerId !== ownerId) {
        throw new Error("Integração não encontrada nesta conta.");
      }
      const probe = await probePanelUrl(integration.url);
      const info = probe.reachable
        ? [
            `Painel: ${integration.name} (WPlay)`,
            `URL: ${probe.finalUrl}`,
            `HTTP: ${probe.httpStatus} em ${probe.ms} ms`,
            probe.title ? `Título da página: ${probe.title}` : "Título da página: (não informado)",
            probe.serverHeader ? `Servidor web: ${probe.serverHeader}` : "Servidor web: (não informado)",
            `Usuário do painel: ${integration.panelUser}`,
            `Senha: salva no gestor (nunca exibida)`,
            `Status salvo: ${integration.status}`,
          ].join("\n")
        : `Não foi possível ler o painel agora: ${probe.error}`;
      await db
        .update(schema.integrations)
        .set({ panelInfo: info })
        .where(eq(schema.integrations.id, integration.id));
      ctx.invalidateQueries();
      return { info };
    },
  }),

  syncIntegrationIds: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive(),
    }),
    response: z.object({ detail: z.string(), synced: z.boolean() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, args.id));
      const integration = rows[0];
      if (!integration || integration.ownerId !== ownerId) {
        throw new Error("Integração não encontrada nesta conta.");
      }
      const xtream = await probeXtreamApi(integration.url, integration.panelUser, integration.panelPass);
      let detail: string;
      let synced = false;
      if (xtream.kind === "auth_ok" && xtream.info) {
        synced = true;
        detail = `IDs sincronizados da conta do painel: ${xtream.info}`;
      } else if (xtream.kind === "auth_fail") {
        detail =
          "A API do painel recusou este usuário/senha, então nenhum ID foi sincronizado. Confira as credenciais em Editar e tente de novo.";
      } else {
        detail =
          "Este painel não respondeu pela API de sincronização (player_api), então nenhum ID foi sincronizado. O vínculo e os testes de conexão continuam valendo; a sincronização automática de IDs depende dessa API no painel.";
      }
      await db
        .update(schema.integrations)
        .set({ syncDetail: detail, syncedAt: Date.now() })
        .where(eq(schema.integrations.id, integration.id));
      ctx.invalidateQueries();
      return { detail, synced };
    },
  }),

  linkIntegration: defineAction({
    request: z.object({
      session: sessionField,
      integrationId: z.number().int().positive(),
      serverId: z.number().int().positive(),
    }),
    response: z.object({ detail: z.string() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const intRows = await db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, args.integrationId));
      const integration = intRows[0];
      if (!integration || integration.ownerId !== ownerId) {
        throw new Error("Integração não encontrada nesta conta.");
      }
      const srvRows = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, args.serverId));
      const server = srvRows[0];
      if (!server || server.ownerId !== ownerId) {
        throw new Error("Servidor não encontrado nesta conta.");
      }
      await db
        .update(schema.servers)
        .set({
          integrationMode: "vinculada",
          panelIntegrationId: integration.id,
          panelUrl: integration.url,
          panelUser: integration.panelUser,
          panelPass: integration.panelPass,
        })
        .where(eq(schema.servers.id, server.id));
      ctx.invalidateQueries();
      return {
        detail: `Integração “${integration.name}” vinculada ao servidor “${server.name}”. Os testes e as renovações automáticas desse servidor usam este painel.`,
      };
    },
  }),

} satisfies ActionsModule;
