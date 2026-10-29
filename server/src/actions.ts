import { z } from "zod";
import QRCode from "qrcode";
import { defineAction, type ActionsModule, type Ctx } from "./sdk-shim";
import { privileged } from "./privileged";
import { asc, desc, eq, ne, sql } from "drizzle-orm";
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
  // E-mail (Resend) e valor padrão da assinatura, da administradora.
  // A chave do Resend NUNCA volta nas respostas: getState expõe só
  // hasResendKey. O valor padrão é 0 (sem valor) até ela definir.
  resendApiKey: "",
  resendFrom: "",
  defaultSubPriceCents: 0,
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
    resendApiKey: row.resendApiKey ?? "",
    resendFrom: row.resendFrom ?? "",
    defaultSubPriceCents: row.defaultSubPriceCents ?? 0,
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
    resendApiKey: string;
    resendFrom: string;
    defaultSubPriceCents: number;
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

// ---------------- Administração, teste grátis e assinatura ----------------
// A dona do gestor é a administradora: a primeira conta do banco (ou o
// e-mail de ADMIN_EMAIL, se definido no ambiente). SENHAS NUNCA SÃO
// EXIBIDAS: as contas guardam só o hash (passHash) e nenhuma ação
// devolve senha nem hash — a Administração vê e-mail, datas, status,
// valor e contagens. Conta vencida NUNCA perde dados: o bloqueio é
// só de acesso à interface; clientes, servidores, planos e cobranças
// permanecem intactos e voltam ao pagar (30 dias por pagamento).

const SUBSCRIPTION_DAYS = 30;
const TRIAL_DAYS = 7;

// QR Code do Pix da assinatura: gerado no servidor a partir do código
// Pix EXATO devolvido pelo Mercado Pago. Se a geração falhar, volta
// null e o código copiável continua valendo — o pagamento nunca
// quebra por causa do QR.
async function pixQrDataUrl(pixCode: string | null): Promise<string | null> {
  if (!pixCode) return null;
  try {
    return await QRCode.toDataURL(pixCode, { errorCorrectionLevel: "M", margin: 1, width: 280 });
  } catch {
    return null;
  }
}

type AccountRow = typeof schema.accounts.$inferSelect;

function isAdminAccount(row: Pick<AccountRow, "role" | "email">): boolean {
  if (row.role === "admin") return true;
  const envEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  return !!envEmail && row.email.toLowerCase() === envEmail;
}

async function loadAccountRow(ctx: Ctx, accountId: number): Promise<AccountRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  return rows[0] ?? null;
}

// A conta administradora: a de role 'admin', ou o e-mail de
// ADMIN_EMAIL, ou (último recurso) a de menor id — que é a conta
// criada primeiro no deploy, ou seja, a da dona.
async function findAdminAccountId(ctx: Ctx): Promise<number | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.accounts).orderBy(asc(schema.accounts.id));
  if (rows.length === 0) return null;
  const flagged = rows.find((r) => isAdminAccount(r));
  return (flagged ?? rows[0]!).id;
}

async function loadAdminSettings(ctx: Ctx): Promise<{ adminId: number | null; settings: SettingsObj }> {
  const adminId = await findAdminAccountId(ctx);
  if (adminId == null) return { adminId: null, settings: { ...DEFAULTS } };
  return { adminId, settings: await loadSettings(ctx, adminId) };
}

type AccountAccess = {
  isAdmin: boolean;
  role: string;
  subStatus: string;
  blocked: boolean;
  trialEndsAt: string | null;
  subExpiresAt: string | null;
  priceCents: number;
  daysLeft: number;
};

function computeAccountAccess(
  row: AccountRow,
  adminDefaultPriceCents: number,
  nowMs: number,
): AccountAccess {
  const isAdmin = isAdminAccount(row);
  const trialMs = row.trialEndsAt ? row.trialEndsAt.getTime() : null;
  const subMs = row.subExpiresAt ? row.subExpiresAt.getTime() : null;
  const ends = [trialMs, subMs].filter((v): v is number => v != null);
  const endMs = ends.length ? Math.max(...ends) : null;
  const daysLeft = endMs == null ? 0 : Math.max(0, Math.ceil((endMs - nowMs) / 86_400_000));
  // Bloqueio manual ('blocked') vale mesmo dentro do teste. Fora
  // disso, bloqueia quando o teste acabou E não há assinatura válida.
  const timeBlocked =
    (trialMs == null || nowMs > trialMs) && (subMs == null || nowMs > subMs);
  const blocked = !isAdmin && (row.subStatus === "blocked" || timeBlocked);
  return {
    isAdmin,
    role: row.role,
    subStatus: row.subStatus,
    blocked,
    trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
    subExpiresAt: row.subExpiresAt ? row.subExpiresAt.toISOString() : null,
    priceCents: row.subPriceCents > 0 ? row.subPriceCents : adminDefaultPriceCents,
    daysLeft,
  };
}

async function loadAccountAccess(ctx: Ctx, accountId: number): Promise<AccountAccess | null> {
  const row = await loadAccountRow(ctx, accountId);
  if (!row) return null;
  const { settings } = await loadAdminSettings(ctx);
  return computeAccountAccess(row, settings.defaultSubPriceCents, Date.now());
}

async function requireAdmin(ctx: Ctx, session: string | undefined): Promise<number> {
  const ownerId = await requireAccount(ctx, session);
  const row = await loadAccountRow(ctx, ownerId);
  if (!row || !isAdminAccount(row)) {
    throw new Error("Somente a administradora pode ver esta área.");
  }
  return ownerId;
}

// E-mail via Resend, com fetch puro (sem dependência nova). A chave
// nunca aparece em erro, log ou resposta.
async function sendResendEmail(args: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: args.from,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const msg =
        data && typeof data === "object" && "message" in data
          ? String((data as { message: unknown }).message)
          : `HTTP ${res.status}`;
      return { ok: false, detail: `O serviço de e-mail respondeu: ${msg}. Confira a chave e o remetente.` };
    }
    return { ok: true, detail: "E-mail enviado." };
  } catch {
    return { ok: false, detail: "Não foi possível falar com o serviço de e-mail nesta tentativa." };
  }
}

function resetLinkUrl(publicBaseUrl: string, token: string): string {
  const base = publicBaseUrl.trim().replace(/\/+$/, "");
  return `${base}#/redefinir-senha?token=${token}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Pagamento da assinatura aprovado: libera APENAS 30 dias, contados
// do fim do período atual (se ainda válido) ou de agora. Idempotente
// por cobrança: só aplica uma vez (status 'aprovado' + paidAt).
async function applySubscriptionApproval(
  ctx: Ctx,
  accountId: number,
  subscriptionPaymentId: number,
): Promise<Date> {
  const db = ctx.db<typeof schema>();
  const row = await loadAccountRow(ctx, accountId);
  const nowMs = Date.now();
  const baseMs = Math.max(nowMs, row?.subExpiresAt ? row.subExpiresAt.getTime() : 0);
  const expiresAt = new Date(baseMs + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000);
  await db
    .update(schema.subscriptionPayments)
    .set({ status: "aprovado", paidAt: new Date(nowMs) })
    .where(eq(schema.subscriptionPayments.id, subscriptionPaymentId));
  await db
    .update(schema.accounts)
    .set({ subExpiresAt: expiresAt, subStatus: "active" })
    .where(eq(schema.accounts.id, accountId));
  return expiresAt;
}

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
  // Linhas de provedor removido são ignoradas: nunca contam como
  // conectadas nem como prontas para extensão.
  const usableRows = rows.filter((r) => isSupportedPanelProvider(r.panelProvider ?? "wplay"));
  const simpleConnected = usableRows.find((r) => (r.panelConnected ?? 0) === 1);
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
  // apiVerified basta: o token emitido fica guardado no servidor
  // após o teste de autenticação passar.
  const verified = usableRows.find((r) => r.apiVerified === 1);
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
  const withToken = usableRows.find((r) => r.apiToken.length > 0);
  if (withToken) {
    return {
      connected: false,
      extendReady: false,
      detail:
        "Há um token da API do painel salvo, mas o teste de conexão ainda não passou. A renovação continua marcada como pendente até o teste de autenticação da API passar na aba Servidores.",
      extendDetail: "Extensão pendente: primeiro o teste de conexão da API precisa passar.",
    };
  }
  // TopSul: o token e o segredo ficam na integração vinculada, não
  // no servidor — por isso o servidor não aparece no caso acima.
  // Se há credencial TopSul salva mas o teste ainda não passou, o
  // motivo é o mesmo: falta o teste de conexão da integração.
  const intRows = await db.select().from(schema.integrations).where(eq(schema.integrations.ownerId, ownerId));
  const topsulPending = usableRows.find((r) => {
    if ((r.panelProvider ?? "wplay") !== "topsul" || r.panelIntegrationId == null) return false;
    const linked = intRows.find((x) => x.id === r.panelIntegrationId);
    return !!linked && linked.apiToken.length > 0;
  });
  if (topsulPending) {
    return {
      connected: false,
      extendReady: false,
      detail:
        "Há token e segredo da API TopSul salvos, mas o teste de conexão ainda não passou. A renovação continua marcada como pendente até o teste de conexão passar na aba Integrações (ou no cartão do servidor).",
      extendDetail: "Extensão pendente: primeiro o teste de conexão da API TopSul precisa passar.",
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
  const usableRows = rows.filter((r) => isSupportedPanelProvider(r.panelProvider ?? "wplay"));
  if (client.serverId != null) {
    const own = usableRows.find((r) => r.id === client.serverId);
    if (own && own.apiVerified === 1) return own;
  }
  return usableRows.find((r) => r.apiVerified === 1) ?? null;
}

function renderExtendTemplate(
  tpl: string,
  vars: { usuario: string; senha: string; dias: number; creditos: number; id?: string },
): string {
  return tpl
    .replaceAll("{usuario}", vars.usuario)
    .replaceAll("{senha}", vars.senha)
    .replaceAll("{dias}", String(vars.dias))
    .replaceAll("{creditos}", String(vars.creditos))
    .replaceAll("{id}", vars.id ?? "");
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
// Base da API do painel WPlay/WManage, EMBUTIDA no gestor: é o mesmo
// endereço para todo painel deste tipo, então ninguém precisa digitá-la
// nem saber que ela existe — o formulário pede só link, usuário e senha
// do painel. O TOKEN NÃO é embutido e nunca é um valor fixo: ele é
// emitido pela API a cada login com o usuário/senha do painel deste
// servidor e guardado nele, sem exibir. Um token embutido e igual para
// todo mundo daria a todas as contas o acesso de uma só — por isso o
// teste sempre entra com as credenciais do próprio servidor.
const DEFAULT_PANEL_API_BASE = "https://mcapi.knewcms.com:2087";
function resolvePanelApiBase(raw: string): string {
  const trimmed = raw.trim();
  return trimmed || DEFAULT_PANEL_API_BASE;
}

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
  topsul?: TopsulCreds | null,
): Promise<{ ok: boolean; detail: string }> {
  // TopSul: a renovação usa o endpoint renew_client com o token e o
  // segredo guardados na integração vinculada — nunca chama a API
  // WPlay. As credenciais chegam resolvidas por quem chama; sem
  // elas, volta como pendente sem chamar nada.
  if ((server.panelProvider ?? "wplay") === "topsul") {
    if (!topsul) {
      return {
        ok: false,
        detail: `Este servidor usa a integração TopSul, mas nenhuma integração TopSul está vinculada a ele. Vincule uma integração TopSul em Servidores → Editar para a renovação automática funcionar. Nada foi renovado no painel e nenhum crédito foi consumido.`,
      };
    }
    return topsulRenewClient(topsul, { iptvUser: args.iptvUser, days: args.days });
  }
  // Provedor removido do gestor: nunca chama API nenhuma — volta
  // como pendente com o motivo em linguagem simples.
  if (!isSupportedPanelProvider(server.panelProvider ?? "wplay")) {
    return { ok: false, detail: "Este servidor usa um provedor de painel que foi removido do gestor a pedido da dona. A renovação automática não funciona mais por ele; cadastre o painel como servidor WPlay (link, usuário e senha) para voltar a renovar automaticamente. Nada foi renovado e nenhum crédito foi consumido." };
  }
  const baseCheck = inspectPanelApiBase(resolvePanelApiBase(server.apiBase));
  if (!baseCheck.valid) return { ok: false, detail: `A base da API do painel está inválida: ${baseCheck.error}` };
  const base = baseCheck.normalized;
  if (!server.apiToken)
    return {
      ok: false,
      detail: `Extensão pendente do usuário ${args.iptvUser}: o servidor está conectado com link, usuário e senha do painel, mas a chamada de extensão da API deste painel pede o token emitido no login — e nenhum token foi guardado ainda neste servidor. Toque em “Testar conexão” neste servidor para o gestor entrar com o usuário e a senha do painel e guardar o token emitido. Nada foi renovado no painel e nenhum crédito foi consumido.`,
    };
  const credits = creditsForDays(args.days);
  // Fluxo documentado da API WPlay/WManage (referência oficial):
  // 1) GET /lines?generalSearch={usuário} lista clientes (busca
  // PARCIAL em username/whatsapp/notes) — é preciso escolher o item
  // cujo username é EXATAMENTE o do cliente, para nunca estender o
  // usuário errado. 2) PATCH /lines/v2/extend/{id} com {"days": N}.
  // Servidores salvos com o caminho antigo "/users/extend" (um
  // palpite que a API respondeu 404) usam a rota documentada sem a
  // dona precisar redigitar nada; caminho/método/corpo diferentes
  // desse padrão antigo continuam sendo respeitados, com {id}
  // disponível nos modelos.
  const LEGACY_EXTEND_PATH = "/users/extend";
  const DOCUMENTED_EXTEND_PATH = "/lines/v2/extend/{id}";
  const isLegacyExtend = (server.extendPath || "").trim() === LEGACY_EXTEND_PATH;
  const effPath = isLegacyExtend ? DOCUMENTED_EXTEND_PATH : server.extendPath || DOCUMENTED_EXTEND_PATH;
  const effMethod = isLegacyExtend ? "PATCH" : (server.extendMethod || "POST").toUpperCase();
  const effBodyTpl = isLegacyExtend ? '{"days":{dias}}' : (server.extendBody ?? "");
  let panelId: string;
  try {
    const lookupUrl = `${base}/lines?generalSearch=${encodeURIComponent(args.iptvUser)}`;
    const lookupRes = await fetch(lookupUrl, {
      headers: { Authorization: `Bearer ${server.apiToken}` },
      signal: AbortSignal.timeout(20000),
    });
    const lookupRaw = await lookupRes.text().catch(() => "");
    if (!lookupRes.ok) {
      const shownLookup = sanitizePanelResponseBody(lookupRaw, [server.apiToken, args.iptvPass], 500);
      const lookupFailure = panelResponseFailureMessage(lookupRaw);
      return {
        ok: false,
        detail: `Não foi possível localizar o usuário ${args.iptvUser} no painel para estender: a busca na API respondeu HTTP ${lookupRes.status}${lookupFailure ? ` — ${lookupFailure}` : ""}. ${shownLookup ? `Resposta da API: ${shownLookup}. ` : ""}Nada foi renovado no painel e nenhum crédito foi consumido.`,
      };
    }
    let items: unknown;
    try {
      const parsed = JSON.parse(lookupRaw) as Record<string, unknown>;
      items = parsed?.items;
    } catch {
      items = undefined;
    }
    if (!Array.isArray(items)) {
      return {
        ok: false,
        detail: `Não foi possível localizar o usuário ${args.iptvUser} no painel para estender: a busca na API não trouxe uma lista de clientes válida. Nada foi renovado no painel e nenhum crédito foi consumido.`,
      };
    }
    const exact = items.find(
      (it): it is Record<string, unknown> =>
        !!it && typeof it === "object" && (it as Record<string, unknown>).username === args.iptvUser,
    );
    if (!exact || (typeof exact.id !== "string" && typeof exact.id !== "number") || String(exact.id).trim() === "") {
      return {
        ok: false,
        detail: `O usuário ${args.iptvUser} não foi encontrado no painel (a busca trouxe só nomes parecidos, nenhum igual). Nada foi renovado no painel e nenhum crédito foi consumido. Confira se o usuário IPTV cadastrado no cliente está igual ao do painel.`,
      };
    }
    panelId = String(exact.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail: `Não foi possível localizar o usuário ${args.iptvUser} no painel para estender: ${sanitizePanelResponseBody(message, [server.apiToken, args.iptvPass], 300)}. Nada foi renovado no painel e nenhum crédito foi consumido.`,
    };
  }
  const vars = { usuario: args.iptvUser, senha: args.iptvPass, dias: args.days, creditos: credits, id: panelId };
  const path = renderExtendTemplate(effPath, vars);
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const method = effMethod;
  const bodyText = renderExtendTemplate(effBodyTpl, vars);
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
      let expDate = "";
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        if (typeof parsed?.exp_date === "string") expDate = parsed.exp_date;
      } catch {}
      return {
        ok: true,
        detail: `A API do painel aceitou a extensão (HTTP ${res.status}) do usuário ${args.iptvUser} por ${args.days} dias (${credits} crédito${credits > 1 ? "s" : ""}).${expDate ? ` Nova data de expiração no painel: ${expDate}.` : ""}`,
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
    "A conexão com a API já vem embutida no gestor: ele entra com o usuário e a senha do painel salvos neste servidor. Confira em Servidores → Editar se são o usuário e a senha do painel (não os de um cliente IPTV) e toque em “Testar conexão” de novo.",
    "Se a API emitir um token, o gestor guarda ele sozinho quando o teste passar — não há campo de token para preencher.",
    "O gestor só marca conectado quando uma variação responder sucesso.",
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
      "Não conectou: nenhum usuário e senha do painel estão salvos neste servidor para a API entrar, e nenhum token está salvo. Confira o usuário e a senha do painel em Servidores → Editar e toque em “Testar conexão” de novo.",
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

// ---------------- TopSul (painel CS TopSul) ----------------
// API documentada no openapi.json enviado pela dona (Painel CS
// TopSul v4.0.0, multi-revendedor): base + /topsul/*, autenticação
// em DUAS partes — o token vai no caminho da URL e o "secret" vai
// no corpo JSON de cada chamada. Só dois endpoints são usados:
// profile (teste de conexão) e renew_client (renovação). As
// respostas NÃO têm formato documentado (esquema vazio), então o
// teste e a renovação são PROVISÓRIOS até um teste real com
// credencial de verdade: HTTP 2xx sem marcador de erro no corpo
// conta como sucesso; corpo com marcador de erro fica pendente, sem
// fingir. A verificação TLS NUNCA é desligada: se o certificado do
// servidor estiver vencido/inválido, a chamada falha com mensagem
// em linguagem simples pedindo a renovação do certificado.

const DEFAULT_TOPSUL_API_BASE = "https://vmi2606883.contaboserver.net";

// Provedores de painel ativos no gestor. Qualquer outro valor em
// provider/panelProvider é um provedor removido: as linhas são
// ignoradas e nenhum dado é apagado.
function isSupportedPanelProvider(provider: string | null | undefined): boolean {
  return provider === "wplay" || provider === "topsul";
}

type TopsulCreds = { apiBase: string; token: string; secret: string };

function resolveTopsulApiBase(raw: string): string {
  const trimmed = raw.trim();
  return trimmed || DEFAULT_TOPSUL_API_BASE;
}

// Normaliza a base da API TopSul: sem espaços, sem barra final, com
// https:// e sem o caminho /topsul (os endpoints já incluem /topsul).
function inspectTopsulApiBase(raw: string): {
  original: string;
  valid: boolean;
  normalized: string;
  error: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const original = raw.trim();
  if (!original) {
    return { original, valid: false, normalized: "", error: "A base da API está vazia.", warnings };
  }
  let candidate = original.replace(/\s+/g, "");
  if (candidate !== original) warnings.push("Havia espaços na base; eles foram removidos para o teste.");
  if (candidate.endsWith("/")) {
    candidate = candidate.replace(/\/+$/, "");
    warnings.push("A base terminava com barra (/). A barra final foi removida.");
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
      valid: false,
      normalized: "",
      error: "A base da API não é um endereço válido. Ela precisa se parecer com https://vmi2606883.contaboserver.net.",
      warnings,
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      original,
      valid: false,
      normalized: "",
      error: `A base começa com “${url.protocol}”, mas a API precisa usar http:// ou https://.`,
      warnings,
    };
  }
  if (url.username || url.password) {
    warnings.push("A base tinha usuário/senha escritos dentro do endereço; eles foram ignorados. Token e segredo ficam nos campos próprios da integração.");
    url.username = "";
    url.password = "";
  }
  if (url.search || url.hash) {
    warnings.push("A base tinha texto depois de ? ou #; essa parte foi removida.");
    url.search = "";
    url.hash = "";
  }
  let path = url.pathname.replace(/\/{2,}/g, "/");
  while (path.toLowerCase().endsWith("/topsul")) {
    path = path.slice(0, -"/topsul".length);
    warnings.push("A base terminava em /topsul. Essa parte foi removida porque os endpoints já incluem /topsul no caminho.");
  }
  path = path.replace(/\/+$/, "");
  if (path) {
    warnings.push(`A base tem um caminho extra (${path}). O teste chamou esse caminho + /topsul/profile. Se a API fica direto no endereço principal, apague esse caminho da base.`);
  }
  const normalized = `${url.protocol}//${url.host}${path}`;
  return { original, valid: true, normalized, error: "", warnings: [...new Set(warnings)] };
}

const TOPSUL_CERT_DETAIL =
  "O certificado de segurança do servidor da API TopSul venceu ou é inválido, e o gestor não ignora essa verificação — nenhuma credencial foi enviada e nada foi renovado. Peça para quem cuida do servidor renovar o certificado e toque em “Testar conexão” de novo.";

// Erro de rede causado pelo certificado (vencido, autoassinado ou
// não confiável). A mensagem exata varia com o ambiente, então a
// detecção olha o texto do erro e da causa, sem desligar nada.
function isCertificateError(e: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; depth < 3 && current != null; depth++) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return /certificate|cert\b|ssl|tls|self.signed|unable to verify|ERR_CERT|certification/i.test(parts.join(" "));
}

type TopsulHttpResult =
  | { kind: "http"; status: number; body: string }
  | { kind: "network"; message: string; cert: boolean };

async function topsulPost(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<TopsulHttpResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    return { kind: "http", status: res.status, body: text };
  } catch (e) {
    const rawMessage = e instanceof Error ? e.message : String(e);
    const timedOut =
      e instanceof Error && (e.name === "TimeoutError" || /timed out|timeout|abort/i.test(rawMessage));
    return {
      kind: "network",
      message: timedOut
        ? `A API não respondeu dentro de ${Math.round(timeoutMs / 1000)} segundos.`
        : rawMessage,
      cert: isCertificateError(e),
    };
  }
}

// Campos óbvios de saldo no perfil, quando a resposta trouxer algum:
// só o que está de fato no corpo é mostrado — nada é inventado.
function topsulProfileBalanceNote(rawBody: string): string {
  try {
    const data = JSON.parse(rawBody) as unknown;
    if (!data || typeof data !== "object") return "";
    const obj = data as Record<string, unknown>;
    for (const key of ["credits", "creditsBalance", "credits_balance", "balance", "saldo", "creditos"]) {
      const value = obj[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return ` Saldo informado pelo painel: ${value} crédito(s).`;
      }
    }
    const nested = obj.data ?? obj.profile ?? obj.result;
    if (nested && typeof nested === "object") {
      for (const key of ["credits", "creditsBalance", "credits_balance", "balance", "saldo", "creditos"]) {
        const value = (nested as Record<string, unknown>)[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          return ` Saldo informado pelo painel: ${value} crédito(s).`;
        }
      }
    }
  } catch {}
  return "";
}

function topsulCorrectionSteps(classification: string): string[] {
  const common = [
    "O token e o segredo ficam salvos na integração TopSul (aba Integrações). Confira se são o token e o segredo desta conta de revendedor — cada conta tem os seus, e eles nunca são exibidos na tela.",
    "A base da API já vem preenchida no gestor. Se a API mudou de endereço, confira a base na integração.",
  ];
  if (classification === "certificado") {
    return [
      "O certificado de segurança do servidor da API venceu ou é inválido. Só quem cuida do servidor consegue renovar — o gestor não ignora essa verificação.",
      ...common,
    ];
  }
  if (classification === "credencial_recusada") {
    return [
      "A API respondeu, mas recusou o token ou o segredo. Gere um token/segredo novo no painel TopSul e salve na integração.",
      ...common,
    ];
  }
  if (classification === "base_ou_caminho_errado") {
    return [
      "A API respondeu que o endereço/caminho não existe. Confira a base da API na integração (ela não deve terminar em /topsul).",
      ...common,
    ];
  }
  if (classification === "sem_resposta") {
    return [
      "O gestor não recebeu resposta da API. Confira se a base está certa e se o servidor da API está fora do ar; tente novamente em alguns minutos.",
      ...common.slice(0, 1),
    ];
  }
  return common;
}

// Testa a conexão TopSul chamando POST /topsul/profile/{token} com
// {"secret"}. Só HTTP 2xx sem erro declarado no corpo marca
// conectado. Nenhum crédito é consumido. O token e o segredo nunca
// aparecem no diagnóstico (são substituídos antes de guardar).
async function topsulTestConnection(creds: TopsulCreds): Promise<PanelTestResult> {
  const testedAt = new Date().toISOString();
  const base = inspectTopsulApiBase(creds.apiBase);
  const endpoint = base.valid ? `${base.normalized}/topsul/profile/{token}` : "";
  const makeDiagnostic = (
    classification: string,
    headline: string,
    attempts: PanelAuthAttempt[],
    winningVariant = "",
  ): PanelDiagnostic => ({
    testedAt,
    endpoint,
    baseOriginal: base.original,
    baseNormalized: base.normalized,
    baseWarnings: base.warnings,
    classification,
    headline,
    winningVariant,
    responseBody: [...attempts].reverse().find((a) => a.httpStatus != null)?.responseBody ?? "",
    attempts,
    steps: topsulCorrectionSteps(classification),
  });
  if (!base.valid) {
    const diagnostic = makeDiagnostic("base_invalida", `Não conectou: ${base.error}`, []);
    return { connected: false, detail: diagnostic.headline, diagnostic };
  }
  if (!creds.token || !creds.secret) {
    const diagnostic = makeDiagnostic(
      "sem_credencial",
      "Não conectou: o token ou o segredo da API TopSul não estão salvos nesta integração. Preencha os dois na aba Integrações e toque em “Testar conexão” de novo.",
      [],
    );
    return { connected: false, detail: diagnostic.headline, diagnostic };
  }
  const url = `${base.normalized}/topsul/profile/${encodeURIComponent(creds.token)}`;
  const result = await topsulPost(url, { secret: creds.secret }, 10000);
  if (result.kind === "network") {
    const classification = result.cert ? "certificado" : "sem_resposta";
    const headline = result.cert
      ? `Não conectou: ${TOPSUL_CERT_DETAIL}`
      : "Não conectou: a API TopSul não respondeu. Ela pode estar fora do ar, ou a base salva leva a um endereço que não responde. A renovação continua pendente e nenhum crédito foi consumido.";
    const attempt: PanelAuthAttempt = {
      id: "profile",
      label: "Perfil (POST /topsul/profile/{token})",
      description: "Chamada de perfil da API TopSul com o token no caminho e o segredo no corpo.",
      httpStatus: null,
      responseBody: "",
      error: result.cert ? "Certificado de segurança vencido ou inválido." : sanitizePanelResponseBody(result.message, [creds.token, creds.secret], 240),
      success: false,
    };
    const diagnostic = makeDiagnostic(classification, headline, [attempt]);
    return { connected: false, detail: headline, diagnostic };
  }
  const shownBody = sanitizePanelResponseBody(result.body, [creds.token, creds.secret], 500);
  const failureMessage = panelResponseFailureMessage(result.body);
  const success = result.status >= 200 && result.status < 300 && !failureMessage;
  const attempt: PanelAuthAttempt = {
    id: "profile",
    label: "Perfil (POST /topsul/profile/{token})",
    description: "Chamada de perfil da API TopSul com o token no caminho e o segredo no corpo.",
    httpStatus: result.status,
    responseBody: shownBody,
    error: failureMessage ?? "",
    success,
  };
  if (success) {
    const headline = `Conectou: a API TopSul aceitou o token e o segredo (HTTP ${result.status}).${topsulProfileBalanceNote(result.body)} O painel passa a ser tratado como conectado neste gestor.`;
    return { connected: true, detail: headline, diagnostic: makeDiagnostic("conectado", headline, [attempt], "profile") };
  }
  let classification = "falha_autenticacao";
  let headline = "Não conectou: a API TopSul não aceitou o token ou o segredo. A renovação continua pendente e nenhum crédito foi consumido.";
  if (result.status === 401 || result.status === 403) {
    classification = "credencial_recusada";
    headline = `Não conectou: a API TopSul recusou a credencial (HTTP ${result.status}). Confira o token e o segredo salvos na integração. A renovação continua pendente e nenhum crédito foi consumido.`;
  } else if (result.status === 404) {
    classification = "base_ou_caminho_errado";
    headline = "Não conectou: a API TopSul respondeu HTTP 404. A base provavelmente leva a um endereço sem o caminho /topsul/profile. A renovação continua pendente e nenhum crédito foi consumido.";
  } else if (result.status === 400) {
    classification = "http_400_formato_ou_campo";
    headline = "Não conectou: a API TopSul respondeu HTTP 400. Isso é erro de formato/campo da chamada (corpo ou campo esperado), não prova de token errado. A renovação continua pendente e nenhum crédito foi consumido.";
  } else if (result.status >= 500) {
    classification = "erro_servidor_painel";
    headline = `Não conectou: a API TopSul respondeu erro interno (HTTP ${result.status}). Isso é falha do lado do painel neste momento. A renovação continua pendente e nenhum crédito foi consumido.`;
  } else if (result.status === 429) {
    classification = "limite_de_tentativas";
    headline = "Não conectou: a API TopSul respondeu HTTP 429 (muitas tentativas). Espere alguns minutos antes de testar de novo. A renovação continua pendente e nenhum crédito foi consumido.";
  }
  return { connected: false, detail: headline, diagnostic: makeDiagnostic(classification, headline, [attempt]) };
}

// Renova o usuário exato na API TopSul: POST
// /topsul/renew_client/{token} com {"secret","username","month"}.
// PROVISÓRIO (resposta sem formato documentado): HTTP 2xx sem
// marcador de erro no corpo conta como renovado; corpo vazio conta
// como renovado (não há marcador possível); corpo não-JSON e
// não-vazio, ou com marcador de erro, fica pendente. Nunca repete a
// chamada automaticamente. Nenhum crédito é dado como consumido
// quando a renovação fica pendente.
async function topsulRenewClient(
  creds: TopsulCreds,
  args: { iptvUser: string; days: number },
): Promise<{ ok: boolean; detail: string }> {
  if (args.days <= 0 || args.days % 30 !== 0) {
    return {
      ok: false,
      detail: `A renovação TopSul pede a duração em meses inteiros, e o plano tem ${args.days} dias — que não é múltiplo de 30. Nada foi renovado no painel e nenhum crédito foi consumido.`,
    };
  }
  const base = inspectTopsulApiBase(creds.apiBase);
  if (!base.valid) return { ok: false, detail: `A base da API TopSul está inválida: ${base.error}` };
  if (!creds.token || !creds.secret) {
    return {
      ok: false,
      detail: "A integração TopSul está sem token ou segredo salvos. Preencha os dois na aba Integrações e teste a conexão antes de renovar. Nada foi renovado no painel e nenhum crédito foi consumido.",
    };
  }
  const months = args.days / 30;
  const url = `${base.normalized}/topsul/renew_client/${encodeURIComponent(creds.token)}`;
  const result = await topsulPost(url, { secret: creds.secret, username: args.iptvUser, month: months }, 20000);
  if (result.kind === "network") {
    if (result.cert) {
      return { ok: false, detail: `A extensão no painel TopSul não foi concluída: ${TOPSUL_CERT_DETAIL}` };
    }
    return {
      ok: false,
      detail: `Não foi possível alcançar a API TopSul para renovar o usuário ${args.iptvUser}: ${sanitizePanelResponseBody(result.message, [creds.token, creds.secret], 300)}. Nada foi dado como renovado.`,
    };
  }
  const shownBody = sanitizePanelResponseBody(result.body, [creds.token, creds.secret], 500);
  const failureMessage = panelResponseFailureMessage(result.body);
  const trimmed = result.body.trim();
  let unparseable = false;
  if (trimmed) {
    try {
      JSON.parse(trimmed);
    } catch {
      unparseable = true;
    }
  }
  if (result.status >= 200 && result.status < 300 && !failureMessage && !unparseable) {
    return {
      ok: true,
      detail: `A API TopSul aceitou a renovação (HTTP ${result.status}) do usuário ${args.iptvUser} por ${months} mês(es).${shownBody ? ` Resposta da API: ${shownBody}` : ""}`,
    };
  }
  const reason = failureMessage
    ? ` — ${failureMessage}`
    : unparseable
      ? " — a resposta veio em formato que o gestor não conseguiu ler"
      : "";
  return {
    ok: false,
    detail: `A API TopSul não concluiu a renovação do usuário ${args.iptvUser}: HTTP ${result.status}${reason}. ${shownBody ? `Resposta da API: ${shownBody}. ` : ""}Nada foi dado como renovado.`,
  };
}

// Resolve as credenciais TopSul de um servidor pela integração
// vinculada a ele (panelIntegrationId). O token e o segredo ficam
// SÓ na integração — nunca são copiados para o servidor nem
// devolvidos para a tela.
async function resolveTopsulCreds(
  ctx: Ctx,
  server: typeof schema.servers.$inferSelect,
): Promise<TopsulCreds | null> {
  if (server.panelIntegrationId == null) return null;
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.integrations)
    .where(eq(schema.integrations.id, server.panelIntegrationId));
  const integration = rows[0];
  if (!integration || integration.ownerId !== server.ownerId) return null;
  if ((integration.provider ?? "wplay") !== "topsul") return null;
  return {
    apiBase: resolveTopsulApiBase(integration.apiBase ?? ""),
    token: integration.apiToken ?? "",
    secret: integration.apiSecret ?? "",
  };
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
  // Conta do gestor vencida/bloqueada não estende ninguém: o acesso
  // volta ao pagar, sem apagar nada — e nenhum crédito é consumido.
  const access = await loadAccountAccess(ctx, client.ownerId);
  if (access?.blocked) {
    return {
      panelServer: null,
      extend: {
        ok: false,
        detail:
          "A assinatura desta conta do gestor está vencida. Renove a assinatura do gestor para voltar a renovar clientes — nenhum dado foi apagado e nenhum crédito foi consumido.",
      },
    };
  }
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
      // Integração vinculada = um painel WPlay cadastrado na aba
      // Integrações desta mesma conta. A chamada de extensão usa a
      // configuração de API/extensão salva neste servidor apontando
      // para a URL da integração.
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
      if (!isSupportedPanelProvider(linked.provider ?? "wplay")) {
        return {
          panelServer: null,
          extend: {
            ok: false,
            detail: `A integração “${linked.name}” vinculada ao servidor “${own.name}” usa um provedor de painel que foi removido do gestor. A renovação fica pendente e nenhum crédito foi consumido. Vincule uma integração WPlay a este servidor para voltar a renovar automaticamente.`,
          },
        };
      }
      // TopSul vinculada: as credenciais (token + segredo) ficam na
      // integração e o teste de conexão dela é o que vale — o
      // servidor não guarda token próprio neste modelo.
      if ((linked.provider ?? "wplay") === "topsul") {
        if (!linked.apiToken || !linked.apiSecret) {
          return {
            panelServer: own,
            extend: {
              ok: false,
              detail: `A integração TopSul “${linked.name}” está sem token ou segredo salvos. Preencha os dois na aba Integrações e toque em “Testar conexão”. Nada foi renovado e nenhum crédito foi consumido.`,
            },
          };
        }
        if (linked.status !== "ativo") {
          return {
            panelServer: own,
            extend: {
              ok: false,
              detail: `A integração TopSul “${linked.name}” ainda não passou no teste de conexão. Toque em “Testar conexão” no cartão dela (aba Integrações) até passar — a renovação fica pendente e nenhum crédito foi consumido.`,
            },
          };
        }
        const topsulCreds: TopsulCreds = {
          apiBase: resolveTopsulApiBase(linked.apiBase ?? ""),
          token: linked.apiToken,
          secret: linked.apiSecret,
        };
        const extend = await panelExtendUser(
          { ...own, panelProvider: "topsul" },
          { iptvUser: client.iptvUser, iptvPass: client.iptvPass, days },
          topsulCreds,
        );
        return { panelServer: own, extend };
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
        panelProvider: "wplay",
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
    // crédito é consumido. Servidor TopSul (provedor vindo de um
    // vínculo anterior) resolve as credenciais na integração
    // vinculada, sem copiar segredo para o servidor.
    if ((own.panelProvider ?? "wplay") === "topsul") {
      const topsulCreds = await resolveTopsulCreds(ctx, own);
      if (!topsulCreds || !topsulCreds.token || !topsulCreds.secret) {
        return {
          panelServer: own,
          extend: {
            ok: false,
            detail: `O servidor “${own.name}” usa TopSul, mas nenhuma integração TopSul com token e segredo está vinculada a ele. Vincule uma integração TopSul em Servidores → Editar. Nada foi renovado e nenhum crédito foi consumido.`,
          },
        };
      }
      const extend = await panelExtendUser(own, {
        iptvUser: client.iptvUser,
        iptvPass: client.iptvPass,
        days,
      }, topsulCreds);
      return { panelServer: own, extend };
    }
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
  // Servidor de reserva TopSul: as credenciais vêm da integração
  // vinculada a ele; sem elas, a extensão fica pendente.
  const fallbackCreds =
    (panelServer.panelProvider ?? "wplay") === "topsul"
      ? await resolveTopsulCreds(ctx, panelServer)
      : null;
  if ((panelServer.panelProvider ?? "wplay") === "topsul" && !fallbackCreds) {
    return {
      panelServer,
      extend: {
        ok: false,
        detail:
          "O servidor de reserva usa TopSul, mas nenhuma integração TopSul com token e segredo está vinculada a ele. Vincule uma integração TopSul em Servidores → Editar. Nada foi renovado e nenhum crédito foi consumido.",
      },
    };
  }
  const extend = await panelExtendUser(panelServer, {
    iptvUser: client.iptvUser,
    iptvPass: client.iptvPass,
    days,
  }, fallbackCreds);
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
  args: {
    amountCents: number;
    clientName: string;
    clientId: number;
    payerEmail: string;
    description?: string;
    externalReference?: string;
  },
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
      : `cliente${args.clientId}@gestor-flex.com`;
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
        description: args.description ?? `Renovação Gestor Flex — ${args.clientName}`,
        payment_method_id: "pix",
        external_reference: args.externalReference ?? `gestor-cliente-${args.clientId}`,
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
      panelProvider: z.string(),
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
      apiBase: z.string(),
      hasApiToken: z.boolean(),
      hasApiSecret: z.boolean(),
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
  // Administração / assinatura: isAdmin só é true para a
  // administradora; tenants só vem preenchido para ela (sem senha
  // nem hash, nunca). access diz se a conta está bloqueada e até
  // quando vale o teste/assinatura.
  isAdmin: z.boolean(),
  access: z.object({
    blocked: z.boolean(),
    trialEndsAt: z.string().nullable(),
    subExpiresAt: z.string().nullable(),
    priceCents: z.number(),
    daysLeft: z.number(),
    subStatus: z.string(),
    role: z.string(),
  }),
  tenants: z.array(
    z.object({
      id: z.number(),
      email: z.string(),
      role: z.string(),
      createdAt: z.string(),
      trialEndsAt: z.string().nullable(),
      subExpiresAt: z.string().nullable(),
      subStatus: z.string(),
      subPriceCents: z.number(),
      lastLoginAt: z.string().nullable(),
      clientCount: z.number(),
      serverCount: z.number(),
      planCount: z.number(),
    }),
  ),
  adminSettings: z
    .object({
      defaultSubPriceCents: z.number(),
      resendFrom: z.string(),
      hasResendKey: z.boolean(),
    })
    .nullable(),
});

// ---------------- Backup e restauração: formato e validação ----------------
// Backup COMPLETO, só para a administradora: o arquivo é JSON com
// versão, e-mail da administradora dona do backup, TODAS as contas
// (com o hash da senha, para os logins continuarem os mesmos) e
// TODAS as linhas de todas as contas. As datas viajam como texto
// ISO e voltam a Date na importação; os ids antigos são guardados
// em __oldId só para remapear as referências (o banco gera ids
// novos, sem misturar os dados de uma conta com os de outra). A
// conta da administradora que restaura é preservada (mesmo id),
// para a sessão dela continuar valendo; as demais contas ganham
// ids novos. Sessões de outras contas e links de redefinição de
// senha não vão no arquivo (expiram sozinhos).
const BACKUP_KIND = "gestor-iptv-backup";
const BACKUP_VERSION = 2;
const BACKUP_MAX_BYTES = 10_000_000;

const BACKUP_DATE_FIELDS: Record<string, string[]> = {
  account: ["createdAt", "trialEndsAt", "subExpiresAt", "lastLoginAt"],
  servers: ["createdAt"],
  integrations: ["createdAt"],
  serverCreditLogs: ["createdAt"],
  plans: ["createdAt"],
  clients: ["expiresAt", "createdAt"],
  renewals: ["oldExpiresAt", "newExpiresAt", "createdAt"],
  payments: ["wouldExpireAt", "createdAt", "updatedAt"],
  expenses: ["createdAt"],
  coupons: ["createdAt"],
  settings: [],
  subscriptionPayments: ["createdAt", "paidAt"],
};

const BACKUP_COLUMNS: Record<string, string[]> = {
  account: ["email", "passHash", "role", "trialEndsAt", "subExpiresAt", "subPriceCents", "subStatus", "lastLoginAt", "createdAt"],
  servers: ["name", "panelUrl", "panelUser", "panelPass", "apiBase", "apiToken", "apiVerified", "apiStatusDetail", "apiDiagnostic", "extendPath", "extendMethod", "extendBody", "extendVerified", "extendStatusDetail", "panelConnected", "panelConnectionDetail", "panelConnectionTestedAt", "browserLocateFound", "browserLocateDetail", "browserLocateTestedAt", "browserLocateDiagnostic", "identifier", "initialCredits", "creditsBalance", "costPerCreditCents", "chargeByScreens", "notes", "active", "panelProvider", "integrationMode", "integrationServerId", "panelIntegrationId", "autoRenewEnabled", "sendVia", "appName", "appDownloadUrl", "downloaderCode", "serverUrl", "serverUrlBackup", "epgUrl", "pixEnabled", "pixInstructions", "createdAt"],
  integrations: ["provider", "name", "url", "panelUser", "panelPass", "apiBase", "apiToken", "apiSecret", "status", "testDetail", "testedAt", "panelInfo", "syncDetail", "syncedAt", "createdAt"],
  serverCreditLogs: ["serverId", "delta", "balanceAfter", "note", "createdAt"],
  plans: ["name", "days", "priceCents", "createdAt"],
  clients: ["name", "whatsapp", "iptvUser", "iptvPass", "serverId", "planId", "priceOverrideCents", "expiresAt", "status", "isTest", "referredBy", "app", "device", "screens", "source", "extraPanel", "listState", "invoiceToken", "createdAt"],
  renewals: ["clientId", "clientName", "iptvUser", "planName", "days", "credits", "amountCents", "oldExpiresAt", "newExpiresAt", "source", "message", "createdAt"],
  payments: ["clientId", "clientName", "amountCents", "days", "credits", "mode", "status", "mpPaymentId", "pixCode", "couponCode", "discountCents", "detail", "wouldExpireAt", "appliedRenewalId", "createdAt", "updatedAt"],
  expenses: ["description", "amountCents", "spentOn", "createdAt"],
  coupons: ["code", "percentOff", "active", "createdAt"],
  settings: ["warnDays", "mpAccessToken", "mpPublicKey", "mpVerified", "mpAccountLabel", "mpPayerEmail", "mpEnvironment", "liveMode", "renewedMessage", "expiredMessage", "chargeMessage", "whatsappStatus", "whatsappPhone", "waQrStatus", "waQrPhone", "waQrDetail", "waQrImage", "waQrUpdatedAt", "waBlockCalls", "waTranscribeAudio", "waAwayEnabled", "waAwayMessage", "publicBaseUrl", "invoiceTitle", "invoiceMessage", "invoiceColor", "warnMessage", "warnSoonMessage", "resendApiKey", "resendFrom", "defaultSubPriceCents"],
  subscriptionPayments: ["mpPaymentId", "amountCents", "status", "createdAt", "paidAt"],
};

const BACKUP_DATA_KEYS = [
  "servers",
  "integrations",
  "serverCreditLogs",
  "plans",
  "clients",
  "renewals",
  "payments",
  "expenses",
  "coupons",
  "settings",
  "subscriptionPayments",
] as const;

function backupInvalid(message: string): Error {
  return new Error(`Arquivo de backup inválido: ${message}`);
}

function parseBackupFile(backupJson: string): {
  exportedAt: string;
  ownerEmail: string;
  accounts: Record<string, unknown>[];
  data: Record<string, unknown[]>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(backupJson);
  } catch {
    throw backupInvalid("não foi possível ler o arquivo. Confira se é o arquivo .json do backup.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw backupInvalid("o formato não é o esperado.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== BACKUP_KIND) {
    throw backupInvalid("este arquivo não é um backup do gestor.");
  }
  if (obj.version !== BACKUP_VERSION) {
    throw backupInvalid(
      "este backup é de um formato antigo e não pode ser restaurado. Baixe um backup novo.",
    );
  }
  if (typeof obj.exportedAt !== "string" || !obj.exportedAt) {
    throw backupInvalid("falta a data em que o backup foi feito.");
  }
  if (typeof obj.ownerEmail !== "string" || !obj.ownerEmail.trim()) {
    throw backupInvalid("falta o e-mail da administradora dona do backup.");
  }
  if (!Array.isArray(obj.accounts) || obj.accounts.length === 0) {
    throw backupInvalid("falta a lista de contas do backup.");
  }
  const accounts = obj.accounts as Record<string, unknown>[];
  const seenEmails = new Set<string>();
  for (const account of accounts) {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw backupInvalid("uma conta veio em formato errado.");
    }
    if (typeof account.email !== "string" || !account.email.trim()) {
      throw backupInvalid("falta o e-mail de uma conta.");
    }
    if (typeof account.passHash !== "string" || !account.passHash) {
      throw backupInvalid("falta a senha guardada de uma conta.");
    }
    const email = account.email.trim().toLowerCase();
    if (seenEmails.has(email)) {
      throw backupInvalid("há duas contas com o mesmo e-mail.");
    }
    seenEmails.add(email);
  }
  if (!seenEmails.has(obj.ownerEmail.trim().toLowerCase())) {
    throw backupInvalid("a conta da administradora não está na lista de contas.");
  }
  if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) {
    throw backupInvalid("faltam os dados do backup.");
  }
  const data = obj.data as Record<string, unknown>;
  for (const key of BACKUP_DATA_KEYS) {
    if (!Array.isArray(data[key])) {
      throw backupInvalid(`falta a lista de ${key}.`);
    }
  }
  return {
    exportedAt: obj.exportedAt,
    ownerEmail: obj.ownerEmail.trim(),
    accounts,
    data: data as Record<string, unknown[]>,
  };
}

function pickBackupRow(table: string, row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw backupInvalid("um registro veio em formato errado.");
  }
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const col of BACKUP_COLUMNS[table]!) {
    if (col in src) out[col] = src[col];
  }
  for (const field of BACKUP_DATE_FIELDS[table] ?? []) {
    const value = out[field];
    if (value == null) {
      out[field] = null;
    } else if (typeof value === "string") {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw backupInvalid("uma data veio em formato errado.");
      out[field] = d;
    } else {
      throw backupInvalid("uma data veio em formato errado.");
    }
  }
  return out;
}

function stageBackupRows(parsed: ReturnType<typeof parseBackupFile>): {
  accounts: Array<Record<string, unknown> & { __oldId: number }>;
  servers: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  integrations: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  serverCreditLogs: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  plans: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  clients: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  renewals: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  payments: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  expenses: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  coupons: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  settings: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
  subscriptionPayments: Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>;
} {
  const staged: Record<string, Array<Record<string, unknown> & { __oldId: number; __oldOwnerId: number | null }>> = {};
  for (const key of BACKUP_DATA_KEYS) {
    staged[key] = parsed.data[key]!.map((row, index) => {
      const picked = pickBackupRow(key, row);
      const raw = row as Record<string, unknown>;
      const oldId = typeof raw.id === "number" ? raw.id : Number(raw.id);
      // ownerId nas tabelas de cada conta; accountId em
      // subscriptionPayments. Sem dono, a linha não pode ser
      // atribuída a ninguém e é descartada na importação.
      const ownerRaw = raw.ownerId ?? raw.accountId;
      const oldOwnerId = typeof ownerRaw === "number" ? ownerRaw : Number(ownerRaw);
      return {
        ...picked,
        __oldId: Number.isFinite(oldId) ? oldId : 1_000_000 + index,
        __oldOwnerId: Number.isFinite(oldOwnerId) ? oldOwnerId : null,
      };
    });
  }
  const accounts = parsed.accounts.map((row, index) => {
    const picked = pickBackupRow("account", row);
    const raw = row as Record<string, unknown>;
    const oldId = typeof raw.id === "number" ? raw.id : Number(raw.id);
    return { ...picked, __oldId: Number.isFinite(oldId) ? oldId : 1_000_000 + index };
  });
  return { accounts, ...(staged as any) };
}

function remapBackupId(map: Map<number, number>, value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return map.get(n) ?? null;
}


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
      // Mapa só dos servidores visíveis (WPlay e TopSul): o nome
      // exibido do servidor de um cliente deve ser um servidor que
      // existe na tela de Servidores. Cliente ligado a servidor
      // apagado ou oculto (provedor removido) mostra "Servidor
      // removido", não um nome de um servidor que a dona não vê mais.
      const visibleServerById = new Map<number, typeof schema.servers.$inferSelect>(
        serverRows.filter((x) => isSupportedPanelProvider(x.panelProvider ?? "wplay")).map((x) => [x.id, x]),
      );
      const planById = new Map<number, typeof schema.plans.$inferSelect>(planRows.map((x) => [x.id, x]));
      const invoiceTokens = await ensureInvoiceTokens(ctx, clientRows);
      // Acesso da própria conta (teste/assinatura/bloqueio) e, só
      // para a administradora, a lista de contas registradas — com
      // colunas explícitas, SEM passHash (senha/hash nunca voltam).
      const meRow = accountRows[0];
      const { settings: adminSettingsObj } = await loadAdminSettings(ctx);
      const access: AccountAccess = meRow
        ? computeAccountAccess(meRow, adminSettingsObj.defaultSubPriceCents, Date.now())
        : {
            isAdmin: false,
            role: "user",
            subStatus: "trial",
            blocked: false,
            trialEndsAt: null,
            subExpiresAt: null,
            priceCents: 0,
            daysLeft: 0,
          };
      let tenants: z.infer<typeof stateResponse>["tenants"] = [];
      if (access.isAdmin) {
        const allAccounts = await db.select().from(schema.accounts).orderBy(asc(schema.accounts.id));
        const [clientCounts, serverCounts, planCounts] = await Promise.all([
          db
            .select({ ownerId: schema.clients.ownerId, count: sql<number>`count(*)` })
            .from(schema.clients)
            .groupBy(schema.clients.ownerId),
          db
            .select({ ownerId: schema.servers.ownerId, count: sql<number>`count(*)` })
            .from(schema.servers)
            .groupBy(schema.servers.ownerId),
          db
            .select({ ownerId: schema.plans.ownerId, count: sql<number>`count(*)` })
            .from(schema.plans)
            .groupBy(schema.plans.ownerId),
        ]);
        const countOf = (
          rows: Array<{ ownerId: number; count: number | string }>,
          id: number,
        ): number => Number(rows.find((r) => r.ownerId === id)?.count ?? 0);
        tenants = allAccounts.map((a) => ({
          id: a.id,
          email: a.email,
          role: a.role,
          createdAt: a.createdAt.toISOString(),
          trialEndsAt: a.trialEndsAt ? a.trialEndsAt.toISOString() : null,
          subExpiresAt: a.subExpiresAt ? a.subExpiresAt.toISOString() : null,
          subStatus: a.subStatus,
          subPriceCents: a.subPriceCents,
          lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
          clientCount: countOf(clientCounts, a.id),
          serverCount: countOf(serverCounts, a.id),
          planCount: countOf(planCounts, a.id),
        }));
      }
      return {
        servers: serverRows
          .filter((x) => isSupportedPanelProvider(x.panelProvider ?? "wplay"))
          .map((x) => ({
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
          panelProvider: x.panelProvider ?? "wplay",
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
          const server = c.serverId != null ? visibleServerById.get(c.serverId) : undefined;
          const serverName =
            server?.name ?? (c.serverId != null ? "Servidor removido" : null);
          return {
            id: c.id,
            name: c.name,
            whatsapp: c.whatsapp ?? null,
            iptvUser: c.iptvUser,
            hasPass: c.iptvPass.length > 0,
            serverId: c.serverId ?? null,
            serverName: serverName,
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
        integrations: integrationRows
          .filter((x) => isSupportedPanelProvider(x.provider ?? "wplay"))
          .map((x) => ({
          id: x.id,
          provider: x.provider,
          name: x.name,
          url: x.url,
          panelUser: x.panelUser,
          hasPass: x.panelPass.length > 0,
          apiBase: x.apiBase ?? "",
          hasApiToken: x.apiToken.length > 0,
          hasApiSecret: (x.apiSecret ?? "").length > 0,
          status: x.status,
          testDetail: x.testDetail,
          testedAt: x.testedAt ? new Date(x.testedAt).toISOString() : null,
          panelInfo: x.panelInfo,
          syncDetail: x.syncDetail,
          syncedAt: x.syncedAt ? new Date(x.syncedAt).toISOString() : null,
          createdAt: x.createdAt.toISOString(),
        })),
        accountEmail: accountRows[0]?.email ?? "",
        isAdmin: access.isAdmin,
        access: {
          blocked: access.blocked,
          trialEndsAt: access.trialEndsAt,
          subExpiresAt: access.subExpiresAt,
          priceCents: access.priceCents,
          daysLeft: access.daysLeft,
          subStatus: access.subStatus,
          role: access.role,
        },
        tenants,
        adminSettings: access.isAdmin
          ? {
              defaultSubPriceCents: adminSettingsObj.defaultSubPriceCents,
              resendFrom: adminSettingsObj.resendFrom,
              hasResendKey: adminSettingsObj.resendApiKey.length > 0,
            }
          : null,
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
      // O provedor do painel segue a integração vinculada; sem
      // vínculo, o servidor mantém o provedor que já tinha
      // (servidor novo nasce "wplay", o padrão do banco).
      let linkedProvider: string | null = null;
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
        linkedProvider = intRows[0].provider ?? "wplay";
        if (!isSupportedPanelProvider(linkedProvider)) {
          throw new Error("Esta integração usa um provedor de painel que foi removido do gestor. Vincule uma integração WPlay ou TopSul.");
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
      const extendPath = keepText(args.extendPath, existing?.extendPath, "/lines/v2/extend/{id}") || "/lines/v2/extend/{id}";
      const extendMethod = keep(args.extendMethod, existing?.extendMethod as "POST" | "PUT" | "PATCH" | "GET" | undefined, "PATCH");
      const extendBody = keep(
        args.extendBody,
        existing?.extendBody,
        '{"days":{dias}}',
      );
      const initialCredits = existing ? 0 : (args.initialCredits ?? 0);

      const extra = {
        identifier: keepText(args.identifier, existing?.identifier),
        costPerCreditCents: keep(args.costPerCreditCents, existing?.costPerCreditCents, 0),
        chargeByScreens: keep(args.chargeByScreens, existing ? existing.chargeByScreens === 1 : undefined, false) ? 1 : 0,
        notes: keepText(args.notes, existing?.notes),
        integrationMode,
        panelIntegrationId,
        ...(linkedProvider ? { panelProvider: linkedProvider } : {}),
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
      // Provedor removido: o teste é recusado com o motivo em
      // linguagem simples, sem chamar API nenhuma. WPlay: o teste
      // de sempre, com usuário e senha do painel e a base embutida.
      const linkedRows = server.integrationMode === "vinculada" && server.panelIntegrationId != null
        ? await db
            .select()
            .from(schema.integrations)
            .where(eq(schema.integrations.id, server.panelIntegrationId))
        : [];
      const linked = linkedRows[0];
      const provider = linked?.provider ?? server.panelProvider ?? "wplay";
      if (!isSupportedPanelProvider(provider)) {
        const detail =
          "Este servidor usa um provedor de painel que foi removido do gestor a pedido da dona. A renovação automática não funciona mais por ele; cadastre o painel como servidor WPlay (link, usuário e senha) para voltar a renovar automaticamente. Nada foi renovado e nenhum crédito foi consumido.";
        return {
          connected: false,
          detail,
          diagnostic: {
            testedAt: new Date().toISOString(),
            endpoint: "",
            baseOriginal: "",
            baseNormalized: "",
            baseWarnings: [],
            classification: "provedor_removido",
            headline: detail,
            winningVariant: "",
            responseBody: "",
            attempts: [],
            steps: [],
          },
        };
      }
      // TopSul: o teste chama o perfil da API TopSul com o token e o
      // segredo guardados na integração vinculada. O resultado espelha
      // no servidor (apiVerified, usado pelo cartão) E na integração
      // (status, usado pela renovação) — os dois passam a valer juntos.
      if (provider === "topsul") {
        const topsulCreds = await resolveTopsulCreds(ctx, server);
        if (!topsulCreds) {
          const detail =
            "Este servidor usa TopSul, mas nenhuma integração TopSul está vinculada a ele. Vincule uma integração TopSul em Servidores → Editar e toque em “Testar conexão” de novo. Nada foi renovado e nenhum crédito foi consumido.";
          return {
            connected: false,
            detail,
            diagnostic: {
              testedAt: new Date().toISOString(),
              endpoint: "",
              baseOriginal: "",
              baseNormalized: "",
              baseWarnings: [],
              classification: "sem_credencial",
              headline: detail,
              winningVariant: "",
              responseBody: "",
              attempts: [],
              steps: [
                "Vincule uma integração TopSul a este servidor em Servidores → Editar, com token e segredo salvos na integração.",
              ],
            },
          };
        }
        const result = await topsulTestConnection(topsulCreds);
        await db
          .update(schema.servers)
          .set({
            apiVerified: result.connected ? 1 : 0,
            apiStatusDetail: result.detail,
            apiDiagnostic: JSON.stringify(result.diagnostic),
          })
          .where(eq(schema.servers.id, server.id));
        if (server.panelIntegrationId != null) {
          await db
            .update(schema.integrations)
            .set({
              status: result.connected ? "ativo" : "falhou",
              testDetail: result.detail,
              testedAt: Date.now(),
            })
            .where(eq(schema.integrations.id, server.panelIntegrationId));
        }
        ctx.invalidateQueries();
        return { connected: result.connected, detail: result.detail, diagnostic: result.diagnostic };
      }
      // A API pede usuário e senha do painel: o teste envia os salvos
      // neste servidor (e o token, se houver). A base da API já vem
      // embutida no gestor (resolvePanelApiBase). Se a API emitir um
      // token, ele fica guardado neste servidor para as extensões.
      const result = await panelTestConnection(
        resolvePanelApiBase(server.apiBase),
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
      const linkedGateRows = server.integrationMode === "vinculada" && server.panelIntegrationId != null
        ? await db
            .select()
            .from(schema.integrations)
            .where(eq(schema.integrations.id, server.panelIntegrationId))
        : [];
      const gateProvider = linkedGateRows[0]?.provider ?? server.panelProvider ?? "wplay";
      if (!isSupportedPanelProvider(gateProvider)) {
        return {
          extended: false,
          detail:
            "Este servidor usa um provedor de painel que foi removido do gestor a pedido da dona. A renovação automática não funciona mais por ele; cadastre o painel como servidor WPlay (link, usuário e senha) para voltar a renovar automaticamente. Nenhuma extensão foi tentada e nenhum crédito foi consumido.",
          newExpiresAt: null,
        };
      }
      // TopSul: vale o teste de conexão da integração (status) ou o
      // teste do cartão do servidor (apiVerified) — os dois espelham
      // o mesmo resultado. Sem nenhum dos dois, o teste é recusado
      // antes de qualquer chamada que renove de verdade.
      let topsulCreds: TopsulCreds | null = null;
      if (gateProvider === "topsul") {
        topsulCreds = await resolveTopsulCreds(ctx, server);
        const linkedStatus = linkedGateRows[0]?.status;
        if (server.apiVerified !== 1 && linkedStatus !== "ativo") {
          return {
            extended: false,
            detail:
              "Antes do teste de extensão, toque em “Testar conexão” até a API TopSul passar (no cartão do servidor ou no cartão da integração). Nenhuma extensão foi tentada e nenhum crédito foi consumido.",
            newExpiresAt: null,
          };
        }
        if (!topsulCreds || !topsulCreds.token || !topsulCreds.secret) {
          return {
            extended: false,
            detail:
              "A integração TopSul vinculada a este servidor está sem token ou segredo salvos. Preencha os dois na aba Integrações e teste a conexão. Nenhuma extensão foi tentada e nenhum crédito foi consumido.",
            newExpiresAt: null,
          };
        }
      } else if (server.apiVerified !== 1) {
        return {
          extended: false,
          detail:
            "Antes do teste de extensão, toque em “Testar conexão” até a autenticação da API passar (ela usa o usuário e a senha do painel salvos neste servidor e guarda o token emitido, se houver). Nenhuma extensão foi tentada e nenhum crédito foi consumido.",
          newExpiresAt: null,
        };
      }
      const { client, plan } = await loadClientAndPlan(ctx, args.clientId);
      if (client.ownerId !== ownerId) throw new Error("Cliente não encontrado nesta conta.");
      // Cliente arquivado ou na lixeira não pode ser estendido: ele não
      // aparece mais na lista de clientes nem na lista do teste, e uma
      // chamada antiga não pode renovar (e consumir crédito) por ele.
      if (client.listState !== "normal") {
        return {
          extended: false,
          detail:
            "Este cliente está arquivado ou na lixeira, por isso não pode ser estendido. Restaure o cliente na aba Clientes para estender de novo. Nenhum crédito foi consumido.",
          newExpiresAt: null,
        };
      }
      // O servidor como está: no vínculo, link/usuário/senha da
      // integração já foram copiados para o servidor ao vincular.
      // TopSul resolve token/segredo na integração vinculada.
      const effectiveServer = server;
      const result = await panelExtendUser(effectiveServer, {
        iptvUser: client.iptvUser,
        iptvPass: client.iptvPass,
        days: plan.days,
      }, topsulCreds);
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
    response: paymentShape.extend({
      // QR Code do Pix desta fatura: gerado no servidor a partir do
      // código Pix EXATO desta cobrança (mesmo helper da assinatura).
      // Null quando a geração falha — a chave copiável continua
      // valendo e o pagamento nunca quebra por causa do QR.
      qrDataUrl: z.string().nullable(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<z.infer<typeof paymentShape> & { qrDataUrl: string | null }> {
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
      // Conta do gestor vencida/bloqueada não gera cobrança Pix para
      // os clientes IPTV dela: o acesso volta ao pagar, sem apagar
      // nada. A fatura pública do cliente também fica sem Pix novo
      // até a assinatura do gestor ser renovada.
      const tenantAccess = await loadAccountAccess(ctx, client.ownerId);
      if (tenantAccess?.blocked) {
        throw new Error(
          "A assinatura desta conta do gestor está vencida. Renove a assinatura do gestor para gerar novas cobranças — nenhum dado foi apagado.",
        );
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
        qrDataUrl: await pixQrDataUrl(row.pixCode ?? null),
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
      // Assinaturas do gestor: consulta as cobranças de assinatura
      // pendentes com o Mercado Pago da administradora e, ao
      // aprovar, libera 30 dias (uma vez só por cobrança). Nenhum
      // dado de conta vencida é apagado em nenhum caminho aqui.
      const subPending = await db
        .select()
        .from(schema.subscriptionPayments)
        .where(eq(schema.subscriptionPayments.status, "pendente"))
        .orderBy(asc(schema.subscriptionPayments.id));
      for (const sub of subPending.slice(0, 25)) {
        if (!sub.mpPaymentId) continue;
        const { settings: adminSettings } = await loadAdminSettings(ctx);
        if (!adminSettings.mpAccessToken) continue;
        const subCheck = await mpGetPaymentStatus(adminSettings.mpAccessToken, sub.mpPaymentId);
        if (!subCheck.ok) continue;
        if (subCheck.status === "approved") {
          await applySubscriptionApproval(ctx, sub.accountId, sub.id);
        } else if (subCheck.status === "rejected" || subCheck.status === "cancelled") {
          await db
            .update(schema.subscriptionPayments)
            .set({ status: "recusado" })
            .where(eq(schema.subscriptionPayments.id, sub.id));
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
      const now = new Date();
      const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      const inserted = await db
        .insert(schema.accounts)
        .values({
          email,
          passHash,
          // A primeira conta do banco é a administradora (dona). Conta
          // nova começa em teste grátis de 7 dias (subStatus 'trial').
          role: isFirstAccount ? "admin" : "user",
          trialEndsAt,
          subStatus: isFirstAccount ? "active" : "trial",
          lastLoginAt: now,
        })
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
      // E-mail de boas-vindas (melhor esforço): só sai se a
      // administradora configurou o envio (chave Resend). Traz o
      // endereço do gestor, o e-mail e o fim do teste — NUNCA a
      // senha. Se o e-mail falhar, o registro continua valendo.
      try {
        const { settings: adminSettings } = await loadAdminSettings(ctx);
        if (adminSettings.resendApiKey && adminSettings.resendFrom && !isFirstAccount) {
          const gestorUrl = adminSettings.publicBaseUrl
            ? adminSettings.publicBaseUrl.replace(/\/+$/, "")
            : "";
          const trialText = fmtDate(trialEndsAt);
          await sendResendEmail({
            apiKey: adminSettings.resendApiKey,
            from: adminSettings.resendFrom,
            to: email,
            subject: "Bem-vindo ao Gestor Flex — sua conta foi criada",
            text: `Sua conta no Gestor Flex foi criada.\n\nE-mail de acesso: ${email}\nTeste grátis até: ${trialText}\n\nAcesse o gestor em: ${gestorUrl || "o endereço que a administradora informou"}\n\nDepois do teste, é só renovar a assinatura para continuar usando — nenhum dado é apagado.\n\nSe esquecer a senha, use "Esqueci a senha" na tela de login.`,
            html: `<p>Sua conta no Gestor Flex foi criada.</p><p><strong>E-mail de acesso:</strong> ${escapeHtml(email)}<br><strong>Teste grátis até:</strong> ${escapeHtml(trialText)}</p><p>Acesse o gestor em: ${gestorUrl ? `<a href="${escapeHtml(gestorUrl)}">${escapeHtml(gestorUrl)}</a>` : "o endereço que a administradora informou"}</p><p>Depois do teste, é só renovar a assinatura para continuar usando — nenhum dado é apagado.</p><p>Se esquecer a senha, use "Esqueci a senha" na tela de login.</p>`,
          });
        }
      } catch {
        // E-mail de boas-vindas nunca quebra o registro.
      }
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
      await db
        .update(schema.accounts)
        .set({ lastLoginAt: new Date() })
        .where(eq(schema.accounts.id, account.id));
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

  // ---------------- Administração, assinatura e senha esquecida ----------------
  // Tudo aqui é só da administradora (exceto a assinatura do próprio
  // inquilino e a redefinição de senha). Nenhuma resposta traz senha
  // nem hash: a lista de contas mostra e-mail, datas, status, valor
  // e contagens. O bloqueio nunca apaga dados — é só de acesso.

  listTenantAccounts: defineAction({
    request: z.object({ session: sessionField }),
    response: z.object({
      tenants: z.array(
        z.object({
          id: z.number(),
          email: z.string(),
          role: z.string(),
          createdAt: z.string(),
          trialEndsAt: z.string().nullable(),
          subExpiresAt: z.string().nullable(),
          subStatus: z.string(),
          subPriceCents: z.number(),
          lastLoginAt: z.string().nullable(),
          clientCount: z.number(),
          serverCount: z.number(),
          planCount: z.number(),
        }),
      ),
    }),
    async handler(ctx, args) {
      await requireAdmin(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const allAccounts = await db.select().from(schema.accounts).orderBy(asc(schema.accounts.id));
      const [clientCounts, serverCounts, planCounts] = await Promise.all([
        db
          .select({ ownerId: schema.clients.ownerId, count: sql<number>`count(*)` })
          .from(schema.clients)
          .groupBy(schema.clients.ownerId),
        db
          .select({ ownerId: schema.servers.ownerId, count: sql<number>`count(*)` })
          .from(schema.servers)
          .groupBy(schema.servers.ownerId),
        db
          .select({ ownerId: schema.plans.ownerId, count: sql<number>`count(*)` })
          .from(schema.plans)
          .groupBy(schema.plans.ownerId),
      ]);
      const countOf = (
        rows: Array<{ ownerId: number; count: number | string }>,
        id: number,
      ): number => Number(rows.find((r) => r.ownerId === id)?.count ?? 0);
      return {
        tenants: allAccounts.map((a) => ({
          id: a.id,
          email: a.email,
          role: a.role,
          createdAt: a.createdAt.toISOString(),
          trialEndsAt: a.trialEndsAt ? a.trialEndsAt.toISOString() : null,
          subExpiresAt: a.subExpiresAt ? a.subExpiresAt.toISOString() : null,
          subStatus: a.subStatus,
          subPriceCents: a.subPriceCents,
          lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
          clientCount: countOf(clientCounts, a.id),
          serverCount: countOf(serverCounts, a.id),
          planCount: countOf(planCounts, a.id),
        })),
      };
    },
  }),

  setTenantPrice: defineAction({
    request: z.object({
      session: sessionField,
      accountId: z.number().int().positive(),
      priceCents: z.number().int().min(0).max(10_000_000),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      await requireAdmin(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const row = await loadAccountRow(ctx, args.accountId);
      if (!row) throw new Error("Conta não encontrada.");
      if (isAdminAccount(row)) throw new Error("A conta administradora não tem valor de assinatura.");
      await db
        .update(schema.accounts)
        .set({ subPriceCents: args.priceCents })
        .where(eq(schema.accounts.id, args.accountId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  grantTenantAccess: defineAction({
    request: z.object({
      session: sessionField,
      accountId: z.number().int().positive(),
      days: z.number().int().min(1).max(365),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      await requireAdmin(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const row = await loadAccountRow(ctx, args.accountId);
      if (!row) throw new Error("Conta não encontrada.");
      const nowMs = Date.now();
      const baseMs = Math.max(nowMs, row.subExpiresAt ? row.subExpiresAt.getTime() : 0);
      await db
        .update(schema.accounts)
        .set({
          subExpiresAt: new Date(baseMs + args.days * 24 * 60 * 60 * 1000),
          subStatus: "active",
        })
        .where(eq(schema.accounts.id, args.accountId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setTenantBlocked: defineAction({
    request: z.object({
      session: sessionField,
      accountId: z.number().int().positive(),
      blocked: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      await requireAdmin(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const row = await loadAccountRow(ctx, args.accountId);
      if (!row) throw new Error("Conta não encontrada.");
      if (isAdminAccount(row)) throw new Error("A conta administradora nunca é bloqueada.");
      // Bloqueio manual: não apaga nada, só impede o acesso à
      // interface até a administradora desbloquear ou a conta pagar.
      await db
        .update(schema.accounts)
        .set({ subStatus: args.blocked ? "blocked" : "active" })
        .where(eq(schema.accounts.id, args.accountId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  adminResetLink: defineAction({
    request: z.object({ session: sessionField, accountId: z.number().int().positive() }),
    response: z.object({ link: z.string() }),
    async handler(ctx, args) {
      await requireAdmin(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const row = await loadAccountRow(ctx, args.accountId);
      if (!row) throw new Error("Conta não encontrada.");
      // Invalida links anteriores desta conta: só o link novo vale.
      await db
        .update(schema.passwordResets)
        .set({ used: 1 })
        .where(eq(schema.passwordResets.accountId, args.accountId));
      const token = generateInvoiceToken();
      await db.insert(schema.passwordResets).values({
        accountId: args.accountId,
        tokenHash: await sha256Hex(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        used: 0,
      });
      const { settings } = await loadAdminSettings(ctx);
      return { link: resetLinkUrl(settings.publicBaseUrl, token) };
    },
  }),

  adminEmailSettings: defineAction({
    request: z.object({
      session: sessionField,
      resendApiKey: z.string().max(400),
      resendFrom: z.string().max(200),
      defaultSubPriceCents: z.number().int().min(0).max(10_000_000),
    }),
    response: z.object({ ok: z.literal(true), hasResendKey: z.boolean() }),
    async handler(ctx, args) {
      const ownerId = await requireAdmin(ctx, args.session);
      const s = await loadSettings(ctx, ownerId);
      // Chave em branco mantém a salva (mesmo padrão do Mercado Pago):
      // a chave nunca volta para a tela.
      const key = args.resendApiKey.trim() ? args.resendApiKey.trim() : s.resendApiKey;
      await persistSettings(ctx, ownerId, {
        resendApiKey: key,
        resendFrom: args.resendFrom.trim(),
        defaultSubPriceCents: args.defaultSubPriceCents,
      });
      ctx.invalidateQueries();
      return { ok: true as const, hasResendKey: key.length > 0 };
    },
  }),

  testEmailSend: defineAction({
    request: z.object({ session: sessionField, to: z.string().max(200).optional() }),
    response: z.object({ ok: z.boolean(), detail: z.string() }),
    async handler(ctx, args) {
      const ownerId = await requireAdmin(ctx, args.session);
      const s = await loadSettings(ctx, ownerId);
      const db = ctx.db<typeof schema>();
      const meRow = await loadAccountRow(ctx, ownerId);
      const to = (args.to ?? "").trim() || meRow?.email || "";
      if (!s.resendApiKey || !s.resendFrom) {
        return {
          ok: false,
          detail: "Falta configurar a chave do Resend e o remetente antes de testar o envio.",
        };
      }
      if (!to) return { ok: false, detail: "Informe um e-mail de destino para o teste." };
      const result = await sendResendEmail({
        apiKey: s.resendApiKey,
        from: s.resendFrom,
        to,
        subject: "Teste de e-mail do Gestor Flex",
        text: "Este é um e-mail de teste do Gestor Flex. Se você recebeu, o envio de e-mails está funcionando.",
        html: "<p>Este é um e-mail de teste do Gestor Flex. Se você recebeu, o envio de e-mails está funcionando.</p>",
      });
      return result;
    },
  }),

  // ---------------- Backup e restauração (só a administradora) ----------------
  // O backup é o arquivo de segurança da conta da administradora: ele
  // guarda TUDO que é dela (clientes, servidores, planos, cobranças,
  // configurações com as chaves salvas, mensagens e pagamentos da
  // assinatura) para trazer de volta se o banco de dados gratuito
  // expirar. Regras de segurança, sem exceção:
  // - só a administradora exporta e importa (o servidor recusa
  //   qualquer outra conta);
  // - o arquivo só restaura na conta do MESMO e-mail do backup;
  // - a restauração substitui TODOS os dados do gestor (todas as
  //   contas e todas as linhas), em transação: nada de uma conta
  //   se mistura com outra;
  // - sessões de login e links de redefinição de senha NÃO vão no
  //   arquivo (expiram sozinhos e não fazem sentido fora do banco);
  // - a senha de cada conta vai só como hash (passHash), como já
  //   fica guardada no banco — os logins continuam os mesmos depois
  //   de restaurar. O arquivo contém senhas e chaves: quem baixa
  //   deve guardar com cuidado e nunca compartilhar.
  // - o WhatsApp NÃO vai no backup: depois de restaurar é preciso
  //   ler um novo QR Code.
  exportBackup: defineAction({
    request: z.object({ session: sessionField }),
    response: z.object({
      backupJson: z.string(),
      exportedAt: z.string(),
      email: z.string(),
      counts: z.record(z.string(), z.number()),
    }),
    async handler(ctx, args) {
      const adminId = await requireAdmin(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const accountRow = await loadAccountRow(ctx, adminId);
      if (!accountRow) throw new Error("Conta não encontrada.");
      const [accounts, servers, integrations, serverCreditLogs, plans, clients, renewals, payments, expenses, coupons, settings, subscriptionPayments] =
        await Promise.all([
          db.select().from(schema.accounts).orderBy(asc(schema.accounts.id)),
          db.select().from(schema.servers),
          db.select().from(schema.integrations),
          db.select().from(schema.serverCreditLogs),
          db.select().from(schema.plans),
          db.select().from(schema.clients),
          db.select().from(schema.renewals),
          db.select().from(schema.payments),
          db.select().from(schema.expenses),
          db.select().from(schema.coupons),
          db.select().from(schema.settings),
          db.select().from(schema.subscriptionPayments),
        ]);
      const exportedAt = new Date().toISOString();
      const payload = {
        kind: BACKUP_KIND,
        version: BACKUP_VERSION,
        exportedAt,
        ownerEmail: accountRow.email,
        accounts,
        data: {
          servers,
          integrations,
          serverCreditLogs,
          plans,
          clients,
          renewals,
          payments,
          expenses,
          coupons,
          settings,
          subscriptionPayments,
        },
      };
      const counts: Record<string, number> = {
        contas: accounts.length,
        servidores: servers.length,
        integrações: integrations.length,
        movimentações: serverCreditLogs.length,
        planos: plans.length,
        clientes: clients.length,
        renovações: renewals.length,
        cobranças: payments.length,
        despesas: expenses.length,
        cupons: coupons.length,
        configurações: settings.length,
        pagamentos: subscriptionPayments.length,
      };
      return { backupJson: JSON.stringify(payload), exportedAt, email: accountRow.email, counts };
    },
  }),

  importBackup: defineAction({
    request: z.object({ session: sessionField, backupJson: z.string().max(BACKUP_MAX_BYTES) }),
    response: z.object({
      ok: z.literal(true),
      email: z.string(),
      exportedAt: z.string(),
      counts: z.record(z.string(), z.number()),
    }),
    async handler(ctx, args) {
      const adminId = await requireAdmin(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const accountRow = await loadAccountRow(ctx, adminId);
      if (!accountRow) throw new Error("Conta não encontrada.");
      // Validação completa ANTES de tocar no banco: arquivo inválido
      // ou de outra conta não altera nada.
      const parsed = parseBackupFile(args.backupJson);
      const backupEmail = parsed.ownerEmail.trim().toLowerCase();
      if (backupEmail !== accountRow.email.trim().toLowerCase()) {
        throw new Error(
          "Este backup pertence a outra administradora. Entre com a conta dona do backup para restaurar.",
        );
      }
      const staged = stageBackupRows(parsed);
      const counts: Record<string, number> = {};
      try {
        await db.transaction(async (tx) => {
          // Apaga TUDO: a restauração completa substitui o banco
          // inteiro. Preserva só a linha da administradora que
          // restaura (a sessão dela continua valendo) e as sessões
          // dela; sessões de outras contas e links de redefinição
          // de senha são descartados (expiram sozinhos).
          await tx.delete(schema.subscriptionPayments);
          await tx.delete(schema.payments);
          await tx.delete(schema.renewals);
          await tx.delete(schema.serverCreditLogs);
          await tx.delete(schema.clients);
          await tx.delete(schema.plans);
          await tx.delete(schema.servers);
          await tx.delete(schema.integrations);
          await tx.delete(schema.expenses);
          await tx.delete(schema.coupons);
          await tx.delete(schema.settings);
          await tx.delete(schema.accounts).where(ne(schema.accounts.id, adminId));
          await tx.delete(schema.sessions).where(ne(schema.sessions.accountId, adminId));
          await tx.delete(schema.passwordResets);

          // Contas: a administradora que restaura é preservada
          // (mesmo id, para a sessão dela continuar valendo) e
          // recebe os dados do backup; as demais contas são
          // recriadas com ids novos. Linha sem conta conhecida é
          // descartada, para nenhum dado cair na conta errada.
          const accountIds = new Map<number, number>();
          for (const row of staged.accounts) {
            const { __oldId, ...rest } = row as any;
            if (String(rest.email).trim().toLowerCase() === backupEmail) {
              await tx
                .update(schema.accounts)
                .set({ ...rest } as any)
                .where(eq(schema.accounts.id, adminId));
              accountIds.set(__oldId, adminId);
            } else {
              const inserted = await tx
                .insert(schema.accounts)
                .values({ ...rest } as any)
                .returning({ id: schema.accounts.id });
              accountIds.set(__oldId, inserted[0]!.id);
            }
          }
          const ownerFor = (oldOwnerId: number | null): number | null =>
            oldOwnerId == null ? null : (accountIds.get(oldOwnerId) ?? null);

          // Reinsere com IDs novos (a sequência do banco manda) e
          // remapeia as referências entre as tabelas. Linhas que
          // apontam para um registro ausente no backup são puladas
          // (o registro sumiu antes do backup; nada é inventado).
          const integrationIds = new Map<number, number>();
          for (const row of staged.integrations) {
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            const inserted = await tx
              .insert(schema.integrations)
              .values({ ...row, ownerId: newOwnerId } as any)
              .returning({ id: schema.integrations.id });
            integrationIds.set(row.__oldId, inserted[0]!.id);
          }
          const serverIds = new Map<number, number>();
          const serverLinkFixups: Array<{ newId: number; oldIntegrationServerId: unknown }> = [];
          for (const row of staged.servers) {
            const { __oldId, panelIntegrationId, integrationServerId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            const inserted = await tx
              .insert(schema.servers)
              .values({
                ...rest,
                ownerId: newOwnerId,
                panelIntegrationId: remapBackupId(integrationIds, panelIntegrationId),
                integrationServerId: null,
              } as any)
              .returning({ id: schema.servers.id });
            serverIds.set(__oldId, inserted[0]!.id);
            serverLinkFixups.push({ newId: inserted[0]!.id, oldIntegrationServerId: integrationServerId });
          }
          for (const fix of serverLinkFixups) {
            const target = remapBackupId(serverIds, fix.oldIntegrationServerId);
            if (target != null) {
              await tx
                .update(schema.servers)
                .set({ integrationServerId: target })
                .where(eq(schema.servers.id, fix.newId));
            }
          }
          const planIds = new Map<number, number>();
          for (const row of staged.plans) {
            const { __oldId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            const inserted = await tx
              .insert(schema.plans)
              .values({ ...rest, ownerId: newOwnerId } as any)
              .returning({ id: schema.plans.id });
            planIds.set(__oldId, inserted[0]!.id);
          }
          const clientIds = new Map<number, number>();
          for (const row of staged.clients) {
            const { __oldId, serverId, planId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            const inserted = await tx
              .insert(schema.clients)
              .values({
                ...rest,
                ownerId: newOwnerId,
                serverId: remapBackupId(serverIds, serverId),
                planId: remapBackupId(planIds, planId),
              } as any)
              .returning({ id: schema.clients.id });
            clientIds.set(__oldId, inserted[0]!.id);
          }
          const renewalIds = new Map<number, number>();
          let insertedPayments = 0;
          for (const row of staged.renewals) {
            const { __oldId, clientId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            const newClientId = remapBackupId(clientIds, clientId);
            if (newClientId == null) continue;
            const inserted = await tx
              .insert(schema.renewals)
              .values({ ...rest, ownerId: newOwnerId, clientId: newClientId } as any)
              .returning({ id: schema.renewals.id });
            renewalIds.set(__oldId, inserted[0]!.id);
          }
          for (const row of staged.payments) {
            const { __oldId, clientId, appliedRenewalId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            const newClientId = remapBackupId(clientIds, clientId);
            if (newClientId == null) continue;
            insertedPayments += 1;
            await tx.insert(schema.payments).values({
              ...rest,
              ownerId: newOwnerId,
              clientId: newClientId,
              appliedRenewalId: remapBackupId(renewalIds, appliedRenewalId),
            } as any);
          }
          let insertedCreditLogs = 0;
          for (const row of staged.serverCreditLogs) {
            const { __oldId, serverId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            const newServerId = remapBackupId(serverIds, serverId);
            if (newServerId == null) continue;
            insertedCreditLogs += 1;
            await tx.insert(schema.serverCreditLogs).values({
              ...rest,
              ownerId: newOwnerId,
              serverId: newServerId,
            } as any);
          }
          for (const row of staged.expenses) {
            const { __oldId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            await tx.insert(schema.expenses).values({ ...rest, ownerId: newOwnerId } as any);
          }
          for (const row of staged.coupons) {
            const { __oldId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            await tx.insert(schema.coupons).values({ ...rest, ownerId: newOwnerId } as any);
          }
          for (const row of staged.settings) {
            const { __oldId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            await tx.insert(schema.settings).values({ ...rest, ownerId: newOwnerId } as any);
          }
          for (const row of staged.subscriptionPayments) {
            const { __oldId, ...rest } = row as any;
            const newOwnerId = ownerFor(row.__oldOwnerId);
            if (newOwnerId == null) continue;
            await tx.insert(schema.subscriptionPayments).values({ ...rest, accountId: newOwnerId } as any);
          }
          // A conta da administradora já foi atualizada no início
          // (mesmo id, para a sessão dela continuar valendo) e as
          // demais contas foram recriadas com ids novos.
          counts.contas = accountIds.size;
          counts.servidores = serverIds.size;
          counts.integrações = integrationIds.size;
          counts.movimentações = insertedCreditLogs;
          counts.planos = planIds.size;
          counts.clientes = clientIds.size;
          counts.renovações = renewalIds.size;
          counts.cobranças = insertedPayments;
          counts.despesas = staged.expenses.length;
          counts.cupons = staged.coupons.length;
          counts.configurações = staged.settings.length;
          counts.pagamentos = staged.subscriptionPayments.length;
        });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Arquivo de backup inválido")) throw err;
        throw new Error("Não foi possível restaurar o backup. Nenhum dado foi alterado.");
      }
      ctx.invalidateQueries();
      return { ok: true as const, email: accountRow.email, exportedAt: parsed.exportedAt, counts };
    },
  }),

  // Gera o Pix da assinatura do gestor (30 dias). Usa o Mercado Pago
  // DA CONTA ADMINISTRADORA, com as mesmas travas do Pix dos
  // clientes: credencial verificada + modo ao vivo + produção. O
  // valor é o da conta ou o padrão definido pela administradora;
  // sem valor definido, erro honesto — nenhum valor é inventado.
  createSubscriptionPix: defineAction({
    request: z.object({ session: sessionField }),
    response: z.object({
      id: z.number(),
      pixCode: z.string().nullable(),
      qrDataUrl: z.string().nullable(),
      status: z.string(),
      detail: z.string(),
      amountCents: z.number(),
      mpPaymentId: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const row = await loadAccountRow(ctx, ownerId);
      if (!row) throw new Error("Conta não encontrada.");
      if (isAdminAccount(row)) {
        throw new Error("A conta administradora não precisa de assinatura.");
      }
      const { settings: adminSettings } = await loadAdminSettings(ctx);
      const access = await loadAccountAccess(ctx, ownerId);
      const amountCents = access?.priceCents ?? 0;
      if (amountCents <= 0) {
        throw new Error(
          "O valor da assinatura ainda não foi definido pela administradora. Fale com ela para definir o valor e gerar o Pix.",
        );
      }
      if (!adminSettings.mpAccessToken || !adminSettings.mpVerified || !adminSettings.liveMode || adminSettings.mpEnvironment !== "producao") {
        throw new Error(
          "O pagamento da assinatura ainda não está configurado pela administradora (Mercado Pago em produção com modo ao vivo). Fale com ela e tente de novo.",
        );
      }
      let payerEmail = adminSettings.mpPayerEmail;
      if (!payerEmail) {
        const me = await mpTestConnection(adminSettings.mpAccessToken);
        if (me.connected && me.email) payerEmail = me.email;
      }
      const created = await mpCreatePix(adminSettings.mpAccessToken, {
        amountCents,
        clientName: row.email,
        clientId: row.id,
        payerEmail,
        description: `Assinatura Gestor Flex (30 dias) — ${row.email}`,
        externalReference: `gestor-assinatura-${row.id}`,
      });
      if (created.kind === "failed") {
        throw new Error(created.detail);
      }
      const inserted = await db
        .insert(schema.subscriptionPayments)
        .values({
          accountId: ownerId,
          mpPaymentId: created.mpPaymentId || null,
          amountCents,
          status: "pendente",
        })
        .returning({ id: schema.subscriptionPayments.id });
      const subRow = inserted[0];
      if (!subRow) throw new Error("Não foi possível gerar a cobrança da assinatura.");
      ctx.invalidateQueries();
      return {
        id: subRow.id,
        pixCode: created.pixCode,
        qrDataUrl: await pixQrDataUrl(created.pixCode),
        status: "pendente",
        detail: "Pix da assinatura criado. Pague com o QR Code ou o código Pix e toque em “Já paguei — verificar agora”. Ao confirmar, o acesso é liberado por 30 dias e nenhum dado é apagado.",
        amountCents,
        mpPaymentId: created.mpPaymentId || null,
      };
    },
  }),

  checkSubscriptionPaymentStatus: defineAction({
    request: z.object({
      session: sessionField,
      subscriptionPaymentId: z.number().int().positive(),
    }),
    response: z.object({
      status: z.string(),
      detail: z.string(),
      subExpiresAt: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.subscriptionPayments)
        .where(eq(schema.subscriptionPayments.id, args.subscriptionPaymentId));
      const sub = rows[0];
      if (!sub) throw new Error("Cobrança não encontrada.");
      const meRow = await loadAccountRow(ctx, ownerId);
      if (sub.accountId !== ownerId && !(meRow && isAdminAccount(meRow))) {
        throw new Error("Cobrança não encontrada nesta conta.");
      }
      if (sub.status === "aprovado") {
        const acc = await loadAccountRow(ctx, sub.accountId);
        return {
          status: "aprovado",
          detail: "Pagamento já confirmado: a assinatura está ativa.",
          subExpiresAt: acc?.subExpiresAt ? acc.subExpiresAt.toISOString() : null,
        };
      }
      const { settings: adminSettings } = await loadAdminSettings(ctx);
      if (!sub.mpPaymentId || !adminSettings.mpAccessToken) {
        return {
          status: sub.status,
          detail: "Ainda não foi possível consultar este pagamento. Tente de novo em alguns instantes.",
          subExpiresAt: null,
        };
      }
      const check = await mpGetPaymentStatus(adminSettings.mpAccessToken, sub.mpPaymentId);
      if (!check.ok) {
        return { status: sub.status, detail: check.detail, subExpiresAt: null };
      }
      if (check.status === "approved") {
        const expiresAt = await applySubscriptionApproval(ctx, sub.accountId, sub.id);
        ctx.invalidateQueries();
        return {
          status: "aprovado",
          detail: "Pagamento confirmado: acesso liberado por 30 dias. Nenhum dado foi apagado.",
          subExpiresAt: expiresAt.toISOString(),
        };
      }
      if (check.status === "rejected" || check.status === "cancelled") {
        await db
          .update(schema.subscriptionPayments)
          .set({ status: "recusado" })
          .where(eq(schema.subscriptionPayments.id, sub.id));
        return { status: "recusado", detail: "O Mercado Pago marcou este pagamento como recusado/cancelado.", subExpiresAt: null };
      }
      return {
        status: sub.status,
        detail: `O Mercado Pago ainda mostra este pagamento como “${check.status || "pendente"}”. Conclua o Pix e verifique de novo.`,
        subExpiresAt: null,
      };
    },
  }),

  // "Esqueci a senha": sempre retorna ok, sem revelar se o e-mail
  // existe. Se o envio de e-mail estiver configurado, o link chega
  // no e-mail; se não, a tela orienta a falar com a administradora.
  requestPasswordReset: defineAction({
    request: z.object({ email: z.string().min(3).max(200) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const rows = await db.select().from(schema.accounts);
      const account = rows.find((a) => a.email.toLowerCase() === email);
      if (account) {
        try {
          const { settings: adminSettings } = await loadAdminSettings(ctx);
          if (adminSettings.resendApiKey && adminSettings.resendFrom) {
            await db
              .update(schema.passwordResets)
              .set({ used: 1 })
              .where(eq(schema.passwordResets.accountId, account.id));
            const token = generateInvoiceToken();
            await db.insert(schema.passwordResets).values({
              accountId: account.id,
              tokenHash: await sha256Hex(token),
              expiresAt: new Date(Date.now() + 60 * 60 * 1000),
              used: 0,
            });
            const link = resetLinkUrl(adminSettings.publicBaseUrl, token);
            await sendResendEmail({
              apiKey: adminSettings.resendApiKey,
              from: adminSettings.resendFrom,
              to: account.email,
              subject: "Redefinir sua senha do Gestor Flex",
              text: `Você pediu para redefinir a senha do Gestor Flex.\n\nAbra este link para criar uma senha nova (vale por 1 hora): ${link}\n\nSe não foi você, ignore este e-mail — sua senha atual continua valendo.`,
              html: `<p>Você pediu para redefinir a senha do Gestor Flex.</p><p><a href="${escapeHtml(link)}">Criar uma senha nova</a> (vale por 1 hora).</p><p>Se não foi você, ignore este e-mail — sua senha atual continua valendo.</p>`,
            });
          }
        } catch {
          // Falha de e-mail nunca revela nada nem quebra a resposta.
        }
      }
      return { ok: true as const };
    },
  }),

  resetPassword: defineAction({
    request: z.object({
      token: z.string().min(20).max(120),
      newPassword: z.string().min(6).max(200),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const tokenHash = await sha256Hex(args.token.trim());
      const rows = await db
        .select()
        .from(schema.passwordResets)
        .where(eq(schema.passwordResets.tokenHash, tokenHash));
      const reset = rows[0];
      if (!reset || reset.used === 1 || reset.expiresAt.getTime() < Date.now()) {
        throw new Error("Este link de redefinição não é mais válido. Peça um link novo na tela de login (Esqueci a senha).");
      }
      await db
        .update(schema.passwordResets)
        .set({ used: 1 })
        .where(eq(schema.passwordResets.id, reset.id));
      await db
        .update(schema.accounts)
        .set({ passHash: await hashPassword(args.newPassword) })
        .where(eq(schema.accounts.id, reset.accountId));
      // Sessões antigas desta conta deixam de valer: quem estava
      // logado com a senha antiga entra de novo com a nova.
      await db.delete(schema.sessions).where(eq(schema.sessions.accountId, reset.accountId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // ---------------- Integrações de painéis IPTV (WPlay e TopSul) ----------------

  saveIntegration: defineAction({
    request: z.object({
      session: sessionField,
      id: z.number().int().positive().optional(),
      provider: z.enum(["wplay", "topsul"]).optional(),
      name: z.string().min(1).max(120),
      url: z.string().min(1).max(500).optional(),
      panelUser: z.string().max(200).optional(),
      panelPass: z.string().max(300).optional(),
      apiBase: z.string().max(500).optional(),
      apiToken: z.string().max(500).optional(),
      apiSecret: z.string().max(500).optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const ownerId = await requireAccount(ctx, args.session);
      const db = ctx.db<typeof schema>();
      if (args.id) {
        const rows = await db
          .select()
          .from(schema.integrations)
          .where(eq(schema.integrations.id, args.id));
        const existing = rows[0];
        if (!existing || existing.ownerId !== ownerId) {
          throw new Error("Integração não encontrada nesta conta.");
        }
        // O provedor é fixo desde a criação. Integrações de um
        // provedor removido não podem ser editadas: exclua a
        // integração e crie uma nova do painel atual.
        if (!isSupportedPanelProvider(existing.provider ?? "wplay")) {
          throw new Error("Esta integração usa um provedor de painel que foi removido do gestor. Exclua ela e crie uma integração WPlay ou TopSul nova.");
        }
        let url = (args.url ?? existing.url).trim();
        if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
        url = url.replace(/\/+$/, "");
        // TopSul: a edição também aceita base da API, token e
        // segredo — em branco, mantém o valor salvo. Se qualquer
        // credencial mudar, o teste anterior deixa de valer.
        if ((existing.provider ?? "wplay") === "topsul") {
          const baseRaw = args.apiBase !== undefined ? args.apiBase.trim() : (existing.apiBase ?? "");
          const baseCheck = inspectTopsulApiBase(resolveTopsulApiBase(baseRaw));
          if (!baseCheck.valid) {
            throw new Error(`Base da API TopSul inválida: ${baseCheck.error}`);
          }
          const token = args.apiToken !== undefined && args.apiToken.trim()
            ? args.apiToken.trim()
            : (existing.apiToken ?? "");
          const secret = args.apiSecret !== undefined && args.apiSecret.trim()
            ? args.apiSecret.trim()
            : (existing.apiSecret ?? "");
          const credsChanged =
            token !== (existing.apiToken ?? "") ||
            secret !== (existing.apiSecret ?? "") ||
            baseCheck.normalized !== resolveTopsulApiBase(existing.apiBase ?? "");
          await db
            .update(schema.integrations)
            .set({
              name: args.name.trim(),
              url,
              panelUser: (args.panelUser ?? existing.panelUser).trim(),
              panelPass: args.panelPass ? args.panelPass : existing.panelPass,
              apiBase: baseCheck.normalized,
              apiToken: token,
              apiSecret: secret,
              ...(credsChanged
                ? {
                    status: "nao_testado",
                    testDetail:
                      "Token, segredo ou base da API alterados. Toque em “Testar conexão” para validar de novo — a renovação fica pendente até o teste passar.",
                  }
                : {}),
            })
            .where(eq(schema.integrations.id, args.id));
          ctx.invalidateQueries();
          return { id: args.id };
        }
        await db
          .update(schema.integrations)
          .set({
            name: args.name.trim(),
            url,
            panelUser: (args.panelUser ?? existing.panelUser).trim(),
            panelPass: args.panelPass ? args.panelPass : existing.panelPass,
          })
          .where(eq(schema.integrations.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      if (!args.url?.trim() || !args.panelUser?.trim()) {
        throw new Error("Informe a URL do servidor e o usuário do painel.");
      }
      if (!args.panelPass) throw new Error("Informe a senha do painel.");
      let url = args.url.trim();
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      url = url.replace(/\/+$/, "");
      const provider = args.provider ?? "wplay";
      // TopSul: exige token e segredo já na criação; a base vem
      // preenchida com o endereço padrão da API quando vazia.
      if (provider === "topsul") {
        if (!args.apiToken?.trim() || !args.apiSecret?.trim()) {
          throw new Error("Informe o token e o segredo da API TopSul.");
        }
        const baseCheck = inspectTopsulApiBase(resolveTopsulApiBase(args.apiBase ?? ""));
        if (!baseCheck.valid) {
          throw new Error(`Base da API TopSul inválida: ${baseCheck.error}`);
        }
        const inserted = await db
          .insert(schema.integrations)
          .values({
            ownerId,
            provider: "topsul",
            name: args.name.trim(),
            url,
            panelUser: args.panelUser.trim(),
            panelPass: args.panelPass,
            apiBase: baseCheck.normalized,
            apiToken: args.apiToken.trim(),
            apiSecret: args.apiSecret.trim(),
          })
          .returning({ id: schema.integrations.id });
        const row = inserted[0];
        if (!row) throw new Error("saveIntegration: insert returned no rows");
        ctx.invalidateQueries();
        return { id: row.id };
      }
      const inserted = await db
        .insert(schema.integrations)
        .values({
          ownerId,
          provider: "wplay",
          name: args.name.trim(),
          url,
          panelUser: args.panelUser.trim(),
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
      // O provedor volta a "wplay", o padrão dos servidores.
      await db
        .update(schema.servers)
        .set({ panelIntegrationId: null, integrationMode: "nenhuma", panelProvider: "wplay" })
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
      // Provedor removido: o teste é recusado com o motivo em
      // linguagem simples, sem chamar nada.
      if (!isSupportedPanelProvider(integration.provider ?? "wplay")) {
        return { status: "falhou", detail: "Esta integração usa um provedor de painel que foi removido do gestor. Exclua ela e crie uma integração WPlay ou TopSul nova." };
      }
      // TopSul: o teste chama o perfil da API TopSul com o token e o
      // segredo salvos — é o mesmo teste do cartão do servidor
      // vinculado, e o resultado vale para os dois.
      if ((integration.provider ?? "wplay") === "topsul") {
        const result = await topsulTestConnection({
          apiBase: resolveTopsulApiBase(integration.apiBase ?? ""),
          token: integration.apiToken ?? "",
          secret: integration.apiSecret ?? "",
        });
        const status = result.connected ? "ativo" : "falhou";
        await db
          .update(schema.integrations)
          .set({ status, testDetail: result.detail, testedAt: Date.now() })
          .where(eq(schema.integrations.id, integration.id));
        ctx.invalidateQueries();
        return { status, detail: result.detail };
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
      // TopSul não tem "Info Painel" nem sincronização de IDs: esses
      // botões leem a API Xtream do painel WPlay. A TopSul usa só o
      // teste de conexão (perfil) e a renovação.
      if ((integration.provider ?? "wplay") === "topsul") {
        const info =
          "Integração TopSul: use “Testar conexão” para validar o token e o segredo com a API TopSul. Informações do painel e sincronização de IDs são recursos do painel WPlay e não existem nesta integração.";
        await db
          .update(schema.integrations)
          .set({ panelInfo: info })
          .where(eq(schema.integrations.id, integration.id));
        ctx.invalidateQueries();
        return { info };
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
      if ((integration.provider ?? "wplay") === "topsul") {
        const detail =
          "A sincronização de IDs é um recurso do painel WPlay e não existe na integração TopSul. O vínculo e o teste de conexão continuam valendo; a renovação automática usa o token e o segredo salvos.";
        await db
          .update(schema.integrations)
          .set({ syncDetail: detail, syncedAt: Date.now() })
          .where(eq(schema.integrations.id, integration.id));
        ctx.invalidateQueries();
        return { detail, synced: false };
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
      if (!isSupportedPanelProvider(integration.provider ?? "wplay")) {
        throw new Error("Esta integração usa um provedor de painel que foi removido do gestor e não pode ser vinculada. Exclua ela e crie uma integração WPlay ou TopSul nova.");
      }
      await db
        .update(schema.servers)
        .set({
          integrationMode: "vinculada",
          panelIntegrationId: integration.id,
          panelProvider: integration.provider ?? "wplay",
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
