import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "./safe-area";
import invoiceBg from "./assets/invoice-bg.jpg";
import { api, getSessionToken, setSessionToken, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Client = State["clients"][number];
type Plan = State["plans"][number];
type Server = State["servers"][number];
type PanelDiagnostic = NonNullable<Server["apiDiagnostic"]>;
type PanelTestResult = ApiResponse<typeof api, "testPanelApi">;
type QrStatus = ApiResponse<typeof api, "getWhatsAppQrStatus">;
type Payment = State["payments"][number];
type Expense = State["expenses"][number];
type Coupon = State["coupons"][number];
type Integration = State["integrations"][number];
type Invoice = ApiResponse<typeof api, "getInvoice">;

const INVOICE_THEMES: Record<string, { label: string; main: string; dark: string; soft: string }> = {
  verde: { label: "Verde Pix", main: "#00b37e", dark: "#065f46", soft: "#e5f6ef" },
  azul: { label: "Azul", main: "#2563eb", dark: "#1e3a8a", soft: "#e7eefc" },
  roxo: { label: "Roxo", main: "#7c3aed", dark: "#4c1d95", soft: "#f0eafd" },
  coral: { label: "Coral", main: "#e8590c", dark: "#7a2e0e", soft: "#fdeee3" },
  grafite: { label: "Grafite", main: "#495057", dark: "#212529", soft: "#eceff1" },
};

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseBRL(text: string): number | null {
  const clean = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function daysLeft(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

function dateInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayPlusDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

function onlyDigits(text: string): string {
  return text.replace(/\D/g, "");
}

function waLink(whatsapp: string, message: string): string {
  let num = onlyDigits(whatsapp);
  if (num && !num.startsWith("55")) num = `55${num}`;
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}

// Rota pública da fatura DESTE cliente: #/fatura/<código secreto>.
// O código é aleatório por cliente (não é o número dele): só quem
// recebe o link abre a fatura, sem login do gestor e sem login do
// Muse. Trocar o código ou o número na mão não abre fatura nenhuma.
function invoiceHash(client: { invoiceToken: string }): string {
  return `#/fatura/${client.invoiceToken}`;
}

// URL completa e clicável da página pública da fatura DESTE cliente.
// Quando a dona salva o endereço público da hospedagem (Render) nas
// configurações, TODOS os links usam esse endereço — o cliente abre
// fora do Muse, sem login. Sem endereço salvo, o link usa o endereço
// atual do gestor (dentro do Muse, que pede login do Muse).
function invoiceUrl(
  client: { invoiceToken: string },
  publicBaseUrl?: string | null,
): string {
  const saved = (publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  const base = saved || window.location.href.split("#")[0]!.replace(/\/+$/, "");
  return `${base}/${invoiceHash(client)}`;
}

// Garante que a mensagem enviada ao cliente leva o link da fatura junto:
// se o modelo já tiver {link} (ou o endereço) ele fica como está; se
// não tiver, o link entra no fim da mensagem, completo e clicável.
function withInvoiceLink(
  message: string,
  client: { invoiceToken: string },
  publicBaseUrl?: string | null,
): string {
  const url = invoiceUrl(client, publicBaseUrl);
  if (message.includes(url) || message.includes(invoiceHash(client))) return message;
  return `${message}\n\nLink da fatura (toque para abrir e pagar com Pix): ${url}`;
}

function renderMsg(
  tpl: string,
  vars: { nome: string; usuario: string; vencimento: string; novoVencimento?: string; dias?: number | null; valor?: string; plano?: string | null; link?: string; telefone?: string; diasVencido?: number | null },
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

// Dias que a assinatura deste cliente está vencida (0 se ainda não
// venceu): usado na tag {dias_vencido} e na linha de vencimento do
// modelo "Acesso expirado".
function overdueDays(expiresAt: string): number {
  const left = daysLeft(expiresAt);
  return left < 0 ? -left : 0;
}

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)]";
const labelCls = "block text-sm font-medium text-[var(--dim)] mb-1";
const btnPrimary =
  "rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)] disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]";

export function App() {
  const hash = useHashRoute();
  const invoiceMatch = hash.match(/^#\/fatura\/([A-Za-z0-9_-]{8,})$/);
  if (invoiceMatch) {
    return <InvoiceLoader token={invoiceMatch[1]!} />;
  }
  return <AuthGate />;
}

function AuthGate() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => getSessionToken());
  // Aviso exibido na tela de login quando havia uma sessão salva mas
  // o servidor não a reconheceu (expirou ou não foi encontrada): sem
  // isso a tela de login só reaparecia em silêncio e a pessoa achava
  // que a senha estava errada.
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const me = useQuery({
    queryKey: ["me", token],
    // O token vai EXPLÍCITO na chamada: a verificação usa exatamente o
    // token que acabou de vir do login, sem depender de reler o
    // armazenamento (que pode falhar dentro do iframe e derrubava o
    // login logo depois de entrar).
    queryFn: () => api.me({ session: token }),
    enabled: token.length > 0,
  });

  useEffect(() => {
    if (token && me.data && !me.data.loggedIn) {
      setSessionToken("");
      setToken("");
      setSessionNotice(
        "Sua sessão não foi reconhecida neste aparelho (pode ter expirado). Entre de novo com seu e-mail e sua senha — sua conta e seus dados continuam salvos.",
      );
    }
  }, [token, me.data]);

  if (token && me.isPending) {
    return <div className="min-h-screen bg-[var(--bg)] p-6 text-[var(--text)]">Verificando seu login…</div>;
  }
  if (token && me.isError) {
    // Falha de comunicação ao confirmar a sessão NÃO é senha errada:
    // mantém o token e oferece tentar de novo, em vez de jogar a
    // pessoa de volta para a tela de login sem explicação.
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 text-[var(--text)]">
        <main className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
          <p className="font-semibold">Não foi possível confirmar seu login agora.</p>
          <p className="mt-2 text-sm text-[var(--dim)]">
            Pode ser uma falha momentânea de conexão. Seu login continua salvo neste aparelho.
          </p>
          <button
            type="button"
            className="mt-4 w-full rounded-lg bg-[var(--accent)] px-4 py-3 font-display text-base font-bold text-[var(--accent-ink)]"
            onClick={() => void me.refetch()}
          >
            Tentar de novo
          </button>
        </main>
      </div>
    );
  }
  if (!token || !me.data?.loggedIn) {
    return (
      <AuthScreen
        notice={sessionNotice}
        onLoggedIn={(t) => {
          setSessionNotice(null);
          setSessionToken(t);
          setToken(t);
          queryClient.invalidateQueries();
        }}
      />
    );
  }
  return (
    <ManagerLoader
      onLogout={async () => {
        try {
          await api.logout({});
        } catch {
          // Sair neste aparelho vale mesmo se o servidor não responder.
        }
        setSessionToken("");
        setToken("");
        queryClient.clear();
      }}
    />
  );
}

/* ---------------- Login / criar conta ---------------- */

// As ações devolvem o motivo já em linguagem simples (ex.: "A senha
// está errada para este e-mail."), mas o erro que chega ao cliente vem
// embrulhado pelo transporte ("action login failed: 500 {\"error\":…}").
// Aqui a gente desembrulha e mostra SÓ o motivo, sem texto técnico.
function friendlyAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/\{"error":"((?:[^"\\]|\\.)*)"\}/);
  const inner = match?.[1];
  if (inner) {
    try {
      return JSON.parse(`"${inner}"`) as string;
    } catch {
      return inner;
    }
  }
  return raw;
}

function AuthScreen({
  onLoggedIn,
  notice,
}: {
  onLoggedIn: (token: string) => void;
  notice?: string | null;
}) {
  const [mode, setMode] = useState<"entrar" | "criar">("entrar");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result =
        mode === "criar"
          ? await api.register({ email: email.trim(), password })
          : await api.login({ email: email.trim(), password });
      onLoggedIn(result.token);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-10 text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="w-full max-w-md">
        <h1 className="text-center font-display text-3xl font-extrabold">Gestor IPTV</h1>
        <p className="mt-2 text-center text-sm text-[var(--dim)]">
          Cada conta tem os seus próprios clientes, servidores, planos e WhatsApp.
          Conta nova começa do zero, vazia.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-2" role="group" aria-label="Entrar ou criar conta">
          <button
            type="button"
            aria-pressed={mode === "entrar"}
            onClick={() => { setMode("entrar"); setError(null); }}
            className={mode === "entrar" ? "rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)]" : "rounded-lg border border-[var(--border)] px-4 py-2.5 font-medium"}
          >
            Entrar
          </button>
          <button
            type="button"
            aria-pressed={mode === "criar"}
            onClick={() => { setMode("criar"); setError(null); }}
            className={mode === "criar" ? "rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)]" : "rounded-lg border border-[var(--border)] px-4 py-2.5 font-medium"}
          >
            Criar conta
          </button>
        </div>
        <form onSubmit={submit} className="mt-4 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" aria-label={mode === "criar" ? "Criar conta" : "Entrar"}>
          {notice && !error && (
            <p className="rounded-lg bg-[var(--danger-bg)] px-3 py-2 text-sm font-medium text-[var(--danger)]" role="alert">
              {notice}
            </p>
          )}
          <div>
            <label htmlFor="auth-email" className={labelCls}>E-mail</label>
            <input
              id="auth-email"
              type="email"
              className={inputCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="voce@email.com"
            />
          </div>
          <div>
            <label htmlFor="auth-pass" className={labelCls}>Senha</label>
            <input
              id="auth-pass"
              type="password"
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "criar" ? 6 : 1}
              autoComplete={mode === "criar" ? "new-password" : "current-password"}
              placeholder={mode === "criar" ? "Mínimo de 6 caracteres" : "Sua senha"}
            />
          </div>
          {error && (
            <p className="rounded-lg bg-[var(--danger-bg)] px-3 py-2 text-sm font-medium text-[var(--danger)]" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="w-full rounded-lg bg-[var(--accent)] px-4 py-3 font-display text-base font-bold text-[var(--accent-ink)] disabled:opacity-50" disabled={pending}>
            {pending ? "Aguarde…" : mode === "criar" ? "Criar minha conta" : "Entrar"}
          </button>
          <p className="text-center text-xs text-[var(--dim)]">
            {mode === "criar"
              ? "Ao criar a conta, você entra direto e já pode cadastrar seus servidores, planos e clientes — tudo separado das outras contas."
              : "Esqueceu a senha? Fale com quem administra o gestor para redefinir o acesso."}
          </p>
        </form>
      </main>
    </div>
  );
}

function ManagerLoader({ onLogout }: { onLogout: () => void }) {
  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });
  return <Manager data={state.data} isPending={state.isPending} error={state.error} onLogout={onLogout} />;
}

function InvoiceLoader({ token }: { token: string }) {
  const invoice = useQuery({
    queryKey: ["invoice", token],
    queryFn: () => api.getInvoice({ token }),
  });
  if (invoice.isPending) {
    return <div className="min-h-screen bg-[var(--bg)] p-6 text-[var(--text)]">Carregando fatura…</div>;
  }
  if (invoice.error || !invoice.data) {
    return <div className="min-h-screen bg-[var(--bg)] p-6 text-[var(--text)]">Não foi possível carregar a fatura.</div>;
  }
  if (!invoice.data.found) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 text-[var(--text)]">
        <main className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
          <p className="font-display text-lg font-bold">Este link de fatura não é válido</p>
          <p className="mt-2 text-sm text-[var(--dim)]">
            Ele pode ser um link antigo (os links antigos, só com o número do cliente, foram
            desativados por segurança) ou o responsável gerou um link novo. Peça ao responsável
            para enviar o link atual da sua fatura — é ele que abre a sua fatura, sem precisar
            de login.
          </p>
        </main>
      </div>
    );
  }
  return <InvoicePage invoice={invoice.data} invoiceToken={token} />;
}

/* ---------------- Página de fatura (o que o cliente vê) ---------------- */

function InvoicePage({ invoice, invoiceToken }: { invoice: Invoice; invoiceToken: string }) {
  const queryClient = useQueryClient();
  // Fatura sem verde: a pedido da Emily, a página do cliente usa
  // paleta neutra escura, sem a cor do tema salvo (verde), para a
  // imagem de fundo aparecer sem tingimento verde.
  const theme = { main: "#111827", dark: "#0b0f17", soft: "#f3f4f6" };
  const [pix, setPix] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState("");

  const createPix = useMutation({
    mutationFn: () =>
      api.createPix({
        clientId: invoice.clientId,
        mode: invoice.liveMode ? "producao" : "validacao",
        couponCode: couponCode.trim() ? couponCode.trim().toUpperCase() : undefined,
        invoiceToken,
      }),
    onSuccess: (p) => {
      setPayment(p);
      if (p.pixCode) setPix(p.pixCode);
      setStatusMsg(p.detail || null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setStatusMsg(String(e)),
  });

  const checkStatus = useMutation({
    mutationFn: (id: number) => api.checkPaymentStatus({ paymentId: id, invoiceToken }),
    onSuccess: (r) => {
      setStatusMsg(r.detail);
      if (r.message) setConfirmMsg(r.message);
      setPayment((prev) =>
        prev
          ? {
              ...prev,
              status: r.status,
              detail: r.detail,
              wouldExpireAt: r.newExpiresAt ?? prev.wouldExpireAt,
              appliedRenewalId: r.applied ? (prev.appliedRenewalId ?? -1) : prev.appliedRenewalId,
            }
          : prev,
      );
      queryClient.invalidateQueries({ queryKey: ["invoice", invoiceToken] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setStatusMsg(String(e)),
  });

  useEffect(() => {
    if (!payment?.mpPaymentId || payment.status !== "pendente") return;
    const timer = window.setInterval(() => {
      if (!checkStatus.isPending) checkStatus.mutate(payment.id);
    }, 12000);
    return () => window.clearInterval(timer);
  }, [payment?.id, payment?.mpPaymentId, payment?.status, checkStatus.isPending]);

  const newExpiry = invoice.planDays != null ? todayPlusDays(invoice.planDays) : null;
  const left = daysLeft(invoice.expiresAt);

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Fundo da fatura: imagem de filmes em tela cheia, com leve
          desfoque para o texto continuar legível e os cartazes ainda
          visíveis por baixo da cor do tema. */}
      <div className="absolute inset-0" aria-hidden="true">
        <img
          src={invoiceBg}
          alt=""
          className="h-full w-full object-cover"
          style={{ filter: "blur(5px) brightness(0.62)", transform: "scale(1.07)" }}
        />
        <div
          className="absolute inset-0"
          style={{ background: `linear-gradient(160deg, ${theme.dark} 0%, ${theme.main} 55%, ${theme.dark} 130%)`, opacity: 0.52 }}
        />
      </div>
      <SafeAreaTopScrim backgroundColor={theme.dark} />
      <main className="relative mx-auto w-full max-w-md px-4 pb-10 pt-8">
        <p className="text-center text-sm font-semibold uppercase tracking-widest text-white/80">
          {invoice.serverName ?? "Assinatura IPTV"}
        </p>
        <h1 className="mt-1 text-center font-display text-2xl font-bold text-white">
          {invoice.invoiceTitle}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-center text-sm text-white/85">{invoice.invoiceMessage}</p>

        <section aria-label="Dados da fatura" className="mt-6 rounded-2xl bg-white p-5 text-neutral-900 shadow-xl">
          <dl className="space-y-3 text-base">
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">Cliente</dt>
              <dd className="font-semibold">{invoice.clientName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">Usuário IPTV</dt>
              <dd className="font-mono font-semibold">{invoice.iptvUser}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">Plano</dt>
              <dd className="font-semibold">{invoice.planName ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">Dias restantes</dt>
              <dd className="font-semibold">
                {left < 0 ? `vencido há ${-left} dias` : left === 0 ? "0 dias — vence hoje" : `${left} dias`}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">Vencimento atual</dt>
              <dd className="font-semibold">
                {fmtDate(invoice.expiresAt)}
                <span className={left < 0 ? "text-red-600" : left <= 3 ? "text-amber-600" : "text-neutral-500"}>
                  {" "}({left < 0 ? `vencido há ${-left}d` : left === 0 ? "vence hoje" : `em ${left}d`})
                </span>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-500">Novo vencimento ao renovar</dt>
              <dd className="font-semibold">{newExpiry ? fmtDate(newExpiry) : "—"}</dd>
            </div>
          </dl>

          <div className="mt-5 rounded-xl p-4 text-center" style={{ background: theme.soft }}>
            <p className="text-sm text-neutral-500">Valor da renovação</p>
            <p className="font-display text-4xl font-extrabold" style={{ color: theme.dark }}>
              {brl(invoice.effectivePriceCents)}
            </p>
          </div>

          {invoice.serverAppName && (
            <div className="mt-5 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-800">
              <p>
                <span className="font-bold">Aplicativo deste servidor:</span> {invoice.serverAppName}
                {invoice.serverAppDownloadUrl && (
                  <>
                    {" — "}
                    <a
                      href={invoice.serverAppDownloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-blue-700 underline"
                    >
                      baixar o aplicativo
                    </a>
                  </>
                )}
              </p>
            </div>
          )}

          {invoice.serverPixInstructions && (
            <p className="mt-4 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-700">
              {invoice.serverPixInstructions}
            </p>
          )}

          {!invoice.serverPixEnabled ? (
            <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="status">
              <p className="font-bold">Renovação com Pix desligada para este servidor</p>
              <p className="mt-1">
                O responsável pelo gestor desligou a geração de Pix para o servidor desta
                assinatura. Nenhuma cobrança é gerada nesta página — fale com o suporte
                para renovar por outro caminho combinado com ele.
              </p>
            </div>
          ) : !invoice.mpConfigured ? (
            <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="status">
              <p className="font-bold">Pagamento ao vivo ainda não configurado</p>
              <p className="mt-1">
                O responsável pelo gestor ainda não salvou e testou as credenciais do
                Mercado Pago. Nenhuma chave Pix falsa é mostrada nesta página.
              </p>
            </div>
          ) : !invoice.liveMode ? (
            <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="status">
              <p className="font-bold">Modo ao vivo ainda desligado</p>
              <p className="mt-1">
                As credenciais do Mercado Pago estão salvas, mas o responsável ainda
                não ligou o modo ao vivo em Produção. Este link não deve ser usado
                para um pagamento real até essa etapa ser concluída.
              </p>
            </div>
          ) : payment == null ? (
            <div className="mt-5">
              <label htmlFor="invoice-coupon" className="text-sm font-medium text-neutral-500">
                Tem um cupom de desconto? Digite o código antes de gerar o Pix
              </label>
              <input
                id="invoice-coupon"
                className="mt-1 w-full rounded-lg border border-neutral-300 bg-neutral-50 p-3 font-mono text-sm uppercase text-neutral-900"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                placeholder="Ex.: VOLTE10"
                autoComplete="off"
              />
              <button
                type="button"
                disabled={createPix.isPending || invoice.planId == null}
                onClick={() => createPix.mutate()}
                className="mt-3 w-full rounded-xl py-3.5 font-display text-lg font-bold text-white disabled:opacity-50"
                style={{ background: theme.main }}
              >
                {createPix.isPending ? "Gerando Pix no Mercado Pago…" : "Gerar Pix real"}
              </button>
              <p className="mt-2 text-center text-xs text-neutral-500">
                O valor acima é enviado ao Mercado Pago e a chave gerada é a chave
                oficial da cobrança.
              </p>
            </div>
          ) : (
            <div className="mt-5">
              {payment.discountCents > 0 && payment.couponCode && (
                <div className="mb-4 rounded-xl bg-green-50 p-4 text-sm text-green-900" role="status">
                  <p className="font-bold">Cupom {payment.couponCode} aplicado ✓</p>
                  <p className="mt-1">
                    Você economizou {brl(payment.discountCents)}. Valor cobrado nesta fatura:{" "}
                    <strong>{brl(payment.amountCents)}</strong>
                  </p>
                </div>
              )}
              {pix ? (
                <>
                  <label htmlFor="pix-key" className="text-sm font-medium text-neutral-500">
                    Pix copia e cola do Mercado Pago
                  </label>
                  <textarea
                    id="pix-key"
                    readOnly
                    value={pix}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-neutral-300 bg-neutral-50 p-3 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={async () => setCopied(await copyText(pix))}
                    className="mt-2 w-full rounded-xl py-3 font-display text-base font-bold text-white"
                    style={{ background: theme.main }}
                  >
                    {copied ? "Chave copiada ✓" : "Copiar chave Pix"}
                  </button>
                </>
              ) : (
                <div className="rounded-xl bg-red-50 p-4 text-sm text-red-900">
                  <p className="font-bold">A cobrança não gerou uma chave Pix</p>
                  <p className="mt-1">{payment.detail}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPayment(null);
                      setStatusMsg(null);
                    }}
                    className="mt-3 w-full rounded-lg bg-white py-2.5 font-semibold text-neutral-900"
                  >
                    Tentar gerar novamente
                  </button>
                </div>
              )}

              {payment.status === "pendente" && payment.mpPaymentId && (
                <div className="mt-4 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-700">
                  <p>
                    Depois de pagar, esta página consulta o Mercado Pago
                    automaticamente a cada 12 segundos. Você também pode verificar agora:
                  </p>
                  <button
                    type="button"
                    disabled={checkStatus.isPending}
                    onClick={() => checkStatus.mutate(payment.id)}
                    className="mt-3 w-full rounded-lg border border-neutral-300 bg-white py-2.5 font-semibold text-neutral-900 disabled:opacity-50"
                  >
                    {checkStatus.isPending ? "Consultando o Mercado Pago…" : "Já paguei — verificar agora"}
                  </button>
                </div>
              )}

              {payment.status === "aprovado_pendente_painel" && (
                <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="status">
                  <p className="font-bold">Pagamento confirmado — extensão pendente no painel</p>
                  <p className="mt-1">
                    O Mercado Pago aprovou o pagamento, mas a extensão deste usuário
                    no painel ainda não foi concluída pela API. Nenhum crédito foi
                    dado como gasto e o vencimento ainda não mudou.
                  </p>
                  <button
                    type="button"
                    disabled={checkStatus.isPending}
                    onClick={() => checkStatus.mutate(payment.id)}
                    className="mt-3 w-full rounded-lg bg-white py-2.5 font-semibold text-neutral-900 disabled:opacity-50"
                  >
                    {checkStatus.isPending ? "Tentando a extensão…" : "Tentar a extensão no painel de novo"}
                  </button>
                </div>
              )}

              {payment.appliedRenewalId != null && (
                <div className="mt-4 rounded-xl bg-green-50 p-4 text-sm text-green-900" role="status">
                  <p className="font-bold">Pagamento confirmado e renovação aplicada</p>
                  <p className="mt-1">Novo vencimento: {payment.wouldExpireAt ? fmtDate(payment.wouldExpireAt) : "confirmado no gestor"}.</p>
                </div>
              )}

              {statusMsg && payment.status !== "aprovado_pendente_painel" && (
                <p className="mt-3 text-center text-xs text-neutral-500">{statusMsg}</p>
              )}
            </div>
          )}

          {confirmMsg && (
            <div className="mt-5 rounded-xl bg-green-50 p-4 text-sm text-green-900">
              <p className="font-bold">Mensagem de confirmação gerada:</p>
              <pre className="mt-1 whitespace-pre-wrap font-sans">{confirmMsg}</pre>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

/* ---------------- Gestor (área do dono) ---------------- */

type Tab =
  | "dashboard"
  | "clientes"
  | "vendas"
  | "testes"
  | "transacoes"
  | "servidores"
  | "integracoes"
  | "pagamento"
  | "whatsapp"
  | "planos"
  | "cupons"
  | "indicacao"
  | "suporte";

type ClientFilter = "todos" | "ativos" | "vencidos" | "pausados" | "testes";

function MenuIcon({ tab }: { tab: Tab }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (tab) {
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="8" height="10" rx="1.5" />
          <rect x="13" y="3" width="8" height="6" rx="1.5" />
          <rect x="13" y="11" width="8" height="10" rx="1.5" />
          <rect x="3" y="15" width="8" height="6" rx="1.5" />
        </svg>
      );
    case "clientes":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
          <path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M17.8 14.9c1.6.7 2.5 2.2 2.8 4.6" />
        </svg>
      );
    case "vendas":
      return (
        <svg {...common}>
          <path d="M3.5 4h2l2.4 11h10.4l2-7.5H6.3" />
          <circle cx="10" cy="20" r="1.4" />
          <circle cx="17.5" cy="20" r="1.4" />
        </svg>
      );
    case "testes":
      return (
        <svg {...common}>
          <path d="M10 3h4M10.5 3v5.2L5 18a2.2 2.2 0 0 0 2 3.2h10A2.2 2.2 0 0 0 19 18L13.5 8.2V3" />
          <path d="M7.5 14.5h9" />
        </svg>
      );
    case "transacoes":
      return (
        <svg {...common}>
          <path d="M7 4v12M7 4 4 7M7 4l3 3" />
          <path d="M17 20V8M17 20l3-3M17 20l-3-3" />
        </svg>
      );
    case "servidores":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="7" rx="1.5" />
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <path d="M6.5 7.5h.01M6.5 16.5h.01" />
        </svg>
      );
    case "integracoes":
      return (
        <svg {...common}>
          <path d="M9 7V3.5M15 7V3.5M6.5 7h11V11a5.5 5.5 0 0 1-11 0z" />
          <path d="M12 16.5V21" />
        </svg>
      );
    case "planos":
      return (
        <svg {...common}>
          <path d="m12 3.5 9 5-9 5-9-5z" />
          <path d="m3.8 13.5 8.2 4.6 8.2-4.6" />
        </svg>
      );
    case "cupons":
      return (
        <svg {...common}>
          <path d="M4 8.5V6a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 6v2.5a2.75 2.75 0 0 0 0 5.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2.75 2.75 0 0 0 0-5.5z" />
          <path d="M13.5 7v2M13.5 11v2M13.5 15v2" />
        </svg>
      );
    case "indicacao":
      return (
        <svg {...common}>
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="17.5" cy="5.5" r="2.5" />
          <circle cx="17.5" cy="18.5" r="2.5" />
          <path d="m8.2 10.8 7-4M8.2 13.2l7 4" />
        </svg>
      );
    case "pagamento":
      return (
        <svg {...common}>
          <rect x="3" y="5.5" width="18" height="13" rx="2" />
          <path d="M3 10h18M7 15h4" />
        </svg>
      );
    case "whatsapp":
      return (
        <svg {...common}>
          <rect x="7" y="2.5" width="10" height="19" rx="2" />
          <path d="M11 18.5h2" />
        </svg>
      );
    case "suporte":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.6 9.4A2.6 2.6 0 1 1 12 12.2v.8" />
          <path d="M12 16.8h.01" />
        </svg>
      );
  }
}

function Manager({
  data,
  isPending,
  error,
  onLogout,
}: {
  data: State | undefined;
  isPending: boolean;
  error: unknown;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [clientSearch, setClientSearch] = useState("");
  const [clientFilter, setClientFilter] = useState<ClientFilter>("todos");

  if (isPending) {
    return <div className="min-h-screen bg-[var(--bg)] p-6 text-[var(--text)]">Carregando o gestor…</div>;
  }
  if (error || !data) {
    return <div className="min-h-screen bg-[var(--bg)] p-6 text-[var(--text)]">Erro ao carregar: {String(error)}</div>;
  }

  const expiringSoon = data.clients.filter((c) => {
    const left = daysLeft(c.expiresAt);
    return data.warnDays.some((d) => left === d) || left < 0;
  });
  const pendingPanel = data.payments.filter((p) => p.status === "aprovado_pendente_painel").length;

  const menu: { id: Tab; label: string; badge?: number }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "clientes", label: "Clientes", badge: expiringSoon.length },
    { id: "vendas", label: "Vendas" },
    { id: "testes", label: "Testes" },
    { id: "transacoes", label: "Transações", badge: pendingPanel },
    { id: "servidores", label: "Servidores" },
    { id: "integracoes", label: "Integrações" },
    { id: "pagamento", label: "Integração Pagamento" },
    { id: "whatsapp", label: "WhatsApp" },
    { id: "planos", label: "Planos" },
    { id: "cupons", label: "Cupons" },
    { id: "indicacao", label: "Indicação de Clientes" },
    { id: "suporte", label: "Suporte" },
  ];

  function showClients(filter: ClientFilter, search = "") {
    setClientFilter(filter);
    setClientSearch(search);
    setTab("clientes");
  }

  const statusDots: { label: string; ok: boolean }[] = [
    { label: "Pix (Mercado Pago)", ok: data.mpVerified && data.mpEnvironment === "producao" && data.liveMode },
    { label: "Painel IPTV", ok: data.panelExtendReady },
    { label: "WhatsApp (QR Code)", ok: data.qrWhatsappStatus === "conectado" },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] lg:flex">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <aside className="border-b border-[var(--border)] bg-[var(--surface)] lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-72 lg:shrink-0 lg:flex-col lg:border-b-0 lg:border-r">
        <div className="hidden px-5 pb-1 pt-6 lg:block">
          <p className="font-display text-lg font-extrabold leading-tight">Painel de gestão</p>
          <p className="mt-0.5 text-sm text-[var(--dim)]">Visão geral do sistema</p>
          <ul className="mt-4 space-y-1.5" aria-label="Status das integrações">
            {statusDots.map((s) => (
              <li key={s.label} className="flex items-center gap-2 text-sm">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${s.ok ? "bg-[var(--accent)]" : "bg-[var(--warn)]"}`} />
                <span className="text-[var(--dim)]">{s.label}:</span>
                <strong>{s.ok ? "funcionando" : "pendente"}</strong>
              </li>
            ))}
          </ul>
        </div>
        <nav
          aria-label="Áreas do gestor"
          className="flex flex-wrap gap-1 px-3 py-3 lg:mt-2 lg:flex-1 lg:flex-col lg:flex-nowrap lg:gap-0.5 lg:overflow-y-auto lg:px-3"
        >
          {menu.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={
                tab === t.id
                  ? "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg bg-[var(--accent-soft)] px-3 py-2.5 font-semibold text-[var(--accent-bright)] lg:w-full"
                  : "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 font-medium text-[var(--text)] hover:bg-[var(--surface2)] lg:w-full"
              }
            >
              <MenuIcon tab={t.id} />
              <span>{t.label}</span>
              {t.badge != null && t.badge > 0 && (
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-xs font-bold ${tab === t.id ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="border-t border-[var(--border)] px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">Sua conta</p>
          <p className="mt-0.5 break-all text-sm font-medium">{data.accountEmail}</p>
          <button
            type="button"
            onClick={onLogout}
            className="mt-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold"
            aria-label="Sair da conta"
          >
            Sair
          </button>
          <p className="mt-3 hidden text-xs leading-relaxed text-[var(--dim)] lg:block">
            Pagamento aprovado só vira renovação quando a extensão no painel é
            confirmada. Extensões pendentes aparecem em Transações.
          </p>
        </div>
      </aside>

      <main className="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 pb-12 lg:px-8">
        {tab === "dashboard" && (
          <DashboardTab data={data} onNavigate={setTab} onShowClients={showClients} />
        )}
        {tab === "clientes" && (
          <ClientsTab
            data={data}
            search={clientSearch}
            onSearchChange={setClientSearch}
            filter={clientFilter}
            onFilterChange={setClientFilter}
          />
        )}
        {tab === "vendas" && <SalesTab data={data} />}
        {tab === "testes" && <TestsTab data={data} onShowClients={showClients} />}
        {tab === "transacoes" && <TransactionsTab data={data} />}
        {tab === "servidores" && <ServersTab data={data} />}
        {tab === "integracoes" && <IntegrationsTab data={data} />}
        {tab === "pagamento" && <PaymentsTab data={data} />}
        {tab === "whatsapp" && <WhatsAppTab data={data} />}
        {tab === "planos" && <PlansTab data={data} onNavigate={setTab} />}
        {tab === "cupons" && <CouponsTab data={data} />}
        {tab === "indicacao" && <ReferralsTab data={data} onShowClients={showClients} />}
        {tab === "suporte" && <SupportTab data={data} onNavigate={setTab} />}
      </main>
    </div>
  );
}

function IntegrationStatus({ data }: { data: State }) {
  const pixReady = data.mpVerified && data.mpEnvironment === "producao" && data.liveMode;
  const whatsappReady = data.qrWhatsappStatus === "conectado";
  const fullAutomationReady = pixReady && data.panelExtendReady && whatsappReady;
  const pendingPanel = data.payments.filter((p) => p.status === "aprovado_pendente_painel").length;

  const working: string[] = [];
  const missing: { what: string; how: string }[] = [];

  if (data.mpVerified) working.push("Receber Pix de verdade (Mercado Pago conectado)");
  else
    missing.push({
      what: "Cadastrar o Mercado Pago",
      how: "Abra Integração Pagamento, cole a Public Key e o Access Token da sua conta do Mercado Pago, toque em Salvar e depois no botão grande “Testar Mercado Pago”. Sem isso, a fatura não gera Pix de verdade.",
    });
  if (data.mpVerified && !pixReady)
    missing.push({
      what: "Ligar o Pix ao vivo",
      how: "Em Integração Pagamento, deixe o ambiente em Produção e ligue o “modo ao vivo”. Só assim o link da fatura cobra dinheiro de verdade.",
    });
  if (data.panelConnected) working.push("Gestor conversa com o painel IPTV (login da API aprovado)");
  else
    missing.push({
      what: "Cadastrar o painel IPTV",
      how: "Abra a aba Servidores, edite o seu servidor, cole o código (token) da API do painel e toque em Salvar e em Testar conexão. Se der HTTP 400, abra o diagnóstico na própria aba: ele mostra a mensagem exata da API, as variações testadas e o que conferir na base e no token.",
    });
  if (data.panelConnected && data.panelExtendReady)
    working.push("Renovação automática no painel (a extensão do cliente já funcionou de verdade uma vez)");
  else if (data.panelConnected)
    missing.push({
      what: "Confirmar a renovação automática no painel",
      how: "Na aba Servidores, use o “Teste de extensão” em um cliente: ele aperta sozinho o botão de estender daquele cliente no painel, pela duração do plano (30 dias = 1 crédito). Atenção: esse teste renova de verdade e consome o crédito do plano. Até ele passar, pagamento aprovado fica como “extensão pendente” e nenhum crédito é dado como gasto.",
    });
  if (data.qrWhatsappStatus === "conectado") {
    working.push("WhatsApp conectado pelo QR Code (único caminho de WhatsApp do gestor)");
  } else {
    missing.push({
      what: "Conectar o WhatsApp pelo QR Code",
      how: "Abra a aba WhatsApp, toque no botão “Gerar QR Code”, abra o WhatsApp do celular em Aparelhos conectados e leia o QR Code que aparecer. A tela verifica sozinha a cada 3 segundos até conectar.",
    });
  }

  return (
    <section aria-label="O que está funcionando e o que falta" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">O que está funcionando / o que falta</h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            Lista simples, sem termos técnicos: o que já está pronto e o que ainda falta cadastrar para a renovação ser 100% automática.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-bold ${fullAutomationReady ? "bg-[var(--ok-bg)] text-[var(--accent)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}
        >
          {fullAutomationReady ? "Tudo funcionando" : "Ainda falta cadastrar"}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-[var(--surface2)] p-3">
          <p className="font-semibold">✅ Já está funcionando</p>
          {working.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {working.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-[var(--dim)]">Nada ainda — comece pelo primeiro item da lista ao lado.</p>
          )}
          <p className="mt-3 text-sm">
            <strong>Como a renovação acontece:</strong> o cliente paga o Pix da fatura → o gestor confere o pagamento no Mercado Pago →
            aperta sozinho o botão <strong>[+] Estender</strong> daquele cliente no painel, pela duração do plano
            (30 dias = 1 crédito, 60 = 2, 90 = 3) → manda a confirmação no WhatsApp dele.
          </p>
        </div>
        <div className="rounded-lg bg-[var(--surface2)] p-3">
          <p className="font-semibold">⏳ O que falta</p>
          {missing.length > 0 ? (
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
              {missing.map((m) => (
                <li key={m.what}>
                  <strong>{m.what}.</strong> <span className="text-[var(--dim)]">{m.how}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-[var(--dim)]">Nada! Pode enviar o link da fatura para o cliente.</p>
          )}
        </div>
      </div>

      {pendingPanel > 0 && (
        <p className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn)]">
          <strong>{pendingPanel} pagamento(s) aprovado(s)</strong> estão esperando a extensão no painel.
          Nenhum crédito foi dado como gasto nessas cobranças. Depois que a extensão estiver confirmada,
          use “Verificar no Mercado Pago” na fatura ou em Integração Pagamento para o gestor tentar de novo.
        </p>
      )}
    </section>
  );
}

function statusBadge(client: Client): { label: string; cls: string } {
  if (client.status === "pausado") return { label: "Pausado", cls: "bg-[var(--surface2)] text-[var(--dim)]" };
  const left = daysLeft(client.expiresAt);
  if (left < 0) return { label: `Vencido há ${-left}d`, cls: "bg-[var(--danger-bg)] text-[var(--danger)]" };
  if (left === 0) return { label: "Vence hoje", cls: "bg-[var(--warn-bg)] text-[var(--warn)]" };
  if (left <= 3) return { label: `Vence em ${left}d`, cls: "bg-[var(--warn-bg)] text-[var(--warn)]" };
  return { label: `Ativo • ${left}d restantes`, cls: "bg-[var(--ok-bg)] text-[var(--accent)]" };
}

function ClientRenewalDetail({ data, client }: { data: State; client: Client }) {
  const c = client;
  const queryClient = useQueryClient();
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const publicLink = invoiceUrl(c, data.publicBaseUrl);
  const regenLink = useMutation({
    mutationFn: () => api.regenerateInvoiceLink({ clientId: c.id }),
    onSuccess: () => {
      setLinkMsg("Link novo gerado ✓ O link antigo deste cliente parou de funcionar — envie o link novo para ele.");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setLinkMsg(`Não foi possível gerar o link novo: ${String(e)}`),
  });
  const clientPayments = data.payments.filter((p) => p.clientId === c.id);
  const pendingPanelPayments = clientPayments.filter((p) => p.status === "aprovado_pendente_painel");
  const latestPayment = clientPayments[0] ?? null;
  const hasPendingPanel = pendingPanelPayments.length > 0;
  const nextDays = c.planDays ?? latestPayment?.days ?? null;
  const nextCredits = c.planCredits ?? latestPayment?.credits ?? (nextDays != null ? Math.round(nextDays / 30) : null);
  const durationLabel =
    nextDays === 30
      ? "1 mês — 30 dias"
      : nextDays === 60
        ? "2 meses — 60 dias"
        : nextDays === 90
          ? "3 meses — 90 dias"
          : nextDays != null
            ? `${nextDays} dias`
            : "sem plano definido";

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3" aria-label={`Link público da fatura de ${c.name}`}>
        <p className="font-display text-sm font-bold">Link público da fatura deste cliente</p>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Este é o link que vai junto na mensagem. Ele abre a fatura <strong>sem login</strong> — o código
          secreto no fim do link é o que identifica a fatura deste cliente.
          {!data.publicBaseUrl &&
            " Atenção: o endereço público da hospedagem (Render) ainda não foi salvo em Suporte → Hospedagem, então este link ainda é o endereço do Muse e pede login do Muse para quem abre."}
        </p>
        <p className="mt-2 break-all rounded-lg bg-[var(--surface2)] px-3 py-2 font-mono text-xs">{publicLink}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className={btnGhost}
            aria-label={`Copiar link público da fatura de ${c.name}`}
            onClick={async () => setLinkCopied(await copyText(publicLink))}
          >
            {linkCopied ? "Link copiado ✓" : "Copiar link da fatura"}
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={regenLink.isPending}
            aria-label={`Gerar novo link da fatura de ${c.name} — o link antigo para de funcionar`}
            onClick={() => {
              setLinkCopied(false);
              setLinkMsg(null);
              regenLink.mutate();
            }}
          >
            {regenLink.isPending ? "Gerando…" : "Gerar novo link (o antigo para de valer)"}
          </button>
        </div>
        {linkMsg && <p className="mt-2 text-sm font-medium" role="status">{linkMsg}</p>}
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg bg-[var(--surface)] p-2.5">
          <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Usuário IPTV</dt>
          <dd className="mt-1 font-mono">{c.iptvUser} • senha guardada no gestor</dd>
        </div>
        <div className="rounded-lg bg-[var(--surface)] p-2.5">
          <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Aplicativo / dispositivo</dt>
          <dd className="mt-1">{c.app || "—"}{c.device ? ` • ${c.device}` : ""}{c.screens != null ? ` • ${c.screens} tela${c.screens > 1 ? "s" : ""}` : ""}</dd>
        </div>
        <div className="rounded-lg bg-[var(--surface)] p-2.5">
          <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Captação / painel extra</dt>
          <dd className="mt-1">{c.source || "—"}{c.extraPanel ? ` • ${c.extraPanel}` : ""}</dd>
        </div>
        <div className="rounded-lg bg-[var(--surface)] p-2.5">
          <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Cadastro / indicação</dt>
          <dd className="mt-1">
            {fmtDate(c.createdAt)}
            {c.referredBy ? ` • indicado por ${c.referredBy}` : ""}
          </dd>
        </div>
      </dl>

      <div
        className={`rounded-xl border p-3 ${hasPendingPanel ? "border-[var(--warn)] bg-[var(--warn-bg)]" : "border-[var(--border)] bg-[var(--surface2)]"}`}
        aria-label={`Renovação no painel para ${c.name}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="font-display text-sm font-bold">
            Renovação no painel — botão [+] Estender
          </p>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${hasPendingPanel ? "bg-[var(--surface)] text-[var(--warn)]" : data.panelExtendReady ? "bg-[var(--ok-bg)] text-[var(--card-green)]" : "bg-[var(--surface)] text-[var(--dim)]"}`}>
            {hasPendingPanel ? "Pagamento aprovado — extensão pendente no painel" : data.panelExtendReady ? "Extensão automática verificada" : data.panelConnected ? "API conectada — extensão ainda pendente de teste real" : "Painel não conectado — extensão bloqueada"}
          </span>
        </div>

        <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-lg bg-[var(--surface)] p-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Alvo exato no painel</p>
            <p className="mt-1">
              Lista <span className="font-mono text-xs">wwpanel.link/user-list</span> → linha do usuário{" "}
              <strong className="font-mono">{c.iptvUser}</strong>, canto direito da linha.
            </p>
            <p className="mt-1 text-[var(--dim)]">
              Ordem dos ícones na linha: <span className="font-semibold text-[var(--text)]">[ícone verde WhatsApp] → [+] Estender</span>. O WhatsApp fica imediatamente à esquerda e não renova; o <strong>[+]</strong> é o botão de estender/renovar.
            </p>
          </div>
          <div className="rounded-lg bg-[var(--surface)] p-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Duração que o [+] deve aplicar</p>
            {nextDays != null ? (
              <>
                <p className="mt-1">
                  Selecionar <strong>{durationLabel}</strong> quando o painel perguntar “por quanto tempo?”
                </p>
                <p className="mt-1 text-[var(--dim)]">
                  Isso vem do plano <strong className="text-[var(--text)]">{c.planName ?? "deste cliente"}</strong>: {nextDays} dias ={" "}
                  <strong className="text-[var(--text)]">{nextCredits} crédito{nextCredits !== 1 ? "s" : ""}</strong> (1 crédito = 30 dias / 1 mês). Normalmente é só 1 mês, mas o gestor usa o plano cadastrado.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Durações possíveis da extensão">
                  {[30, 60, 90].map((d) => {
                    const active = nextDays === d;
                    const cr = Math.round(d / 30);
                    return (
                      <span
                        key={d}
                        aria-current={active ? "true" : undefined}
                        className={`rounded-full px-2.5 py-1 text-xs font-bold ${active ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface2)] text-[var(--dim)]"}`}
                      >
                        {d === 30 ? "1 mês" : d === 60 ? "2 meses" : "3 meses"} · {d}d · {cr} créd.
                      </span>
                    );
                  })}
                  {nextDays != null && ![30, 60, 90].includes(nextDays) && (
                    <span className="rounded-full bg-[var(--accent)] px-2.5 py-1 text-xs font-bold text-[var(--accent-ink)]">
                      {nextDays} dias · {nextCredits} créd. — plano atual
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-1 text-[var(--dim)]">Este cliente está sem plano. Edite o cliente e escolha um plano para o gestor saber quantos dias/créditos o [+] deve aplicar.</p>
            )}
          </div>
        </div>

        <div className="mt-2 rounded-lg bg-[var(--surface)] p-2.5 text-sm">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Estado do pagamento para esta renovação</p>
          {hasPendingPanel ? (
            <div className="mt-1">
              <p className="font-semibold text-[var(--warn)]">
                {pendingPanelPayments.length} pagamento(s) aprovado(s) aguardando o [+] no painel — nenhum crédito consumido ainda.
              </p>
              <ul className="mt-1 space-y-1">
                {pendingPanelPayments.map((p) => (
                  <li key={p.id}>
                    Usuário <strong className="font-mono">{c.iptvUser}</strong> · {p.days} dias · {p.credits} crédito{p.credits > 1 ? "s" : ""} · {brl(p.amountCents)} · aprovado em {new Date(p.createdAt).toLocaleDateString("pt-BR")}
                    {p.wouldExpireAt ? ` · novo vencimento calculado: ${fmtDate(p.wouldExpireAt)} (ainda não aplicado no painel)` : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[var(--dim)]">Próximo passo manual enquanto o painel não está conectado: abrir a linha de <strong>{c.iptvUser}</strong> e clicar no [+] Estender com a duração acima. Não clique no ícone do WhatsApp ao lado.</p>
            </div>
          ) : latestPayment ? (
            <p className="mt-1">
              Última cobrança: <strong>{paymentStatusLabel(latestPayment.status)}</strong> · {latestPayment.days} dias · {latestPayment.credits} crédito{latestPayment.credits > 1 ? "s" : ""} · {brl(latestPayment.amountCents)} · {new Date(latestPayment.createdAt).toLocaleDateString("pt-BR")}
              {latestPayment.mode === "validacao" ? " · modo validação (não consome crédito)" : " · ao vivo"}
              {latestPayment.detail ? <span className="block text-[var(--dim)]">{latestPayment.detail}</span> : null}
            </p>
          ) : (
            <p className="mt-1 text-[var(--dim)]">Nenhuma cobrança recente para este cliente. A próxima renovação será de {nextDays != null ? `${nextDays} dias (${nextCredits} crédito${nextCredits !== 1 ? "s" : ""})` : "— defina um plano —"} quando o Pix da fatura for pago.</p>
          )}
          {!data.panelExtendReady && !hasPendingPanel && (
            <p className="mt-1 text-xs text-[var(--dim)]">Status honesto: pagamento aprovado só vira renovação quando a chamada de extensão da API aceita. Até um teste real de extensão passar na aba Servidores, ele entra como “extensão pendente” e nenhum crédito é dado como gasto.</p>
          )}
        </div>
      </div>
    </div>
  );
}

type ClientView = "lista" | "arquivados" | "lixeira";
type ExpiryFilter = "todos" | "vencidos" | "hoje" | "3d" | "7d" | "30d";

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={`Filtrar por ${label.toLowerCase()}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-medium text-[var(--text)]"
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ClientsTab({
  data,
  search,
  onSearchChange,
  filter,
  onFilterChange,
}: {
  data: State;
  search: string;
  onSearchChange: (value: string) => void;
  filter: ClientFilter;
  onFilterChange: (value: ClientFilter) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Client | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [view, setView] = useState<ClientView>("lista");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("todos");
  const [serverFilter, setServerFilter] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [appFilter, setAppFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [deviceFilter, setDeviceFilter] = useState("");
  const [extraFilter, setExtraFilter] = useState("");
  const [screensFilter, setScreensFilter] = useState("");
  const [recentFirst, setRecentFirst] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sendFor, setSendFor] = useState<Client | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteClient({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const move = useMutation({
    mutationFn: (args: { id: number; state: "normal" | "arquivado" | "lixeira" }) =>
      api.setClientListState(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const normalClients = data.clients.filter((c) => c.listState === "normal");
  const archivedCount = data.clients.filter((c) => c.listState === "arquivado").length;
  const trashCount = data.clients.filter((c) => c.listState === "lixeira").length;

  const totalValue = normalClients.reduce((s, c) => s + c.effectivePriceCents, 0);
  const activeClients = normalClients.filter((c) => c.status === "ativo" && daysLeft(c.expiresAt) >= 0);
  const expiredClients = normalClients.filter((c) => daysLeft(c.expiresAt) < 0);
  const activeValue = activeClients.reduce((s, c) => s + c.effectivePriceCents, 0);
  const expiredValue = expiredClients.reduce((s, c) => s + c.effectivePriceCents, 0);
  const pausedCount = normalClients.filter((c) => c.status === "pausado").length;

  const statCards = [
    { label: "Total", count: normalClients.length, value: totalValue, hint: pausedCount > 0 ? `${pausedCount} pausado${pausedCount > 1 ? "s" : ""}` : "clientes na lista", color: "var(--card-blue)", bg: "var(--card-blue-bg)" },
    { label: "Ativos", count: activeClients.length, value: activeValue, hint: "assinaturas dentro do prazo", color: "var(--card-green)", bg: "var(--card-green-bg)" },
    { label: "Vencidos", count: expiredClients.length, value: expiredValue, hint: "precisam de renovação", color: "var(--card-red)", bg: "var(--card-red-bg)" },
  ];

  const pool =
    view === "lista"
      ? normalClients
      : data.clients.filter((c) => c.listState === (view === "arquivados" ? "arquivado" : "lixeira"));

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  const filtered = pool.filter((c) => {
    if (filter === "ativos" && !(c.status === "ativo" && daysLeft(c.expiresAt) >= 0 && !c.isTest)) return false;
    if (filter === "vencidos" && !(daysLeft(c.expiresAt) < 0 && !c.isTest)) return false;
    if (filter === "pausados" && c.status !== "pausado") return false;
    if (filter === "testes" && !c.isTest) return false;
    const left = daysLeft(c.expiresAt);
    if (expiryFilter === "vencidos" && left >= 0) return false;
    if (expiryFilter === "hoje" && left !== 0) return false;
    if (expiryFilter === "3d" && !(left >= 0 && left <= 3)) return false;
    if (expiryFilter === "7d" && !(left >= 0 && left <= 7)) return false;
    if (expiryFilter === "30d" && !(left >= 0 && left <= 30)) return false;
    if (serverFilter && (c.serverName ?? "") !== serverFilter) return false;
    if (planFilter && (c.planName ?? "") !== planFilter) return false;
    if (appFilter && c.app !== appFilter) return false;
    if (sourceFilter && c.source !== sourceFilter) return false;
    if (deviceFilter && c.device !== deviceFilter) return false;
    if (extraFilter && c.extraPanel !== extraFilter) return false;
    if (screensFilter && String(c.screens ?? "") !== screensFilter) return false;
    if (!q) return true;
    if (c.name.toLowerCase().includes(q)) return true;
    if (c.iptvUser.toLowerCase().includes(q)) return true;
    if ((c.referredBy ?? "").toLowerCase().includes(q)) return true;
    if (qDigits.length >= 3 && (c.whatsapp ?? "").replace(/\D/g, "").includes(qDigits)) return true;
    return false;
  });
  const visible = recentFirst
    ? [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : filtered;

  const distinct = (values: (string | null | undefined)[]) =>
    [...new Set(values.map((v) => (v ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const toOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }));

  const alerts = normalClients.filter((c) => {
    const left = daysLeft(c.expiresAt);
    return c.status === "ativo" && (left < 0 || data.warnDays.includes(left));
  });

  function rowActions(c: Client) {
    return (
      <div className="flex flex-wrap gap-1.5">
        <a
          href={invoiceHash(c)}
          aria-label={`Abrir página da fatura de ${c.name}`}
          className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-bold text-[var(--accent-ink)]"
        >
          Fatura
        </a>
        {c.whatsapp && (
          <a
            href={waLink(
              c.whatsapp,
              withInvoiceLink(
                renderMsg(data.warnMessage, {
                  nome: c.name,
                  usuario: c.iptvUser,
                  vencimento: fmtDate(c.expiresAt),
                  dias: c.planDays,
                  valor: brl(c.effectivePriceCents),
                  plano: c.planName,
                  link: invoiceUrl(c, data.publicBaseUrl),
                }),
                c,
                data.publicBaseUrl,
              ),
            )}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold"
            aria-label={`Enviar fatura no WhatsApp para ${c.name} — a mensagem inclui o link da fatura, só mensagem, não renova no painel`}
          >
            WhatsApp
          </a>
        )}
        <button
          type="button"
          className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-bold text-[var(--accent-ink)]"
          aria-label={`Enviar mensagem automática no WhatsApp para ${c.name}`}
          onClick={() => setSendFor(c)}
        >
          Enviar mensagem
        </button>
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold"
          aria-expanded={expandedId === c.id}
          aria-label={`${expandedId === c.id ? "Fechar" : "Ver"} detalhes de ${c.name}`}
          onClick={() => setExpandedId((id) => (id === c.id ? null : c.id))}
        >
          {expandedId === c.id ? "Fechar" : "Detalhes"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold"
          onClick={() => {
            setEditing(c);
            setShowForm(true);
          }}
        >
          Editar
        </button>
        {view === "lista" && (
          <>
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold"
              aria-label={`Arquivar cliente ${c.name}`}
              onClick={() => move.mutate({ id: c.id, state: "arquivado" })}
            >
              Arquivar
            </button>
            <button
              type="button"
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--danger)]"
              aria-label={`Mover cliente ${c.name} para a lixeira`}
              onClick={() => move.mutate({ id: c.id, state: "lixeira" })}
            >
              Lixeira
            </button>
          </>
        )}
        {view !== "lista" && (
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold"
            aria-label={`Restaurar cliente ${c.name} para a lista`}
            onClick={() => move.mutate({ id: c.id, state: "normal" })}
          >
            Restaurar
          </button>
        )}
        {view === "lixeira" && (
          <button
            type="button"
            className="rounded-lg border border-[var(--danger)] px-2.5 py-1.5 text-xs font-bold text-[var(--danger)]"
            aria-label={`Excluir definitivamente o cliente ${c.name}`}
            onClick={() => del.mutate(c.id)}
          >
            Excluir definitivo
          </button>
        )}
      </div>
    );
  }

  return (
    <section aria-label="Clientes" className="mt-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Clientes</h2>
        <p className="mt-0.5 text-sm text-[var(--dim)]">Gerencie todos os seus clientes</p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {statCards.map((card) => (
          <div key={card.label} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-display text-3xl font-extrabold leading-none">{card.count}</p>
                <p className="mt-1.5 text-sm font-semibold text-[var(--dim)]">{card.label}</p>
              </div>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: card.bg, color: card.color }} aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="8" r="3.5" />
                  <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
                </svg>
              </span>
            </div>
            <p className="mt-2 text-sm font-bold" style={{ color: card.color }}>{brl(card.value)}</p>
            <p className="text-xs text-[var(--dim)]">{card.hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <label htmlFor="clients-search" className="sr-only">Buscar cliente</label>
        <input
          id="clients-search"
          className={inputCls}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Buscar por nome, usuário, WhatsApp ou email..."
          autoComplete="off"
        />
      </div>

      <button
        type="button"
        className={`${btnPrimary} mt-3 w-full py-3 text-center font-display text-base`}
        onClick={() => {
          setEditing(null);
          setShowForm((v) => !v);
        }}
      >
        {showForm && !editing ? "Fechar" : "+ Novo Cliente"}
      </button>

      {showForm && (
        <ClientForm
          data={data}
          initial={editing}
          onDone={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <button
          type="button"
          aria-pressed={view === "arquivados"}
          onClick={() => setView((v) => (v === "arquivados" ? "lista" : "arquivados"))}
          className={view === "arquivados" ? "rounded-lg bg-[var(--accent-soft)] px-3 py-2.5 font-semibold text-[var(--accent-bright)]" : "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 font-medium"}
        >
          Arquivados ({archivedCount})
        </button>
        <button
          type="button"
          aria-pressed={view === "lixeira"}
          onClick={() => setView((v) => (v === "lixeira" ? "lista" : "lixeira"))}
          className={view === "lixeira" ? "rounded-lg bg-[var(--accent-soft)] px-3 py-2.5 font-semibold text-[var(--accent-bright)]" : "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 font-medium"}
        >
          Lixeira ({trashCount})
        </button>
      </div>
      {view !== "lista" && (
        <p className="mt-2 text-sm text-[var(--dim)]" role="status">
          {view === "arquivados"
            ? "Mostrando os clientes arquivados. Use Restaurar para voltar um cliente para a lista."
            : "Mostrando a lixeira. Restaurar devolve o cliente para a lista; Excluir definitivo apaga o cadastro."}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5" role="group" aria-label="Filtros da lista de clientes">
        <FilterSelect
          label="Status"
          value={filter === "todos" ? "" : filter}
          onChange={(v) => onFilterChange((v === "" ? "todos" : v) as ClientFilter)}
          options={[
            { value: "ativos", label: "Ativos" },
            { value: "vencidos", label: "Vencidos" },
            { value: "pausados", label: "Pausados" },
            { value: "testes", label: "Testes" },
          ]}
        />
        <FilterSelect
          label="Vencimento"
          value={expiryFilter === "todos" ? "" : expiryFilter}
          onChange={(v) => setExpiryFilter((v === "" ? "todos" : v) as ExpiryFilter)}
          options={[
            { value: "vencidos", label: "Vencidos" },
            { value: "hoje", label: "Vence hoje" },
            { value: "3d", label: "Próximos 3 dias" },
            { value: "7d", label: "Próximos 7 dias" },
            { value: "30d", label: "Próximos 30 dias" },
          ]}
        />
        <FilterSelect label="Servidor" value={serverFilter} onChange={setServerFilter} options={toOptions(distinct(pool.map((c) => c.serverName)))} />
        <FilterSelect label="Plano" value={planFilter} onChange={setPlanFilter} options={toOptions(distinct(pool.map((c) => c.planName)))} />
        <FilterSelect label="Aplicativo" value={appFilter} onChange={setAppFilter} options={toOptions(distinct(pool.map((c) => c.app)))} />
        <FilterSelect label="Captação" value={sourceFilter} onChange={setSourceFilter} options={toOptions(distinct(pool.map((c) => c.source)))} />
        <FilterSelect label="Dispositivo" value={deviceFilter} onChange={setDeviceFilter} options={toOptions(distinct(pool.map((c) => c.device)))} />
        <FilterSelect label="Painel Extra" value={extraFilter} onChange={setExtraFilter} options={toOptions(distinct(pool.map((c) => c.extraPanel)))} />
        <FilterSelect
          label="Telas"
          value={screensFilter}
          onChange={setScreensFilter}
          options={distinct(pool.map((c) => (c.screens != null ? String(c.screens) : ""))).map((v) => ({ value: v, label: `${v} tela${v === "1" ? "" : "s"}` }))}
        />
        <button
          type="button"
          aria-pressed={recentFirst}
          onClick={() => setRecentFirst((v) => !v)}
          className={recentFirst ? "rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-bold text-[var(--accent-ink)]" : "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-medium"}
        >
          Recém Cadastrados
        </button>
      </div>

      {view === "lista" && alerts.length > 0 && (
        <div className="mt-4 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] px-4 py-3">
          <p className="font-display font-bold">Avisos de vencimento ({alerts.length})</p>
          <ul className="mt-1 space-y-1 text-sm">
            {alerts.map((c) => {
              const left = daysLeft(c.expiresAt);
              const msg = data.warnMessage
                .replaceAll("{nome}", c.name)
                .replaceAll("{usuario}", c.iptvUser)
                .replaceAll("{vencimento}", fmtDate(c.expiresAt));
              return (
                <li key={c.id}>
                  <strong>{c.name}</strong> —{" "}
                  {left < 0 ? `vencido há ${-left} dia(s)` : left === 0 ? "vence hoje" : `vence em ${left} dia(s)`}
                  <span className="block text-[var(--dim)]">Mensagem pronta: “{msg}”</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-[var(--dim)]">
            O texto e os dias de aviso são editáveis em Integrações → Mensagens e Ajustes.
            O WhatsApp é conectado pelo QR Code, na aba WhatsApp. O botão de
            cada cliente abre o WhatsApp com a mensagem pronta para você confirmar o envio.
          </p>
        </div>
      )}

      <p className="mt-4 text-sm text-[var(--dim)]" role="status">
        {visible.length} cliente{visible.length === 1 ? "" : "s"} nesta lista
        {visible.length !== pool.length ? ` de ${pool.length}` : ""}
      </p>

      {/* Tabela (telas grandes) */}
      <div className="mt-2 hidden overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] lg:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--dim)]">
              <th scope="col" className="px-4 py-3 font-bold">Cliente</th>
              <th scope="col" className="px-4 py-3 font-bold">WhatsApp</th>
              <th scope="col" className="px-4 py-3 font-bold">Plano</th>
              <th scope="col" className="px-4 py-3 font-bold">Valor</th>
              <th scope="col" className="px-4 py-3 font-bold">Servidor</th>
              <th scope="col" className="px-4 py-3 font-bold">Vencimento</th>
              <th scope="col" className="px-4 py-3 font-bold">Aplicativo</th>
              <th scope="col" className="px-4 py-3 font-bold">Ações</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const badge = statusBadge(c);
              const left = daysLeft(c.expiresAt);
              return [
                <tr key={`row-${c.id}`} className="border-b border-[var(--border)] align-top last:border-b-0">
                  <td className="px-4 py-3">
                    <p className="font-display font-bold uppercase">
                      {c.name}
                      {c.isTest && (
                        <span className="ml-2 rounded-full bg-[var(--warn-bg)] px-2 py-0.5 align-middle text-xs font-bold normal-case text-[var(--warn)]">
                          TESTE
                        </span>
                      )}
                    </p>
                    <p className="font-mono text-xs text-[var(--dim)]">{c.iptvUser}</p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{c.whatsapp ? c.whatsapp : "—"}</td>
                  <td className="px-4 py-3">{c.planName ?? "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap font-semibold">{brl(c.effectivePriceCents)}</td>
                  <td className="px-4 py-3">
                    {c.serverName ? (
                      (() => {
                        const srv = data.servers.find((s) => s.id === c.serverId);
                        return srv?.panelUrl ? (
                          <a
                            href={srv.panelUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold text-[var(--accent-bright)] underline"
                            aria-label={`Abrir o painel do servidor ${c.serverName}`}
                          >
                            {c.serverName} ↗
                          </a>
                        ) : (
                          <span className="font-semibold text-[var(--accent-bright)]">{c.serverName}</span>
                        );
                      })()
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {fmtDate(c.expiresAt)}
                    <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-bold ${badge.cls}`}>
                      {c.status === "pausado" ? "Pausado" : left < 0 ? "Vencido" : "Ativo"}
                    </span>
                  </td>
                  <td className="px-4 py-3">{c.app || "—"}</td>
                  <td className="px-4 py-3">{rowActions(c)}</td>
                </tr>,
                expandedId === c.id ? (
                  <tr key={`detail-${c.id}`} className="border-b border-[var(--border)] bg-[var(--surface2)] last:border-b-0">
                    <td colSpan={8} className="px-4 py-3">
                      <ClientRenewalDetail data={data} client={c} />
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="px-4 py-8 text-center text-[var(--dim)]">
            {pool.length === 0
              ? view === "lista"
                ? "Nenhum cliente ainda. Toque em Novo Cliente para cadastrar o primeiro."
                : "Nada por aqui ainda."
              : "Nenhum cliente bate com esta busca ou filtro. Limpe a busca ou troque os filtros para ver a lista completa."}
          </p>
        )}
      </div>

      {/* Cartões (celular) */}
      <ul className="mt-2 space-y-3 lg:hidden">
        {visible.map((c) => {
          const badge = statusBadge(c);
          return (
            <li key={c.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-display text-lg font-bold uppercase">
                    {c.name}
                    {c.isTest && (
                      <span className="ml-2 rounded-full bg-[var(--warn-bg)] px-2 py-0.5 align-middle text-xs font-bold normal-case text-[var(--warn)]">
                        TESTE
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-sm text-[var(--dim)]">{c.iptvUser}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-sm font-semibold ${badge.cls}`}>{badge.label}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">WhatsApp</dt>
                  <dd>{c.whatsapp || "não cadastrado"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Plano</dt>
                  <dd>{c.planName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Valor</dt>
                  <dd className="font-semibold">{brl(c.effectivePriceCents)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Servidor</dt>
                  <dd>{c.serverName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Vencimento</dt>
                  <dd className="font-semibold">{fmtDate(c.expiresAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Aplicativo</dt>
                  <dd>{c.app || "—"}</dd>
                </div>
              </dl>
              <div className="mt-3">{rowActions(c)}</div>
              {expandedId === c.id && (
                <div className="mt-3">
                  <ClientRenewalDetail data={data} client={c} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && (
        <p className="mt-6 text-center text-[var(--dim)] lg:hidden">
          {pool.length === 0
            ? view === "lista"
              ? "Nenhum cliente ainda. Toque em Novo Cliente para cadastrar o primeiro, com o usuário e a senha que você criou no painel IPTV."
              : "Nada por aqui ainda."
            : "Nenhum cliente bate com esta busca ou filtro. Limpe a busca ou troque os filtros para ver a lista completa."}
        </p>
      )}
      {sendFor && (
        <SendMessageModal data={data} client={sendFor} onClose={() => setSendFor(null)} />
      )}
    </section>
  );
}

/* -------- Enviar mensagem automática (WhatsApp conectado) -------- */

type SendTemplateKey = "expirado" | "vence-hoje" | "cobranca";

// Modal do botão "Enviar mensagem" de cada cliente: mostra o nome e o
// telefone do cliente, o "Enviar por" (Automático/Padrão ou o
// dispositivo conectado por QR Code), o seletor de template e a
// mensagem pronta com as tags substituídas de verdade. O botão
// Enviar manda a mensagem AUTOMATICAMENTE pelo WhatsApp conectado
// do gestor, direto para o número do cliente — sem abrir wa.me e
// sem copiar e colar.
function SendMessageModal({
  data,
  client,
  onClose,
}: {
  data: State;
  client: Client;
  onClose: () => void;
}) {
  const [sendVia, setSendVia] = useState("auto");
  const [templateKey, setTemplateKey] = useState<SendTemplateKey>(
    overdueDays(client.expiresAt) > 0 ? "expirado" : "vence-hoje",
  );
  const [result, setResult] = useState<{ sent: boolean; detail: string } | null>(null);

  const connected = data.qrWhatsappStatus === "conectado";
  const devicePhone = data.qrWhatsappPhone || "";
  const overdue = overdueDays(client.expiresAt);

  const templates: { key: SendTemplateKey; label: string; text: string }[] = [
    { key: "expirado", label: "Acesso expirado", text: data.expiredMessage },
    { key: "vence-hoje", label: "Vence hoje", text: data.warnMessage },
    { key: "cobranca", label: "Cobrança", text: data.chargeMessage },
  ];
  const selected = templates.find((t) => t.key === templateKey) ?? templates[0]!;

  const rendered = renderMsg(selected.text, {
    nome: client.name,
    usuario: client.iptvUser,
    telefone: client.whatsapp ?? "",
    vencimento: fmtDate(client.expiresAt),
    novoVencimento: fmtDate(client.planDays != null ? todayPlusDays(client.planDays) : client.expiresAt),
    dias: client.planDays,
    diasVencido: overdue,
    valor: brl(client.effectivePriceCents),
    plano: client.planName,
    link: invoiceUrl(client, data.publicBaseUrl),
  });
  let message = withInvoiceLink(rendered, client, data.publicBaseUrl);
  // No modelo "Acesso expirado", os dias vencidos aparecem sempre:
  // se o modelo salvo não tiver a tag {dias_vencido}, a linha entra
  // no fim da mensagem (e aparece na prévia, igual ao que é enviado).
  if (
    templateKey === "expirado" &&
    overdue > 0 &&
    !selected.text.includes("{dias_vencido}") &&
    !message.includes(`há ${overdue} dia`)
  ) {
    message = `${message}\nSua assinatura está vencida há ${overdue} dia${overdue > 1 ? "s" : ""} (desde ${fmtDate(client.expiresAt)}).`;
  }

  const send = useMutation({
    mutationFn: () => api.sendWhatsAppMessage({ clientId: client.id, text: message }),
    onSuccess: (r) => setResult({ sent: r.sent, detail: r.detail }),
    onError: (e) => setResult({ sent: false, detail: String(e) }),
  });

  const url = invoiceUrl(client, data.publicBaseUrl);
  const previewParts = message.split(url);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Enviar mensagem para ${client.name}`}
    >
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-5 shadow-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-xl font-extrabold">{client.name}</h3>
            <p className="mt-0.5 text-sm text-[var(--dim)]">
              {client.whatsapp ? client.whatsapp : "Sem número de WhatsApp cadastrado"}
            </p>
          </div>
          <button
            type="button"
            className={btnGhost}
            aria-label="Fechar envio de mensagem"
            onClick={onClose}
          >
            Fechar
          </button>
        </div>

        <div className="mt-4">
          <label htmlFor="send-via" className={labelCls}>Enviar por</label>
          <select
            id="send-via"
            className={inputCls}
            value={sendVia}
            onChange={(e) => setSendVia(e.target.value)}
          >
            <option value="auto">Automático / Padrão</option>
            {connected && devicePhone && (
              <option value={devicePhone}>Dispositivo conectado — {devicePhone}</option>
            )}
            {connected && !devicePhone && (
              <option value="conectado">Dispositivo conectado</option>
            )}
          </select>
          <p className="mt-1 text-xs text-[var(--dim)]">
            {connected
              ? "O envio sai automaticamente pelo WhatsApp conectado por QR Code, direto para o número deste cliente."
              : "O WhatsApp não está conectado agora. Você pode montar a mensagem, mas o envio só acontece com o WhatsApp conectado (aba WhatsApp)."}
          </p>
        </div>

        <div className="mt-4">
          <label htmlFor="send-template" className={labelCls}>Template</label>
          <select
            id="send-template"
            className={inputCls}
            value={templateKey}
            onChange={(e) => {
              setTemplateKey(e.target.value as SendTemplateKey);
              setResult(null);
            }}
          >
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[var(--dim)]">
            Os textos são os modelos da aba Mensagens (Integrações → Mensagens), que você pode editar lá.
          </p>
        </div>

        <div className="mt-4">
          <p className={labelCls}>Mensagem pronta</p>
          <div className="whitespace-pre-wrap rounded-lg bg-[var(--surface2)] p-3 text-sm" aria-label="Prévia da mensagem">
            {previewParts.map((part, i) => (
              <span key={i}>
                {part}
                {i < previewParts.length - 1 && (
                  <a href={url} target="_blank" rel="noreferrer" className="break-all font-semibold text-[var(--accent-bright)] underline">
                    {url}
                  </a>
                )}
              </span>
            ))}
          </div>
        </div>

        {result && (
          <p
            className={`mt-4 rounded-lg p-3 text-sm font-semibold ${result.sent ? "bg-[var(--card-green-bg)] text-[var(--card-green)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}
            role="status"
          >
            {result.sent
              ? `Enviado ✓ A mensagem foi enviada pelo WhatsApp conectado para ${client.whatsapp}.`
              : `Não enviado: ${result.detail}`}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className={`${btnPrimary} flex-1 py-3 text-center`}
            disabled={send.isPending || !client.whatsapp}
            onClick={() => {
              setResult(null);
              send.mutate();
            }}
          >
            {send.isPending ? "Enviando…" : "Enviar"}
          </button>
          <button type="button" className={`${btnGhost} py-3`} onClick={onClose}>
            Cancelar
          </button>
        </div>
        {!client.whatsapp && (
          <p className="mt-2 text-sm text-[var(--warn)]">
            Cadastre o número de WhatsApp deste cliente (Editar) para poder enviar.
          </p>
        )}
      </div>
    </div>
  );
}

function ClientForm({
  data,
  initial,
  onDone,
}: {
  data: State;
  initial: Client | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [whatsapp, setWhatsapp] = useState(initial?.whatsapp ?? "");
  const [iptvUser, setIptvUser] = useState(initial?.iptvUser ?? "");
  const [iptvPass, setIptvPass] = useState("");
  const [serverId, setServerId] = useState<string>(initial?.serverId ? String(initial.serverId) : "");
  const [planId, setPlanId] = useState<string>(initial?.planId ? String(initial.planId) : "");
  const [priceText, setPriceText] = useState(
    initial?.priceOverrideCents != null ? (initial.priceOverrideCents / 100).toFixed(2).replace(".", ",") : "",
  );
  const [expires, setExpires] = useState(
    initial ? dateInputValue(initial.expiresAt) : dateInputValue(todayPlusDays(30)),
  );
  const [status, setStatus] = useState(initial?.status ?? "ativo");
  const [isTest, setIsTest] = useState(initial?.isTest ?? false);
  const [referredBy, setReferredBy] = useState(initial?.referredBy ?? "");
  const [app, setApp] = useState(initial?.app ?? "");
  const [device, setDevice] = useState(initial?.device ?? "");
  const [screensText, setScreensText] = useState(initial?.screens != null ? String(initial.screens) : "");
  const [source, setSource] = useState(initial?.source ?? "");
  const [extraPanel, setExtraPanel] = useState(initial?.extraPanel ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.saveClient({
        id: initial?.id,
        name: name.trim(),
        whatsapp: whatsapp.trim(),
        iptvUser: iptvUser.trim(),
        iptvPass,
        serverId: serverId ? Number(serverId) : null,
        planId: planId ? Number(planId) : null,
        priceOverrideCents: priceText.trim() ? parseBRL(priceText) : null,
        expiresAt: new Date(`${expires}T12:00:00`).toISOString(),
        status: status === "pausado" ? "pausado" : "ativo",
        isTest,
        referredBy: referredBy.trim(),
        app: app.trim(),
        device: device.trim(),
        screens: screensText.trim() ? Number(screensText) : null,
        source: source.trim(),
        extraPanel: extraPanel.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      onDone();
    },
    onError: (e) => setError(String(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (priceText.trim() && parseBRL(priceText) == null) {
      setError("Valor do cliente inválido. Use o formato 30,00.");
      return;
    }
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label={initial ? "Editar cliente" : "Adicionar cliente"}>
      <div>
        <label htmlFor="c-name" className={labelCls}>Nome do cliente</label>
        <input id="c-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <label htmlFor="c-whatsapp" className={labelCls}>WhatsApp do cliente</label>
        <input
          id="c-whatsapp"
          className={inputCls}
          value={whatsapp}
          onChange={(e) => setWhatsapp(e.target.value)}
          placeholder="Ex.: 11 99999-9999 ou 5511999999999"
          inputMode="tel"
          autoComplete="tel"
        />
        <p className="mt-1 text-sm text-[var(--dim)]">
          Este número recebe os avisos de vencimento, expiração e a confirmação de renovação.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="c-user" className={labelCls}>Usuário IPTV (do painel)</label>
          <input id="c-user" className={inputCls} value={iptvUser} onChange={(e) => setIptvUser(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="c-pass" className={labelCls}>{initial ? "Nova senha IPTV (em branco mantém a atual)" : "Senha IPTV (do painel)"}</label>
          <input id="c-pass" className={inputCls} value={iptvPass} onChange={(e) => setIptvPass(e.target.value)} required={!initial} placeholder={initial ? "••••••" : ""} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="c-server" className={labelCls}>Servidor</label>
          <select id="c-server" className={inputCls} value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">Selecione…</option>
            {data.servers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.panelConnected ? " (conectado)" : " (não conectado)"}</option>
            ))}
          </select>
          <p className="mt-1 text-sm text-[var(--dim)]">O usuário e a senha IPTV acima são os deste cliente neste servidor — é esse usuário exato que a renovação estende no painel.</p>
        </div>
        <div>
          <label htmlFor="c-plan" className={labelCls}>Plano</label>
          <select id="c-plan" className={inputCls} value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Selecione…</option>
            {data.plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {p.days} dias — {brl(p.priceCents)}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="c-price" className={labelCls}>Valor próprio (opcional)</label>
          <input id="c-price" className={inputCls} value={priceText} onChange={(e) => setPriceText(e.target.value)} placeholder="Em branco = valor do plano" inputMode="decimal" />
        </div>
        <div>
          <label htmlFor="c-exp" className={labelCls}>Data de vencimento</label>
          <input id="c-exp" type="date" className={inputCls} value={expires} onChange={(e) => setExpires(e.target.value)} required />
        </div>
      </div>
      <div>
        <label htmlFor="c-status" className={labelCls}>Status</label>
        <select id="c-status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ativo">Ativo</option>
          <option value="pausado">Pausado</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="c-app" className={labelCls}>Aplicativo (opcional)</label>
          <input id="c-app" className={inputCls} value={app} onChange={(e) => setApp(e.target.value)} placeholder="Ex.: XCIPTV, IBO, Smarters" autoComplete="off" />
        </div>
        <div>
          <label htmlFor="c-device" className={labelCls}>Dispositivo (opcional)</label>
          <input id="c-device" className={inputCls} value={device} onChange={(e) => setDevice(e.target.value)} placeholder="Ex.: TV Samsung, Firestick, Celular" autoComplete="off" />
        </div>
        <div>
          <label htmlFor="c-screens" className={labelCls}>Telas (opcional)</label>
          <input id="c-screens" type="number" min={1} max={99} className={inputCls} value={screensText} onChange={(e) => setScreensText(e.target.value)} placeholder="Ex.: 1" inputMode="numeric" />
        </div>
        <div>
          <label htmlFor="c-source" className={labelCls}>Captação — como chegou (opcional)</label>
          <input id="c-source" className={inputCls} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Ex.: Indicação, Instagram, WhatsApp" autoComplete="off" />
        </div>
      </div>
      <div>
        <label htmlFor="c-extra" className={labelCls}>Painel extra (opcional)</label>
        <input id="c-extra" className={inputCls} value={extraPanel} onChange={(e) => setExtraPanel(e.target.value)} placeholder="Nome de um segundo painel deste cliente, se tiver" autoComplete="off" />
      </div>
      <div>
        <label htmlFor="c-referred" className={labelCls}>Quem indicou este cliente (opcional)</label>
        <input
          id="c-referred"
          className={inputCls}
          value={referredBy}
          onChange={(e) => setReferredBy(e.target.value)}
          placeholder="Nome de quem indicou — aparece na aba Indicação de Clientes"
          list="client-names-list"
          autoComplete="off"
        />
        <datalist id="client-names-list">
          {data.clients
            .filter((c) => c.id !== initial?.id)
            .map((c) => (
              <option key={c.id} value={c.name} />
            ))}
        </datalist>
      </div>
      <label className="flex items-start gap-3 rounded-lg bg-[var(--surface2)] p-3">
        <input
          type="checkbox"
          checked={isTest}
          onChange={(e) => setIsTest(e.target.checked)}
          className="mt-1 h-5 w-5"
          aria-label="Cliente de teste"
        />
        <span>
          <span className="block font-semibold">Cliente de teste</span>
          <span className="block text-sm text-[var(--dim)]">
            Marque para contas de teste (suas ou de demonstração): elas ficam fora dos cartões do Dashboard
            e aparecem na aba Testes, onde as cobranças são só de validação e não consomem crédito.
          </span>
        </span>
      </label>
      <p className="text-sm text-[var(--dim)]">
        É o usuário e a senha exatos deste cliente no painel que valem para a
        renovação: ao confirmar o pagamento, só essa conta é renovada.
      </p>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      <button type="submit" className={btnPrimary} disabled={save.isPending}>
        {save.isPending ? "Salvando…" : initial ? "Salvar alterações" : "Adicionar cliente"}
      </button>
    </form>
  );
}

/* ---------------- Planos ---------------- */

function PlansTab({ data, onNavigate }: { data: State; onNavigate: (tab: Tab) => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [view, setView] = useState<"lista" | "checkout">("lista");
  const [planSearch, setPlanSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<"todos" | "com_clientes" | "sem_clientes">("todos");
  const del = useMutation({
    mutationFn: (id: number) => api.deletePlan({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const activeClientsOf = (planId: number) =>
    data.clients.filter(
      (c) =>
        c.planId === planId &&
        c.listState === "normal" &&
        !c.isTest &&
        c.status === "ativo" &&
        daysLeft(c.expiresAt) >= 0,
    ).length;

  const activeClientsTotal = data.clients.filter(
    (c) => c.listState === "normal" && !c.isTest && c.status === "ativo" && daysLeft(c.expiresAt) >= 0,
  ).length;

  const pq = planSearch.trim().toLowerCase();
  const visiblePlans = data.plans.filter((p) => {
    if (pq && !p.name.toLowerCase().includes(pq)) return false;
    if (planFilter === "com_clientes" && activeClientsOf(p.id) === 0) return false;
    if (planFilter === "sem_clientes" && activeClientsOf(p.id) > 0) return false;
    return true;
  });

  const durationLabel = (days: number) =>
    days === 30 ? "1 mês" : days % 30 === 0 ? `${days / 30} meses` : `${days} dias`;

  const theme = INVOICE_THEMES[data.invoiceColor] ?? INVOICE_THEMES.verde!;

  const statCards = [
    { label: "Total de Planos", count: data.plans.length, hint: "planos cadastrados por você", color: "var(--accent-bright)" },
    { label: "Planos Ativos", count: data.plans.length, hint: "todos disponíveis para os clientes", color: "var(--card-green)" },
    { label: "Clientes Ativos", count: activeClientsTotal, hint: "assinaturas dentro do prazo", color: "var(--card-blue)" },
  ];

  return (
    <section aria-label="Planos" className="mt-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Planos de Clientes</h2>
        <p className="mt-0.5 text-sm text-[var(--dim)]">Gerencie os planos disponíveis para seus clientes</p>
      </div>

      <div className="mt-4 inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1" role="group" aria-label="Visão dos planos">
        <button
          type="button"
          aria-pressed={view === "lista"}
          onClick={() => setView("lista")}
          className={view === "lista" ? "rounded-lg bg-[var(--surface2)] px-4 py-2 font-semibold text-[var(--text)]" : "rounded-lg px-4 py-2 font-medium text-[var(--dim)]"}
        >
          Lista de planos
        </button>
        <button
          type="button"
          aria-pressed={view === "checkout"}
          onClick={() => setView("checkout")}
          className={view === "checkout" ? "rounded-lg bg-[var(--surface2)] px-4 py-2 font-semibold text-[var(--text)]" : "rounded-lg px-4 py-2 font-medium text-[var(--dim)]"}
        >
          Checkout
        </button>
      </div>

      {view === "checkout" ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-display text-lg font-bold">Como fica a página de pagamento do cliente</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">
              É esta página que o cliente abre pelo link da fatura: ele vê o plano, o valor
              e gera o Pix no Mercado Pago — o único meio de pagamento do gestor.
            </p>
            <dl className="mt-4 space-y-3 text-base">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-[var(--dim)]">Título da fatura</dt>
                <dd className="font-semibold">{data.invoiceTitle}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-[var(--dim)]">Mensagem da fatura</dt>
                <dd className="max-w-md text-right font-medium">{data.invoiceMessage}</dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-[var(--dim)]">Cor da fatura</dt>
                <dd className="flex items-center gap-2 font-semibold">
                  <span className="inline-block h-5 w-5 rounded-full border border-[var(--border)]" style={{ background: theme.main }} aria-hidden="true" />
                  {theme.label}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-[var(--dim)]">Mercado Pago</dt>
                <dd className="font-semibold">
                  {data.mpVerified ? "conectado — a fatura gera Pix de verdade" : "ainda não testado — a fatura não gera Pix até conectar"}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-[var(--dim)]">Modo ao vivo</dt>
                <dd className="font-semibold">{data.liveMode ? "ligado" : "desligado"}</dd>
              </div>
            </dl>
            <button type="button" className={btnGhost} onClick={() => onNavigate("integracoes")}>
              Editar textos, cor e pagamento em Integrações
            </button>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-display text-lg font-bold">Valores que o cliente vê no checkout</h3>
            {data.plans.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Nenhum plano cadastrado ainda — sem plano, a fatura do cliente não tem valor para cobrar.
                Volte em “Lista de planos” e toque em Novo Plano para criar o primeiro.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--border)]">
                {data.plans.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-sm text-[var(--dim)]">
                      {durationLabel(p.days)} • {p.credits} crédito{p.credits > 1 ? "s" : ""}
                    </span>
                    <span className="font-display text-lg font-extrabold text-[var(--accent-bright)]">{brl(p.priceCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {statCards.map((card) => (
              <div key={card.label} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="text-sm font-semibold text-[var(--dim)]">{card.label}</p>
                <p className="mt-1 font-display text-3xl font-extrabold leading-none" style={{ color: card.color }}>
                  {card.count}
                </p>
                <p className="mt-1.5 text-xs text-[var(--dim)]">{card.hint}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="min-w-52 flex-1">
              <label htmlFor="plans-search" className="sr-only">Buscar plano</label>
              <input
                id="plans-search"
                className={inputCls}
                value={planSearch}
                onChange={(e) => setPlanSearch(e.target.value)}
                placeholder="Buscar plano..."
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="plans-filter" className="sr-only">Filtrar planos</label>
              <select
                id="plans-filter"
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-medium text-[var(--text)]"
                value={planFilter}
                onChange={(e) => setPlanFilter(e.target.value as "todos" | "com_clientes" | "sem_clientes")}
              >
                <option value="todos">Todos</option>
                <option value="com_clientes">Com clientes ativos</option>
                <option value="sem_clientes">Sem clientes ativos</option>
              </select>
            </div>
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                setEditing(null);
                setShowForm((v) => !v);
              }}
            >
              {showForm && !editing ? "Fechar" : "+ Novo Plano"}
            </button>
          </div>

          <p className="mt-3 text-sm text-[var(--dim)]">
            Regra do painel: <strong className="text-[var(--text)]">1 crédito = 30 dias</strong>. Os créditos são
            calculados automaticamente (dias ÷ 30). Ao mudar o valor de um plano, a
            página da fatura dos clientes desse plano já mostra o valor novo.
          </p>

          {showForm && (
            <PlanForm
              initial={editing}
              onDone={() => {
                setShowForm(false);
                setEditing(null);
              }}
            />
          )}

          {data.plans.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
              <p className="font-display text-lg font-bold">Nenhum plano cadastrado ainda</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-[var(--dim)]">
                Crie o primeiro plano com nome, duração em dias e valor. Depois é só
                vincular o plano aos clientes no cadastro deles.
              </p>
              <button
                type="button"
                className={`${btnPrimary} mt-4`}
                onClick={() => {
                  setEditing(null);
                  setShowForm(true);
                }}
              >
                + Novo Plano
              </button>
            </div>
          ) : visiblePlans.length === 0 ? (
            <p className="mt-6 text-center text-[var(--dim)]">
              Nenhum plano bate com esta busca ou filtro. Limpe a busca ou troque o filtro para ver todos os planos.
            </p>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visiblePlans.map((p) => {
                const clientsCount = activeClientsOf(p.id);
                return (
                  <li key={p.id} className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-display text-lg font-bold">{p.name}</p>
                      <span className="rounded-full bg-[var(--ok-bg)] px-2.5 py-0.5 text-xs font-bold text-[var(--card-green)]">Ativo</span>
                    </div>
                    <p className="mt-2 text-sm text-[var(--dim)]">
                      {durationLabel(p.days)} <span className="text-[var(--accent-bright)]">• {p.credits} crédito{p.credits > 1 ? "s" : ""}</span>{" "}
                      <span className="text-[var(--accent-bright)]">• Vencimento fixo</span>
                    </p>
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      {p.days} dias por renovação
                    </p>
                    <p className="mt-2 font-display text-2xl font-extrabold text-[var(--accent-bright)]">{brl(p.priceCents)}</p>
                    <p className="mt-3 rounded-lg bg-[var(--surface2)] px-3 py-2 text-sm text-[var(--dim)]">
                      {clientsCount} cliente{clientsCount === 1 ? "" : "s"} ativo{clientsCount === 1 ? "" : "s"}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2.5 font-semibold"
                        onClick={() => {
                          setEditing(p);
                          setShowForm(true);
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] p-2.5 text-[var(--danger)]"
                        aria-label={`Excluir plano ${p.name}`}
                        onClick={() => del.mutate(p.id)}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M6.5 7l1 13h9l1-13" />
                        </svg>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function PlanForm({ initial, onDone }: { initial: Plan | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [days, setDays] = useState(initial ? String(initial.days) : "30");
  const [priceText, setPriceText] = useState(
    initial ? (initial.priceCents / 100).toFixed(2).replace(".", ",") : "",
  );
  const [error, setError] = useState<string | null>(null);
  const daysNum = Number(days);
  const credits = Number.isFinite(daysNum) && daysNum > 0 ? Math.round(daysNum / 30) : 0;

  const save = useMutation({
    mutationFn: () =>
      api.savePlan({ id: initial?.id, name: name.trim(), days: daysNum, priceCents: parseBRL(priceText) ?? -1 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      onDone();
    },
    onError: (e) => setError(String(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!Number.isFinite(daysNum) || daysNum <= 0 || daysNum % 30 !== 0) {
      setError("Os dias precisam ser múltiplos de 30 (30, 60, 90...), porque 1 crédito vale 30 dias.");
      return;
    }
    if (parseBRL(priceText) == null) {
      setError("Valor inválido. Use o formato 30,00.");
      return;
    }
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label={initial ? "Editar plano" : "Adicionar plano"}>
      <div>
        <label htmlFor="p-name" className={labelCls}>Nome do plano</label>
        <input id="p-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ex.: Mensal, Bimestral, Trimestral" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="p-days" className={labelCls}>Dias</label>
          <input id="p-days" type="number" min={30} step={30} className={inputCls} value={days} onChange={(e) => setDays(e.target.value)} required />
          <p className="mt-1 text-sm text-[var(--dim)]">= {credits} crédito{credits === 1 ? "" : "s"} no painel</p>
        </div>
        <div>
          <label htmlFor="p-price" className={labelCls}>Valor (R$)</label>
          <input id="p-price" className={inputCls} value={priceText} onChange={(e) => setPriceText(e.target.value)} required placeholder="30,00" inputMode="decimal" />
        </div>
      </div>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      <button type="submit" className={btnPrimary} disabled={save.isPending}>
        {save.isPending ? "Salvando…" : initial ? "Salvar alterações" : "Adicionar plano"}
      </button>
    </form>
  );
}

function PanelDiagnosticView({ diagnostic }: { diagnostic: PanelDiagnostic | null }) {
  if (!diagnostic) return null;
  return (
    <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3" aria-label="Diagnóstico do teste de conexão do painel">
      <p className="text-sm font-bold">Diagnóstico do último teste</p>
      <p className="mt-1 text-sm">{diagnostic.headline}</p>
      <dl className="mt-3 space-y-1 text-sm">
        <div>
          <dt className="font-semibold">Endereço chamado</dt>
          <dd className="break-all font-mono text-xs">{diagnostic.endpoint || "não chamado — confira a base/token"}</dd>
        </div>
        <div>
          <dt className="font-semibold">Base salva → base usada</dt>
          <dd className="break-all font-mono text-xs">{diagnostic.baseOriginal || "(vazia)"} → {diagnostic.baseNormalized || "(inválida)"}</dd>
        </div>
        {diagnostic.winningVariant && (
          <div>
            <dt className="font-semibold">Variação que passou</dt>
            <dd>{diagnostic.winningVariant}</dd>
          </div>
        )}
      </dl>

      {diagnostic.baseWarnings.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-semibold">Conferência da base</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--dim)]">
            {diagnostic.baseWarnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      )}

      {diagnostic.responseBody && (
        <div className="mt-3">
          <p className="text-sm font-semibold">Mensagem exata devolvida pela API (token escondido)</p>
          <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface2)] p-3 font-mono text-xs">{diagnostic.responseBody}</pre>
        </div>
      )}

      {diagnostic.attempts.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-semibold">Variações testadas, uma de cada vez</p>
          <ul className="mt-2 space-y-2">
            {diagnostic.attempts.map((attempt) => (
              <li key={attempt.id} className="rounded-lg bg-[var(--surface2)] p-3 text-sm">
                <p className="font-semibold">
                  {attempt.success ? "✅" : "•"} {attempt.label} — {attempt.httpStatus != null ? `HTTP ${attempt.httpStatus}` : "sem resposta"}
                </p>
                <p className="mt-1 text-[var(--dim)]">{attempt.description}</p>
                {attempt.error && <p className="mt-1">Erro informado: {attempt.error}</p>}
                {attempt.responseBody && (
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface)] p-2 font-mono text-xs">{attempt.responseBody}</pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diagnostic.steps.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-semibold">O que conferir, em linguagem simples</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-[var(--dim)]">
            {diagnostic.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--dim)]">
        Teste feito em {new Date(diagnostic.testedAt).toLocaleString("pt-BR")}. Este teste só autentica: ele não renova cliente e não consome crédito.
      </p>
    </div>
  );
}

/* ---------------- Servidores ---------------- */

function SwitchToggle({
  label,
  checked,
  onToggle,
  disabled,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-[var(--accent)]" : "border border-[var(--border)] bg-[var(--surface2)]"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow ${checked ? "right-0.5" : "left-0.5"}`}
        aria-hidden="true"
      />
    </button>
  );
}

function ServersTab({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [modalServer, setModalServer] = useState<Server | null | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [rechargeFor, setRechargeFor] = useState<number | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [rechargeNote, setRechargeNote] = useState("");
  const [rechargeMsg, setRechargeMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<number, PanelTestResult>>({});
  const [testErrors, setTestErrors] = useState<Record<number, string>>({});
  const [extendMsgs, setExtendMsgs] = useState<Record<number, string>>({});
  const [extendClient, setExtendClient] = useState<Record<number, string>>({});
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteServer({ id }),
    onSuccess: invalidate,
  });
  const [connMsgs, setConnMsgs] = useState<Record<number, string>>({});
  const testConn = useMutation({
    mutationFn: (id: number) => api.testServerConnection({ serverId: id }),
    onSuccess: (r, id) => {
      setConnMsgs((prev) => ({ ...prev, [id]: r.detail }));
      invalidate();
    },
    onError: (e, id) => setConnMsgs((prev) => ({ ...prev, [id]: String(e) })),
  });
  const testApi = useMutation({
    mutationFn: (id: number) => api.testPanelApi({ serverId: id }),
    onSuccess: (r, id) => {
      setTestResults((prev) => ({ ...prev, [id]: r }));
      setTestErrors((prev) => ({ ...prev, [id]: "" }));
      invalidate();
    },
    onError: (e, id) => setTestErrors((prev) => ({ ...prev, [id]: String(e) })),
  });
  const testExtend = useMutation({
    mutationFn: (args: { serverId: number; clientId: number }) => api.testPanelExtend(args),
    onSuccess: (r, args) => {
      setExtendMsgs((prev) => ({ ...prev, [args.serverId]: r.detail }));
      invalidate();
    },
    onError: (e, args) => setExtendMsgs((prev) => ({ ...prev, [args.serverId]: String(e) })),
  });
  const setActive = useMutation({
    mutationFn: (args: { id: number; active: boolean }) => api.setServerActive(args),
    onSuccess: invalidate,
  });
  const addCredits = useMutation({
    mutationFn: (args: { serverId: number; amount: number; note: string }) => api.addServerCredits(args),
    onSuccess: (r) => {
      setRechargeMsg(`Recarga feita. Novo saldo: ${r.creditsBalance} créditos.`);
      setRechargeAmount("");
      setRechargeNote("");
      invalidate();
    },
    onError: (e) => setRechargeMsg(String(e)),
  });

  const q = search.trim().toLowerCase();
  const visible = data.servers.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.identifier ?? "").toLowerCase().includes(q),
  );
  const totalCredits = data.servers.reduce((sum, s) => sum + s.creditsBalance, 0);
  const clientsOf = (serverId: number) => data.clients.filter((c) => c.serverId === serverId).length;
  const integrationName = (s: Server) =>
    s.panelIntegrationId != null
      ? (data.integrations.find((i) => i.id === s.panelIntegrationId)?.name ?? "Integração removida")
      : null;

  function autoRenewInfo(s: Server): { label: string; ok: boolean } {
    if (!s.autoRenewEnabled) return { label: "Renovação automática desligada", ok: false };
    if (s.integrationMode === "nenhuma") return { label: "Renovação automática pendente — sem integração", ok: false };
    if (s.integrationMode === "vinculada" && s.panelIntegrationId == null)
      return { label: "Renovação automática pendente — vínculo faltando", ok: false };
    if (!s.apiVerified) return { label: "Renovação automática pendente — teste da API não passou", ok: false };
    if (!s.extendVerified) return { label: "Renovação automática pendente — extensão não testada", ok: false };
    return { label: "Renovação automática ativa e verificada", ok: true };
  }

  return (
    <section aria-label="Servidores" className="mt-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Servidores</h2>
        <p className="mt-0.5 text-sm text-[var(--dim)]">Gerencie seus servidores e créditos</p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-display text-3xl font-extrabold">{data.servers.length}</p>
          <p className="mt-0.5 text-sm text-[var(--dim)]">Servidores</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-display text-3xl font-extrabold">{totalCredits}</p>
          <p className="mt-0.5 text-sm text-[var(--dim)]">Créditos no total</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-display text-3xl font-extrabold">{data.clients.length}</p>
          <p className="mt-0.5 text-sm text-[var(--dim)]">Clientes cadastrados</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="min-w-52 flex-1">
          <label htmlFor="servers-search" className="sr-only">Buscar por nome ou identificador</label>
          <input
            id="servers-search"
            className={inputCls}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou identificador…"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className={btnGhost}
          aria-pressed={showLogs}
          onClick={() => setShowLogs((v) => !v)}
        >
          Transações
        </button>
        <button
          type="button"
          className="rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)]"
          onClick={() => setModalServer(null)}
        >
          + Novo Servidor
        </button>
      </div>

      {showLogs && (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Transações de créditos dos servidores">
          <h3 className="font-display font-bold">Transações de créditos</h3>
          {data.creditLogs.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Nenhuma movimentação ainda. Recargas e consumos de renovação aparecem aqui.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--border)]">
              {data.creditLogs.map((l) => (
                <li key={l.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                  <span>
                    <strong className={l.delta >= 0 ? "text-[var(--card-green)]" : "text-[var(--card-red)]"}>
                      {l.delta >= 0 ? "+" : ""}{l.delta}
                    </strong>{" "}
                    — {l.note} <span className="text-[var(--dim)]">({l.serverName})</span>
                  </span>
                  <span className="text-[var(--dim)]">
                    saldo: {l.balanceAfter} • {new Date(l.createdAt).toLocaleString("pt-BR")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {visible.map((s) => {
          const renew = autoRenewInfo(s);
          const linkedName = integrationName(s);
          return (
            <article
              key={s.id}
              className={`rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${s.active ? "border-l-4 border-l-[var(--accent)]" : "opacity-75"}`}
              aria-label={`Servidor ${s.name}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-display text-lg font-bold">
                    {s.name}
                    {s.identifier && (
                      <span className="ml-2 rounded-md bg-[var(--surface2)] px-2 py-0.5 align-middle font-mono text-xs font-semibold text-[var(--accent-bright)]">
                        {s.identifier}
                      </span>
                    )}
                  </p>
                  {s.panelUrl ? (
                    <a href={s.panelUrl} target="_blank" rel="noreferrer" className="break-all font-mono text-sm text-[var(--accent-bright)] underline">
                      {s.panelUrl}
                    </a>
                  ) : (
                    <p className="text-sm text-[var(--dim)]">Sem link de painel</p>
                  )}
                  <p className="font-mono text-sm text-[var(--dim)]">
                    usuário do painel: {s.panelUser || "—"} • senha: {s.hasPass ? "•••••• (guardada no gestor)" : "não cadastrada"}
                  </p>
                </div>
                <SwitchToggle
                  label={`Servidor ${s.name} ativo`}
                  checked={s.active}
                  disabled={setActive.isPending}
                  onToggle={() => setActive.mutate({ id: s.id, active: !s.active })}
                />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-[var(--surface2)] p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Créditos</p>
                  <p className="mt-0.5 font-display text-2xl font-extrabold">{s.creditsBalance}</p>
                  <button
                    type="button"
                    className="mt-1 text-sm font-semibold text-[var(--accent-bright)] underline"
                    aria-label={`Recarregar créditos do servidor ${s.name}`}
                    onClick={() => {
                      setRechargeFor(rechargeFor === s.id ? null : s.id);
                      setRechargeMsg(null);
                    }}
                  >
                    Recarregar
                  </button>
                </div>
                <div className="rounded-xl bg-[var(--surface2)] p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Clientes</p>
                  <p className="mt-0.5 font-display text-2xl font-extrabold">{clientsOf(s.id)}</p>
                </div>
                <div className="rounded-xl bg-[var(--surface2)] p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">Custo/créd.</p>
                  <p className="mt-0.5 font-display text-2xl font-extrabold">{brl(s.costPerCreditCents)}</p>
                  {s.chargeByScreens && <p className="text-xs text-[var(--dim)]">cobrança por telas</p>}
                </div>
              </div>

              {rechargeFor === s.id && (
                <form
                  className="mt-3 flex flex-wrap items-end gap-2 rounded-xl bg-[var(--surface2)] p-3"
                  aria-label={`Recarregar créditos de ${s.name}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const amount = Number(rechargeAmount);
                    if (!Number.isInteger(amount) || amount <= 0) {
                      setRechargeMsg("Informe uma quantidade de créditos maior que zero.");
                      return;
                    }
                    addCredits.mutate({ serverId: s.id, amount, note: rechargeNote.trim() });
                  }}
                >
                  <div>
                    <label htmlFor={`recharge-amount-${s.id}`} className={labelCls}>Créditos a adicionar</label>
                    <input
                      id={`recharge-amount-${s.id}`}
                      type="number"
                      min={1}
                      className="w-36 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base"
                      value={rechargeAmount}
                      onChange={(e) => setRechargeAmount(e.target.value)}
                      required
                    />
                  </div>
                  <div className="min-w-44 flex-1">
                    <label htmlFor={`recharge-note-${s.id}`} className={labelCls}>Observação (opcional)</label>
                    <input
                      id={`recharge-note-${s.id}`}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base"
                      value={rechargeNote}
                      onChange={(e) => setRechargeNote(e.target.value)}
                      placeholder="Ex.: compra de créditos"
                    />
                  </div>
                  <button type="submit" className={btnPrimary} disabled={addCredits.isPending}>
                    {addCredits.isPending ? "Recarregando…" : "Confirmar recarga"}
                  </button>
                  {rechargeMsg && <p className="w-full text-sm font-medium">{rechargeMsg}</p>}
                </form>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5" aria-label={`Status do servidor ${s.name}`}>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${s.panelConnected ? "bg-[var(--ok-bg)] text-[var(--card-green)]" : "bg-[var(--danger-bg)] text-[var(--danger)]"}`}>
                  {s.panelConnected ? "● Conectado" : "● Não conectado"}
                </span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${s.apiVerified ? "bg-[var(--ok-bg)] text-[var(--card-green)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}>
                  API do painel: {s.apiVerified ? "conectada" : "não conectada"}
                </span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${renew.ok ? "bg-[var(--ok-bg)] text-[var(--card-green)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}>
                  {renew.label}
                </span>
                {linkedName && (
                  <span className="rounded-full bg-[var(--card-blue-bg)] px-2.5 py-1 text-xs font-bold text-[var(--card-blue)]">
                    Integração: {linkedName}
                  </span>
                )}
                {s.sendVia === "whatsapp" && (
                  <span className="rounded-full bg-[var(--surface2)] px-2.5 py-1 text-xs font-bold text-[var(--dim)]">
                    Mensagens pelo WhatsApp conectado
                  </span>
                )}
              </div>
              {(connMsgs[s.id] || s.panelConnectionDetail) && (
                <p className="mt-2 text-sm text-[var(--dim)]" role="status">
                  {connMsgs[s.id] || s.panelConnectionDetail}
                  {s.panelConnectionTestedAt && !connMsgs[s.id]
                    ? ` Testado em ${new Date(s.panelConnectionTestedAt).toLocaleString("pt-BR")}.`
                    : ""}
                </p>
              )}
              {s.notes && <p className="mt-2 text-sm text-[var(--dim)]">{s.notes}</p>}
              {(s.appName || s.serverUrl) && (
                <p className="mt-1 text-sm text-[var(--dim)]">
                  {s.appName ? `Aplicativo: ${s.appName}` : ""}
                  {s.appName && s.serverUrl ? " • " : ""}
                  {s.serverUrl ? `URL: ${s.serverUrl}` : ""}
                </p>
              )}

              <div className="mt-3 rounded-xl bg-[var(--surface2)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold">API do painel — teste e extensão</p>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={testApi.isPending}
                    onClick={() => testApi.mutate(s.id)}
                    aria-label={`Testar conexão da API do painel de ${s.name}`}
                  >
                    {testApi.isPending ? "Testando variações…" : "Testar conexão"}
                  </button>
                </div>
                <p className="mt-1 break-all font-mono text-sm">base da API: {s.apiBase || "não cadastrada"}</p>
                <p className="text-sm text-[var(--dim)]">
                  token da API: {s.hasApiToken ? "salvo no gestor (não exibido)" : "não salvo"}
                  {s.apiStatusDetail ? ` — ${s.apiStatusDetail}` : ""}
                </p>
                {testErrors[s.id] && <p className="mt-1 text-sm font-medium text-[var(--danger)]">{testErrors[s.id]}</p>}
                <PanelDiagnosticView diagnostic={testResults[s.id]?.diagnostic ?? s.apiDiagnostic} />
                <div className="mt-3 border-t border-[var(--border)] pt-3">
                  <p className="text-sm font-bold">
                    Teste de extensão real ([+] Estender) — {s.extendVerified ? "verificado" : "pendente"}
                  </p>
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    Chamada: <span className="font-mono text-xs">{s.extendMethod} {s.extendPath}</span>. O teste renova de verdade e consome os créditos do plano do cliente escolhido.
                    {s.extendStatusDetail ? ` ${s.extendStatusDetail}` : ""}
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <div>
                      <label htmlFor={`extend-client-${s.id}`} className={labelCls}>Cliente para o teste de extensão</label>
                      <select
                        id={`extend-client-${s.id}`}
                        className={inputCls}
                        value={extendClient[s.id] ?? ""}
                        onChange={(e) => setExtendClient((prev) => ({ ...prev, [s.id]: e.target.value }))}
                      >
                        <option value="">Selecione um cliente…</option>
                        {data.clients
                          .filter((c) => c.planId != null && (c.serverId == null || c.serverId === s.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.iptvUser}) — {c.planName} — {c.planDays} dias = {c.planCredits} crédito(s)
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        className={btnPrimary}
                        disabled={!s.apiVerified || !extendClient[s.id] || testExtend.isPending}
                        onClick={() => testExtend.mutate({ serverId: s.id, clientId: Number(extendClient[s.id]) })}
                        aria-label={`Testar extensão real no painel para o servidor ${s.name}`}
                      >
                        {testExtend.isPending ? "Estendendo…" : "Testar extensão"}
                      </button>
                    </div>
                  </div>
                  {!s.apiVerified && (
                    <p className="mt-1 text-sm text-[var(--dim)]">Primeiro deixe o teste de conexão da API passar — só então o teste de extensão é liberado.</p>
                  )}
                  {extendMsgs[s.id] && <p className="mt-1 text-sm font-medium">{extendMsgs[s.id]}</p>}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={btnPrimary} onClick={() => setModalServer(s)}>
                  Editar
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={testConn.isPending}
                  aria-label={`Testar conexão do servidor ${s.name} com link, usuário e senha salvos`}
                  onClick={() => testConn.mutate(s.id)}
                >
                  {testConn.isPending ? "Testando…" : "Testar conexão"}
                </button>
                <button type="button" className={btnGhost} aria-label={`Excluir servidor ${s.name}`} onClick={() => del.mutate(s.id)}>
                  Excluir
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {visible.length === 0 && (
        <p className="mt-6 text-center text-[var(--dim)]">
          {data.servers.length === 0
            ? "Nenhum servidor ainda. Toque em “+ Novo Servidor” para adicionar o seu."
            : "Nenhum servidor combina com a busca."}
        </p>
      )}

      {modalServer !== undefined && (
        <ServerModal
          data={data}
          initial={modalServer}
          onDone={() => setModalServer(undefined)}
        />
      )}
    </section>
  );
}

function ServerModal({
  data,
  initial,
  onDone,
}: {
  data: State;
  initial: Server | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  // Formulário principal SIMPLES: só link do painel, usuário e senha —
  // igual ao gestor que a dona usa. Nome, créditos, custo, integração,
  // API, App, URLs e PIX ficam em "Opções avançadas" (fechado, opcional)
  // e vão com valores padrão quando ninguém abre essa parte.
  const [panelUrl, setPanelUrl] = useState(initial?.panelUrl ?? "");
  const [panelUser, setPanelUser] = useState(initial?.panelUser ?? "");
  const [panelPass, setPanelPass] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [identifier, setIdentifier] = useState(initial?.identifier ?? "");
  const [initialCredits, setInitialCredits] = useState("0");
  const [costText, setCostText] = useState(
    initial ? (initial.costPerCreditCents / 100).toFixed(2).replace(".", ",") : "0,00",
  );
  const [chargeByScreens, setChargeByScreens] = useState(initial?.chargeByScreens ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [integrationMode, setIntegrationMode] = useState(initial?.integrationMode ?? "propria");
  const [panelIntegrationId, setPanelIntegrationId] = useState<string>(
    initial?.panelIntegrationId ? String(initial.panelIntegrationId) : "",
  );
  const [autoRenewEnabled, setAutoRenewEnabled] = useState(initial?.autoRenewEnabled ?? true);
  const [sendVia, setSendVia] = useState(initial?.sendVia ?? "padrao");
  const [apiBase, setApiBase] = useState(initial?.apiBase ?? "");
  const [apiToken, setApiToken] = useState("");
  const [clearApiToken, setClearApiToken] = useState(false);
  const [extendPath, setExtendPath] = useState(initial?.extendPath ?? "/users/extend");
  const [extendMethod, setExtendMethod] = useState(initial?.extendMethod ?? "POST");
  const [extendBody, setExtendBody] = useState(
    initial?.extendBody ?? '{"username":"{usuario}","days":{dias},"credits":{creditos}}',
  );
  const [appName, setAppName] = useState(initial?.appName ?? "");
  const [appDownloadUrl, setAppDownloadUrl] = useState(initial?.appDownloadUrl ?? "");
  const [downloaderCode, setDownloaderCode] = useState(initial?.downloaderCode ?? "");
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? "");
  const [serverUrlBackup, setServerUrlBackup] = useState(initial?.serverUrlBackup ?? "");
  const [epgUrl, setEpgUrl] = useState(initial?.epgUrl ?? "");
  const [pixEnabled, setPixEnabled] = useState(initial?.pixEnabled ?? true);
  const [pixInstructions, setPixInstructions] = useState(initial?.pixInstructions ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<{ connected: boolean; detail: string } | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.saveServer({
        id: initial?.id,
        name: name.trim(),
        panelUrl: panelUrl.trim(),
        panelUser: panelUser.trim(),
        panelPass,
        apiBase: integrationMode === "propria" ? apiBase.trim() : (initial?.apiBase ?? ""),
        apiToken: integrationMode === "propria" ? apiToken : "",
        clearApiToken: integrationMode === "propria" ? clearApiToken : false,
        extendPath: extendPath.trim(),
        extendMethod: (["POST", "PUT", "PATCH", "GET"].includes(extendMethod)
          ? extendMethod
          : "POST") as "POST" | "PUT" | "PATCH" | "GET",
        extendBody: extendBody.trim(),
        identifier: identifier.trim(),
        initialCredits: initial ? 0 : Math.max(0, Math.trunc(Number(initialCredits) || 0)),
        costPerCreditCents: parseBRL(costText) ?? 0,
        chargeByScreens,
        notes: notes.trim(),
        integrationMode: (["nenhuma", "propria", "vinculada"].includes(integrationMode)
          ? integrationMode
          : "propria") as "nenhuma" | "propria" | "vinculada",
        panelIntegrationId: integrationMode === "vinculada" && panelIntegrationId ? Number(panelIntegrationId) : null,
        autoRenewEnabled,
        sendVia: sendVia === "whatsapp" ? "whatsapp" : "padrao",
        appName: appName.trim(),
        appDownloadUrl: appDownloadUrl.trim(),
        downloaderCode: downloaderCode.trim(),
        serverUrl: serverUrl.trim(),
        serverUrlBackup: serverUrlBackup.trim(),
        epgUrl: epgUrl.trim(),
        pixEnabled,
        pixInstructions: pixInstructions.trim(),
      }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      // Ao salvar, a conexão já foi testada de verdade com link,
      // usuário e senha: mostra Conectado ou o motivo aqui mesmo.
      setSaveResult({ connected: r.connected, detail: r.connectionDetail });
    },
    onError: (e) => setError(String(e)),
  });

  const derivedName = (() => {
    const raw = panelUrl.trim();
    if (!raw) return "";
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();

  const baseHint = apiBase.includes("/auth/static-token")
    ? "Você colou o endereço completo do teste. Ao salvar, o gestor guarda só a base e remove /auth/static-token para não duplicar o caminho."
    : apiBase.trim().endsWith("/") && apiBase.trim().length > 8
      ? "A base termina com barra. Ao salvar, o gestor remove a barra final."
      : "";

  const renewStatus = !autoRenewEnabled
    ? "Desligada: pagamentos aprovados ficam como “extensão pendente” até você renovar."
    : integrationMode === "nenhuma"
      ? "Pendente: nenhuma integração de painel selecionada — escolha uma integração para funcionar."
      : integrationMode === "vinculada" && !panelIntegrationId
        ? "Pendente: escolha qual integração de painel fica vinculada a este servidor."
        : !initial
          ? "Ligada: a renovação usa a conexão deste servidor e estende o usuário IPTV exato do cliente. Se a API do painel responder erro (ex.: HTTP 400), a renovação fica pendente com o motivo, sem consumir crédito."
          : !initial.extendVerified
            ? "Ligada: a renovação usa a conexão deste servidor e estende o usuário IPTV exato do cliente. Se a API do painel responder erro (ex.: HTTP 400), a renovação fica pendente com o motivo, sem consumir crédito."
            : "Ativa e verificada: já renovou de verdade pelo painel.";

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaveResult(null);
    if (!panelUrl.trim()) {
      setError("Informe o link do painel — é o endereço que você abre para entrar no painel.");
      return;
    }
    if (!panelUser.trim()) {
      setError("Informe o usuário para acessar o painel.");
      return;
    }
    if (!initial && !panelPass) {
      setError("Informe a senha para acessar o painel.");
      return;
    }
    if (showAdvanced && costText.trim() && parseBRL(costText) == null) {
      setError("Nas Opções avançadas, o custo por crédito está inválido. Use o formato 2,00.");
      return;
    }
    if (showAdvanced && integrationMode === "vinculada" && !panelIntegrationId) {
      setError("Nas Opções avançadas, escolha a integração de painel para vincular, ou troque o modo de integração.");
      return;
    }
    save.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={initial ? "Editar servidor" : "Novo Servidor"}>
      <form
        onSubmit={submit}
        className="flex max-h-[94vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-[var(--surface)] shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <h3 className="font-display text-lg font-bold">{initial ? "Editar Servidor" : "Novo Servidor"}</h3>
          <button type="button" className={btnGhost} onClick={onDone} aria-label="Fechar">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-sm text-[var(--dim)]">
            Só três informações para acessar o painel. Ao salvar, o gestor testa a conexão com elas e mostra se conectou.
          </p>
          <div>
            <label htmlFor="s-url" className={labelCls}>Link do Painel *</label>
            <input id="s-url" className={inputCls} value={panelUrl} onChange={(e) => setPanelUrl(e.target.value)} required placeholder="https://painel.seuservidor.com" autoComplete="off" />
            <p className="mt-1 text-sm text-[var(--dim)]">O endereço que você abre para entrar no painel do servidor</p>
          </div>
          <div>
            <label htmlFor="s-user" className={labelCls}>Usuário *</label>
            <input id="s-user" className={inputCls} value={panelUser} onChange={(e) => setPanelUser(e.target.value)} required placeholder="Usuário para acessar o painel" autoComplete="off" />
          </div>
          <div>
            <label htmlFor="s-pass" className={labelCls}>{initial ? "Senha (em branco mantém a atual)" : "Senha *"}</label>
            <input id="s-pass" type="password" className={inputCls} value={panelPass} onChange={(e) => setPanelPass(e.target.value)} placeholder={initial ? "••••••" : "Senha para acessar o painel"} autoComplete="off" required={!initial} />
            <p className="mt-1 text-sm text-[var(--dim)]">
              {initial && initial.hasPass
                ? "A senha atual está guardada no gestor e nunca é exibida. Preencha só se quiser trocar."
                : "A senha fica guardada no gestor e nunca é exibida depois de salvar."}
            </p>
          </div>
          {!initial && (
            <p className="text-sm text-[var(--dim)]">
              Na lista, este servidor aparece como <strong className="text-[var(--text)]">{derivedName || "o nome do link do painel"}</strong> — dá para trocar o nome depois em Editar → Opções avançadas.
            </p>
          )}
          {initial && (
            <p className={`rounded-lg px-3 py-2 text-sm font-medium ${initial.panelConnected ? "bg-[var(--ok-bg)] text-[var(--card-green)]" : "bg-[var(--danger-bg)] text-[var(--danger)]"}`} role="status">
              {initial.panelConnected ? "Conectado" : "Não conectado"}
              {initial.panelConnectionDetail ? ` — ${initial.panelConnectionDetail}` : ""}
            </p>
          )}

          <div className="rounded-xl border border-[var(--border)]">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left font-semibold"
              aria-expanded={showAdvanced}
              aria-controls="server-advanced"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span>Opções avançadas <span className="font-normal text-[var(--dim)]">(opcional)</span></span>
              <span aria-hidden="true">{showAdvanced ? "▾" : "▸"}</span>
            </button>
            {showAdvanced && (
              <div id="server-advanced" className="space-y-4 border-t border-[var(--border)] px-4 py-4">
                <p className="text-sm text-[var(--dim)]">
                  Nada aqui é obrigatório para conectar o servidor. Preencha só se quiser ajustar nome, créditos, custo, aplicativo, endereços ou a API do painel.
                </p>
                <div>
                  <label htmlFor="s-name" className={labelCls}>Nome do Servidor</label>
                  <input id="s-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedName || "Ex: Alpha, Beta…"} autoComplete="off" />
                  <p className="mt-1 text-sm text-[var(--dim)]">Em branco, o gestor usa o nome do link do painel.</p>
                </div>
                <div>
                  <label htmlFor="s-identifier" className={labelCls}>Identificador (opcional)</label>
                  <input id="s-identifier" className={inputCls} value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="Ex: SRV-001 — código interno de referência" autoComplete="off" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {initial ? (
                    <div>
                      <span className={labelCls}>Créditos atuais</span>
                      <p className="rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 font-display text-lg font-bold">
                        {initial.creditsBalance}
                      </p>
                      <p className="mt-1 text-sm text-[var(--dim)]">Use “Recarregar” no cartão do servidor para controle detalhado</p>
                    </div>
                  ) : (
                    <div>
                      <label htmlFor="s-credits" className={labelCls}>Créditos Iniciais</label>
                      <input id="s-credits" type="number" min={0} className={inputCls} value={initialCredits} onChange={(e) => setInitialCredits(e.target.value)} inputMode="numeric" />
                      <p className="mt-1 text-sm text-[var(--dim)]">Use “Recarregar” para controle detalhado</p>
                    </div>
                  )}
                  <div>
                    <label htmlFor="s-cost" className={labelCls}>Custo por Crédito (R$)</label>
                    <input id="s-cost" className={inputCls} value={costText} onChange={(e) => setCostText(e.target.value)} placeholder="0,00" inputMode="decimal" />
                    <p className="mt-1 text-sm text-[var(--dim)]">Custo médio por crédito — entra no Custo do Receita x Custo</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface2)] p-3">
                  <div>
                    <p className="font-semibold">$ Cobrança por telas</p>
                    <p className="text-sm text-[var(--dim)]">Custo multiplicado pelo número de telas do cliente</p>
                  </div>
                  <SwitchToggle label="Cobrança por telas" checked={chargeByScreens} onToggle={() => setChargeByScreens((v) => !v)} />
                </div>
                <div>
                  <label htmlFor="s-notes" className={labelCls}>Observações</label>
                  <textarea id="s-notes" className={inputCls} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações sobre o servidor…" />
                </div>

                <fieldset className="space-y-3 rounded-xl bg-[var(--surface2)] p-3">
                  <legend className="px-1 text-xs font-bold uppercase tracking-widest text-[var(--dim)]">Integração e renovação</legend>
                  <div>
                    <label htmlFor="s-integration" className={labelCls}>Painel IPTV</label>
                    <select
                      id="s-integration"
                      className={inputCls}
                      value={integrationMode === "vinculada" ? "vinculada" : integrationMode}
                      onChange={(e) => setIntegrationMode(e.target.value)}
                    >
                      <option value="propria">A conexão deste servidor (link, usuário e senha acima)</option>
                      <option value="vinculada">Vincular integração da aba Integrações</option>
                      <option value="nenhuma">Nenhuma integração</option>
                    </select>
                    <p className="mt-1 text-sm text-[var(--dim)]">A renovação automática usa esta conexão para estender o usuário IPTV do cliente.</p>
                  </div>
                  {integrationMode === "vinculada" && (
                    <div>
                      <label htmlFor="s-integration-id" className={labelCls}>Integração cadastrada</label>
                      <select id="s-integration-id" className={inputCls} value={panelIntegrationId} onChange={(e) => setPanelIntegrationId(e.target.value)}>
                        <option value="">Selecione…</option>
                        {data.integrations.map((i) => (
                          <option key={i.id} value={i.id}>{i.name} — {i.url}</option>
                        ))}
                      </select>
                      {data.integrations.length === 0 && (
                        <p className="mt-1 text-sm text-[var(--warn)]">
                          Nenhuma integração cadastrada ainda. Cadastre em Integrações → Painéis IPTV (WPlay) e volte aqui para vincular.
                        </p>
                      )}
                    </div>
                  )}
                  {integrationMode === "propria" && (
                    <div className="space-y-3 border-t border-[var(--border)] pt-3">
                      <p className="text-sm text-[var(--dim)]">
                        Opcional: se o seu painel tiver uma API própria com token, configure aqui. Sem isso, a renovação tenta a chamada de extensão pelo link do painel; se a API responder erro (ex.: HTTP 400), a renovação fica pendente com o motivo e nenhum crédito é consumido.
                      </p>
                      <div>
                        <label htmlFor="s-api-base" className={labelCls}>Base da API do painel (opcional)</label>
                        <input id="s-api-base" className={inputCls} value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="Em branco, usa o link do painel" autoComplete="off" />
                        {baseHint && <p className="mt-1 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn)]" role="status">{baseHint}</p>}
                      </div>
                      <div>
                        <label htmlFor="s-api-token" className={labelCls}>
                          {initial?.hasApiToken ? "Token da API do painel (em branco mantém o salvo)" : "Token da API do painel (opcional)"}
                        </label>
                        <input
                          id="s-api-token"
                          type="password"
                          className={inputCls}
                          value={apiToken}
                          onChange={(e) => setApiToken(e.target.value)}
                          placeholder={initial?.hasApiToken ? "•••••••••• já salvo — preencha só para trocar" : "Preencha só se o painel tiver API com token"}
                          autoComplete="off"
                          disabled={clearApiToken}
                        />
                        <p className="mt-1 text-sm text-[var(--dim)]">
                          Status: {initial?.hasApiToken ? "token salvo no gestor (nunca exibido)" : "nenhum token salvo"}.
                        </p>
                      </div>
                      {initial?.hasApiToken && (
                        <label className="flex items-start gap-2 text-sm">
                          <input type="checkbox" checked={clearApiToken} onChange={(e) => setClearApiToken(e.target.checked)} className="mt-0.5 h-5 w-5" aria-label="Remover o token da API salvo" />
                          <span>Remover o token da API salvo ao salvar este servidor</span>
                        </label>
                      )}
                      <div>
                        <p className="text-sm font-bold">Chamada que renova o cliente (o [+] Estender, pela API)</p>
                        <div className="mt-2 grid grid-cols-[1fr_130px] gap-3">
                          <div>
                            <label htmlFor="s-extend-path" className={labelCls}>Caminho da extensão</label>
                            <input id="s-extend-path" className={inputCls} value={extendPath} onChange={(e) => setExtendPath(e.target.value)} placeholder="/users/extend" autoComplete="off" />
                          </div>
                          <div>
                            <label htmlFor="s-extend-method" className={labelCls}>Método</label>
                            <select id="s-extend-method" className={inputCls} value={extendMethod} onChange={(e) => setExtendMethod(e.target.value)}>
                              <option value="POST">POST</option>
                              <option value="PUT">PUT</option>
                              <option value="PATCH">PATCH</option>
                              <option value="GET">GET</option>
                            </select>
                          </div>
                        </div>
                        <div className="mt-2">
                          <label htmlFor="s-extend-body" className={labelCls}>Corpo da chamada</label>
                          <textarea id="s-extend-body" className={`${inputCls} font-mono text-sm`} rows={3} value={extendBody} onChange={(e) => setExtendBody(e.target.value)} />
                          <p className="mt-1 text-sm text-[var(--dim)]">Pode usar {"{usuario}"}, {"{senha}"}, {"{dias}"} e {"{creditos}"} — usuário e senha aqui são os do cliente IPTV que será estendido.</p>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface)] p-3">
                    <div>
                      <p className="font-semibold">Renovação automática no painel</p>
                      <p className="text-sm text-[var(--dim)]">Usa a conexão deste servidor para estender o cliente quando o pagamento é aprovado</p>
                    </div>
                    <SwitchToggle label="Renovação automática no painel" checked={autoRenewEnabled} onToggle={() => setAutoRenewEnabled((v) => !v)} />
                  </div>
                  <p className="text-sm text-[var(--dim)]" role="status">{renewStatus}</p>
                  <div>
                    <label htmlFor="s-sendvia" className={labelCls}>Enviar por</label>
                    <select id="s-sendvia" className={inputCls} value={sendVia} onChange={(e) => setSendVia(e.target.value)}>
                      <option value="padrao">Padrão do sistema</option>
                      <option value="whatsapp">Dispositivo WhatsApp conectado (QR Code)</option>
                    </select>
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      Por onde as mensagens deste servidor saem.
                      {sendVia === "whatsapp" && data.qrWhatsappStatus !== "conectado"
                        ? " Atenção: o WhatsApp desta conta ainda não está conectado pelo QR Code — conecte na aba WhatsApp."
                        : ""}
                    </p>
                  </div>
                </fieldset>

                <fieldset className="space-y-3 rounded-xl bg-[var(--surface2)] p-3">
                  <legend className="px-1 text-xs font-bold uppercase tracking-widest text-[var(--dim)]">Aplicativo dos clientes</legend>
                  <div>
                    <label htmlFor="s-app-name" className={labelCls}>Nome do aplicativo</label>
                    <input id="s-app-name" className={inputCls} value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="Ex.: XCIPTV, IBO Player, Smarters" autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="s-app-url" className={labelCls}>Link para baixar o aplicativo</label>
                    <input id="s-app-url" className={inputCls} value={appDownloadUrl} onChange={(e) => setAppDownloadUrl(e.target.value)} placeholder="https://…" autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="s-app-code" className={labelCls}>Código no Downloader (opcional)</label>
                    <input id="s-app-code" className={inputCls} value={downloaderCode} onChange={(e) => setDownloaderCode(e.target.value)} placeholder="Ex.: 123456" autoComplete="off" />
                  </div>
                </fieldset>

                <fieldset className="space-y-3 rounded-xl bg-[var(--surface2)] p-3">
                  <legend className="px-1 text-xs font-bold uppercase tracking-widest text-[var(--dim)]">Endereços para o aplicativo</legend>
                  <div>
                    <label htmlFor="s-server-url" className={labelCls}>URL do servidor (DNS)</label>
                    <input id="s-server-url" className={inputCls} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="Ex.: http://dns.seuservidor.com:8080" autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="s-server-url2" className={labelCls}>URL alternativa (backup)</label>
                    <input id="s-server-url2" className={inputCls} value={serverUrlBackup} onChange={(e) => setServerUrlBackup(e.target.value)} placeholder="Ex.: http://dns2.seuservidor.com:8080" autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="s-epg-url" className={labelCls}>URL do guia de programação (EPG) — opcional</label>
                    <input id="s-epg-url" className={inputCls} value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} placeholder="https://…" autoComplete="off" />
                  </div>
                </fieldset>

                <fieldset className="space-y-3 rounded-xl bg-[var(--surface2)] p-3">
                  <legend className="px-1 text-xs font-bold uppercase tracking-widest text-[var(--dim)]">PIX</legend>
                  <p className="text-sm text-[var(--dim)]">
                    A renovação com Pix dos clientes deste servidor é processada <strong className="text-[var(--text)]">somente pelo Mercado Pago</strong> da sua conta (aba Integração Pagamento).
                  </p>
                  <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-sm">
                    Mercado Pago da conta: {data.mpVerified ? "conectado e testado" : data.mpConfigured ? "token salvo, teste pendente" : "não configurado"} • Modo ao vivo: {data.liveMode ? "ligado" : "desligado"}
                  </p>
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface)] p-3">
                    <div>
                      <p className="font-semibold">Aceitar renovação com Pix neste servidor</p>
                      <p className="text-sm text-[var(--dim)]">Desligado, a fatura dos clientes deste servidor não gera Pix</p>
                    </div>
                    <SwitchToggle label="Aceitar renovação com Pix neste servidor" checked={pixEnabled} onToggle={() => setPixEnabled((v) => !v)} />
                  </div>
                  <div>
                    <label htmlFor="s-pix-instructions" className={labelCls}>Instruções de pagamento na fatura (opcional)</label>
                    <textarea
                      id="s-pix-instructions"
                      className={inputCls}
                      rows={3}
                      value={pixInstructions}
                      onChange={(e) => setPixInstructions(e.target.value)}
                      placeholder="Ex.: Depois de pagar, aguarde alguns segundos nesta página até a confirmação aparecer."
                    />
                  </div>
                </fieldset>
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-[var(--border)] px-5 py-4">
          {error && <p className="mb-3 text-sm font-medium text-[var(--danger)]" role="alert">{error}</p>}
          {saveResult && (
            <p
              className={`mb-3 rounded-lg px-3 py-2 text-sm font-medium ${saveResult.connected ? "bg-[var(--ok-bg)] text-[var(--card-green)]" : "bg-[var(--danger-bg)] text-[var(--danger)]"}`}
              role="status"
            >
              {saveResult.connected ? "Servidor salvo e conectado. " : "Servidor salvo, mas não conectou. "}
              {saveResult.detail}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={onDone}>
              {saveResult ? "Concluir" : "Cancelar"}
            </button>
            <button type="submit" className="rounded-lg bg-[var(--accent)] px-5 py-2.5 font-semibold text-[var(--accent-ink)] disabled:opacity-50" disabled={save.isPending}>
              {save.isPending ? "Salvando e testando a conexão…" : initial ? "Salvar alterações" : "Cadastrar"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/* ---------------- Pagamentos / Mercado Pago ---------------- */

function paymentStatusLabel(status: string): string {
  switch (status) {
    case "pendente":
      return "Pendente";
    case "aprovado":
      return "Aprovado";
    case "aprovado_pendente_painel":
      return "Aprovado — painel pendente";
    case "recusado":
      return "Recusado/cancelado";
    case "aguardando_configuracao":
      return "Aguardando configuração";
    case "falhou":
      return "Falhou";
    default:
      return status;
  }
}

function PaymentsTab({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [accessToken, setAccessToken] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [environment, setEnvironment] = useState(data.mpEnvironment);
  const [liveMode, setLiveMode] = useState(data.liveMode);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ connected: boolean; detail: string } | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [liveClientId, setLiveClientId] = useState("");
  const [validationClientId, setValidationClientId] = useState("");
  const [lastPayment, setLastPayment] = useState<Payment | null>(null);
  const [paymentMsg, setPaymentMsg] = useState<string | null>(null);
  const [copiedPaymentId, setCopiedPaymentId] = useState<number | null>(null);
  // A usuária marcou "Ligar modo ao vivo" ao salvar, antes do teste:
  // depois que o teste passar, o modo ao vivo é ligado sozinho com
  // uma segunda gravação, sem ela precisar marcar e salvar de novo.
  const wantedLiveModeRef = useRef(false);

  useEffect(() => {
    setEnvironment(data.mpEnvironment);
    setLiveMode(data.liveMode);
  }, [data.mpEnvironment, data.liveMode]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });

  const test = useMutation({
    mutationFn: () => api.testMercadoPago({}),
    onSuccess: (r) => {
      setTestResult({ connected: r.connected, detail: r.detail });
      setTestMsg(null);
      const wantedLive = wantedLiveModeRef.current;
      wantedLiveModeRef.current = false;
      invalidate();
      if (r.connected && wantedLive && environment === "producao") {
        saveLive.mutate();
      }
    },
    onError: (e) => {
      wantedLiveModeRef.current = false;
      setTestResult({ connected: false, detail: String(e) });
    },
  });

  const saveLive = useMutation({
    mutationFn: () =>
      api.saveMercadoPago({
        accessToken: "",
        publicKey: "",
        environment: "producao",
        liveMode: true,
        clearCredentials: false,
      }),
    onSuccess: () => {
      setLiveMode(true);
      setFormMsg("Modo ao vivo ligado: o teste passou e as credenciais salvas foram confirmadas pelo Mercado Pago.");
      invalidate();
    },
    onError: (e) => setFormError(String(e)),
  });

  const save = useMutation({
    mutationFn: () =>
      api.saveMercadoPago({
        accessToken,
        publicKey,
        environment: environment === "producao" ? "producao" : "teste",
        liveMode,
        clearCredentials: false,
      }),
    onSuccess: () => {
      setAccessToken("");
      setPublicKey("");
      // Salvar não descarta mais as credenciais quando o modo ao vivo
      // foi marcado antes do teste: elas ficam salvas, com o modo ao
      // vivo desligado, e o teste roda sozinho logo abaixo.
      setFormMsg("Credenciais salvas no gestor. O access token não será mostrado novamente. Testando a conexão agora…");
      invalidate();
      test.mutate();
    },
    onError: (e) => setFormError(String(e)),
  });

  const clear = useMutation({
    mutationFn: () =>
      api.saveMercadoPago({
        accessToken: "",
        publicKey: "",
        environment: environment === "producao" ? "producao" : "teste",
        liveMode: false,
        clearCredentials: true,
      }),
    onSuccess: () => {
      setAccessToken("");
      setPublicKey("");
      setLiveMode(false);
      setFormMsg("Credenciais removidas e modo ao vivo desligado.");
      invalidate();
    },
    onError: (e) => setFormError(String(e)),
  });

  const sync = useMutation({
    mutationFn: () => api.syncPendingPayments({}),
    onSuccess: (r) => {
      setSyncMsg(
        `${r.detail} Consultadas: ${r.checked}. Validações aprovadas: ${r.approvedValidation}. Pagamentos reais aguardando painel: ${r.pendingPanel}. Renovações aplicadas: ${r.applied}. Recusadas: ${r.rejected}.`,
      );
      invalidate();
    },
    onError: (e) => setSyncMsg(String(e)),
  });

  const create = useMutation({
    mutationFn: (args: { clientId: number; mode: "validacao" | "producao" }) => api.createPix(args),
    onSuccess: (p) => {
      setLastPayment(p);
      setPaymentMsg(p.detail || null);
      invalidate();
    },
    onError: (e) => setPaymentMsg(String(e)),
  });

  const check = useMutation({
    mutationFn: (id: number) => api.checkPaymentStatus({ paymentId: id }),
    onSuccess: (r) => {
      setPaymentMsg(r.detail);
      invalidate();
    },
    onError: (e) => setPaymentMsg(String(e)),
  });

  const simulate = useMutation({
    mutationFn: (id: number) => api.simulatePaymentApproved({ paymentId: id }),
    onSuccess: (r) => {
      setPaymentMsg(r.detail);
      invalidate();
    },
    onError: (e) => setPaymentMsg(String(e)),
  });

  function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setFormMsg(null);
    setFormError(null);
    wantedLiveModeRef.current = liveMode && environment === "producao";
    save.mutate();
  }

  const pixReady = data.mpVerified && data.mpEnvironment === "producao" && data.liveMode;
  const clientsWithPlan = data.clients.filter((c) => c.planId != null);

  return (
    <section aria-label="Integração Pagamento — Mercado Pago" className="mt-5 space-y-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Integração Pagamento</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Por onde seus clientes pagam. Só existe um gateway aqui: o Mercado Pago, para PIX e cartão.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2" aria-label="Formas de pagamento e gateway">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-display text-lg font-bold">PIX</p>
          <label htmlFor="gw-pix" className={labelCls}>Gateway do PIX</label>
          <select id="gw-pix" className={inputCls} value="mercadopago" disabled aria-label="Gateway do PIX: Mercado Pago">
            <option value="mercadopago">Mercado Pago</option>
          </select>
          <p className="mt-1 text-sm text-[var(--dim)]">É o único gateway de PIX deste gestor.</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-display text-lg font-bold">Cartão</p>
          <label htmlFor="gw-card" className={labelCls}>Gateway do cartão</label>
          <select id="gw-card" className={inputCls} value="mesmo" disabled aria-label="Gateway do cartão: o mesmo do PIX">
            <option value="mesmo">Mesmo do PIX</option>
          </select>
          <p className="mt-1 text-sm text-[var(--dim)]">Usando Mercado Pago, o mesmo do PIX.</p>
        </div>
      </div>

      <div>
        <h3 className="font-display text-xl font-bold">Mercado Pago</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Para conectar, bastam a Public Key e o Access Token. Nunca cole o access token
          em chats: ele fica salvo no banco do gestor e nunca volta para a tela.
        </p>
      </div>

      <form onSubmit={submitCredentials} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Credenciais do Mercado Pago">
        <div>
          <label htmlFor="mp-public" className={labelCls}>Public Key do Mercado Pago</label>
          <input
            id="mp-public"
            className={inputCls}
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder={data.mpPublicKeyMasked ? `${data.mpPublicKeyMasked} — preencha só para trocar` : "Cole aqui a Public Key"}
            autoComplete="off"
          />
          <p className="mt-1 text-sm text-[var(--dim)]">
            Status: {data.mpPublicKeyMasked ? `salva (${data.mpPublicKeyMasked})` : "não salva"} • A chave começa com APP_USR- em Produção ou TEST- em Teste. E-mail não é chave: copie a chave em Suas integrações → Meios de pagamento → Credenciais, no Mercado Pago.
          </p>
        </div>
        <div>
          <label htmlFor="mp-token" className={labelCls}>Access Token do Mercado Pago</label>
          <input
            id="mp-token"
            type="password"
            className={inputCls}
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={data.mpConfigured ? "•••••••••• já salvo — preencha só para trocar" : "Cole aqui o Access Token"}
            autoComplete="off"
          />
          <p className="mt-1 text-sm text-[var(--dim)]">
            Status: {data.mpConfigured ? "salvo" : "não salvo"} • Conexão: {data.mpVerified ? `testada${data.mpAccountLabel ? ` (${data.mpAccountLabel})` : ""}` : "ainda não testada"} • O token também começa com APP_USR- em Produção ou TEST- em Teste, e precisa ser do mesmo ambiente que a Public Key.
          </p>
        </div>
        <fieldset>
          <legend className={labelCls}>Ambiente das credenciais</legend>
          <div className="flex flex-wrap gap-2">
            {(["teste", "producao"] as const).map((env) => (
              <button
                key={env}
                type="button"
                aria-pressed={environment === env}
                onClick={() => {
                  setEnvironment(env);
                  if (env === "teste") setLiveMode(false);
                }}
                className={
                  environment === env
                    ? "rounded-full bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-ink)]"
                    : "rounded-full border border-[var(--border)] px-4 py-2"
                }
              >
                {env === "teste" ? "Teste" : "Produção"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-[var(--dim)]">
            Use o ambiente que combina com o token: credenciais de teste começam
            normalmente com TEST e as de produção com APP_USR. O gestor não mistura
            os dois para fingir uma cobrança real.
          </p>
        </fieldset>

        <label className="flex items-start gap-3 rounded-lg bg-[var(--surface2)] p-3">
          <input
            type="checkbox"
            checked={liveMode}
            onChange={(e) => setLiveMode(e.target.checked)}
            className="mt-1 h-5 w-5"
            aria-label="Ligar modo ao vivo"
          />
          <span>
            <span className="block font-semibold">Ligar modo ao vivo</span>
            <span className="block text-sm text-[var(--dim)]">
              Só é liberado em Produção depois que o token salvo passa no teste de
              conexão. Ao salvar com ele marcado, o teste roda sozinho e, se passar,
              ele liga sozinho. Com ele ligado, a fatura gera Pix real e consulta a
              confirmação no Mercado Pago.
            </span>
          </span>
        </label>

        {formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
        {formMsg && <p className="text-sm font-semibold text-[var(--accent)]">{formMsg}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btnPrimary} disabled={save.isPending}>
            {save.isPending ? "Salvando…" : "Salvar credenciais"}
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={clear.isPending || !data.mpConfigured}
            onClick={() => clear.mutate()}
          >
            Remover credenciais
          </button>
        </div>
        <div className="border-t border-[var(--border)] pt-4">
          <button
            type="button"
            className="w-full rounded-lg bg-[var(--accent)] px-4 py-3.5 font-display text-lg font-bold text-[var(--accent-ink)] disabled:opacity-50"
            disabled={test.isPending}
            onClick={() => {
              setTestResult(null);
              test.mutate();
            }}
            aria-label="Testar conexão com o Mercado Pago"
          >
            {test.isPending ? "Testando o Mercado Pago…" : "Testar Mercado Pago"}
          </button>
          {!data.mpConfigured && (
            <p className="mt-2 text-sm text-[var(--dim)]">Depois de salvar, o teste roda sozinho. Se tocar em Testar Mercado Pago antes de salvar, ele vai dizer que ainda não há token salvo.</p>
          )}
          {testResult && (
            <div
              role="status"
              className={`mt-3 rounded-xl px-4 py-3 ${testResult.connected ? "bg-[var(--ok-bg)]" : "bg-[var(--danger-bg)]"}`}
            >
              <p className={`font-display text-lg font-extrabold ${testResult.connected ? "text-[var(--card-green)]" : "text-[var(--danger)]"}`}>
                {testResult.connected ? "Conectado" : "Não conectado"}
              </p>
              <p className="mt-1 text-sm">{testResult.detail}</p>
            </div>
          )}
          {testMsg && <p className="mt-2 text-sm text-[var(--dim)]">{testMsg}</p>}
        </div>
      </form>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-bold">Cobrança ao vivo — caminho principal</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Gere o Pix real de um cliente e envie a página da fatura dele. A
              confirmação é consultada automaticamente na fatura e também pode ser
              sincronizada aqui.
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${pixReady ? "bg-[var(--ok-bg)] text-[var(--accent)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}>
            {pixReady ? "Pix ao vivo pronto" : "Pix ao vivo pendente"}
          </span>
        </div>
        {!data.panelExtendReady && (
          <p className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn)]">
            Atenção: a extensão automática no painel ainda não foi verificada com um teste real
            (aba Servidores). Um pagamento real pode ser confirmado pelo Mercado Pago, mas ficará
            como “extensão pendente” e nenhum crédito será dado como gasto até a API do painel aceitar a extensão.
          </p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <label htmlFor="live-client" className={labelCls}>Cliente para gerar o Pix real</label>
            <select id="live-client" className={inputCls} value={liveClientId} onChange={(e) => setLiveClientId(e.target.value)}>
              <option value="">Selecione…</option>
              {clientsWithPlan.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.planName} — {brl(c.effectivePriceCents)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              className={btnPrimary}
              disabled={!pixReady || !liveClientId || create.isPending}
              onClick={() => create.mutate({ clientId: Number(liveClientId), mode: "producao" })}
            >
              Gerar Pix real
            </button>
          </div>
        </div>
        <button
          type="button"
          className={`${btnGhost} mt-3`}
          disabled={sync.isPending || !data.mpConfigured}
          onClick={() => {
            setSyncMsg(null);
            sync.mutate();
          }}
        >
          {sync.isPending ? "Sincronizando…" : "Sincronizar cobranças pendentes agora"}
        </button>
        {syncMsg && <p className="mt-2 text-sm text-[var(--dim)]">{syncMsg}</p>}
        {lastPayment && (
          <div className="mt-4 rounded-lg bg-[var(--surface2)] p-3 text-sm">
            <p className="font-semibold">
              Última cobrança gerada: {lastPayment.clientName} — {brl(lastPayment.amountCents)} — {paymentStatusLabel(lastPayment.status)}
            </p>
            <p className="mt-1 text-[var(--dim)]">{lastPayment.detail}</p>
            {(() => {
              const dono = data.clients.find((c) => c.id === lastPayment.clientId);
              return dono ? (
                <a href={invoiceHash(dono)} className="mt-2 inline-block font-semibold text-[var(--accent)]">
                  Abrir a fatura deste cliente
                </a>
              ) : null;
            })()}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4">
        <h3 className="font-display text-lg font-bold">Validação sem consumir crédito</h3>
        <p className="mt-1 text-sm">
          Área separada do fluxo ao vivo. Use somente credenciais de Teste do
          Mercado Pago. A confirmação simulada ou aprovada aqui{" "}
          <strong>não chama o painel, não altera o vencimento real e não consome crédito</strong>.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <label htmlFor="validation-client" className={labelCls}>Cliente para validar</label>
            <select id="validation-client" className={inputCls} value={validationClientId} onChange={(e) => setValidationClientId(e.target.value)}>
              <option value="">Selecione…</option>
              {clientsWithPlan.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.planName} — {brl(c.effectivePriceCents)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              className={btnGhost}
              disabled={!validationClientId || create.isPending || data.mpEnvironment !== "teste"}
              onClick={() => create.mutate({ clientId: Number(validationClientId), mode: "validacao" })}
            >
              Gerar Pix de validação
            </button>
          </div>
        </div>
        {data.mpEnvironment !== "teste" && (
          <p className="mt-2 text-sm">
            A validação fica bloqueada enquanto o ambiente salvo for Produção, para
            não gerar um Pix pagável que não renovaria a conta.
          </p>
        )}
      </div>

      {paymentMsg && <p className="rounded-lg bg-[var(--surface2)] px-3 py-2 text-sm">{paymentMsg}</p>}

      <div>
        <h3 className="font-display text-lg font-bold">Cobranças ({data.payments.length})</h3>
        <ul className="mt-3 space-y-3">
          {data.payments.map((p) => (
            <li key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-display font-bold">{p.clientName}</p>
                  <p className="text-sm text-[var(--dim)]">
                    {brl(p.amountCents)} • {p.days} dias • {p.credits} crédito{p.credits > 1 ? "s" : ""} • {new Date(p.createdAt).toLocaleString("pt-BR")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <span className="rounded-full bg-[var(--surface2)] px-3 py-1 text-xs font-bold">
                    {p.mode === "producao" ? "AO VIVO" : "VALIDAÇÃO"}
                  </span>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${p.status === "aprovado" ? "bg-[var(--ok-bg)] text-[var(--accent)]" : p.status === "aprovado_pendente_painel" ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--surface2)] text-[var(--dim)]"}`}>
                    {paymentStatusLabel(p.status)}
                  </span>
                </div>
              </div>
              {p.detail && <p className="mt-2 text-sm text-[var(--dim)]">{p.detail}</p>}
              {p.wouldExpireAt && (
                <p className="mt-1 text-sm">
                  {p.appliedRenewalId != null ? "Novo vencimento aplicado" : "Novo vencimento calculado"}: <strong>{fmtDate(p.wouldExpireAt)}</strong>
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {p.pixCode && (
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={async () => {
                      if (await copyText(p.pixCode ?? "")) setCopiedPaymentId(p.id);
                    }}
                  >
                    {copiedPaymentId === p.id ? "Pix copiado ✓" : "Copiar Pix"}
                  </button>
                )}
                {p.status === "pendente" && p.mpPaymentId && (
                  <button type="button" className={btnGhost} disabled={check.isPending} onClick={() => check.mutate(p.id)}>
                    Verificar no Mercado Pago
                  </button>
                )}
                {p.status === "aprovado_pendente_painel" && (
                  <button type="button" className={btnGhost} disabled={check.isPending} onClick={() => check.mutate(p.id)}>
                    Tentar a extensão no painel de novo
                  </button>
                )}
                {p.mode === "validacao" && p.status !== "aprovado" && (
                  <button type="button" className={btnGhost} disabled={simulate.isPending} onClick={() => simulate.mutate(p.id)}>
                    Simular confirmação — sem crédito
                  </button>
                )}
                {(() => {
                  const dono = data.clients.find((c) => c.id === p.clientId);
                  return dono ? (
                    <a href={invoiceHash(dono)} className={btnGhost}>Abrir fatura</a>
                  ) : null;
                })()}
              </div>
            </li>
          ))}
        </ul>
        {data.payments.length === 0 && (
          <p className="mt-4 text-center text-[var(--dim)]">Nenhuma cobrança ainda.</p>
        )}
      </div>
    </section>
  );
}

/* ---------------- WhatsApp (somente QR Code) ---------------- */

function WhatsAppTab({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [qrState, setQrState] = useState<QrStatus>({
    status: data.qrWhatsappStatus,
    phone: data.qrWhatsappPhone,
    detail: data.qrWhatsappDetail,
    imageDataUrl: data.qrWhatsappImage,
    updatedAt: data.qrWhatsappUpdatedAt,
  });

  useEffect(() => {
    setQrState({
      status: data.qrWhatsappStatus,
      phone: data.qrWhatsappPhone,
      detail: data.qrWhatsappDetail,
      imageDataUrl: data.qrWhatsappImage,
      updatedAt: data.qrWhatsappUpdatedAt,
    });
  }, [data.qrWhatsappStatus, data.qrWhatsappPhone, data.qrWhatsappDetail, data.qrWhatsappImage, data.qrWhatsappUpdatedAt]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });

  const startQr = useMutation({
    mutationFn: () => api.startWhatsAppQr({}),
    onMutate: () => {
      setQrState((prev) => ({
        ...prev,
        status: "gerando",
        imageDataUrl: null,
        detail: "Gerando um QR Code novo para você ler com o celular…",
      }));
    },
    onSuccess: (r) => {
      setQrState(r);
      invalidate();
    },
    onError: (e) => {
      setQrState((prev) => ({
        ...prev,
        status: "indisponivel",
        imageDataUrl: null,
        detail: `Não foi possível pedir o QR Code agora: ${String(e)}`,
      }));
    },
  });

  const disconnectQr = useMutation({
    mutationFn: () => api.disconnectWhatsAppQr({}),
    onSuccess: (r) => {
      setQrState(r);
      invalidate();
    },
  });

  const qrPolling = qrState.status === "gerando" || qrState.status === "aguardando" || qrState.status === "aguardando_leitura";
  useEffect(() => {
    if (!qrPolling) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.getWhatsAppQrStatus({});
        if (!cancelled) {
          setQrState(next);
          if (next.status === "conectado" || next.status === "indisponivel") {
            queryClient.invalidateQueries({ queryKey: ["state"] });
          }
        }
      } catch {
        // Mantém a tela em “gerando/aguardando” até a próxima verificação;
        // uma falha passageira de consulta não vira “conectado”.
      }
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [qrPolling, queryClient]);

  const qrConnected = qrState.status === "conectado";
  const qrStatusLabel =
    qrState.status === "conectado"
      ? "Conectado pelo QR Code"
      : qrState.status === "gerando"
        ? "Gerando QR Code…"
        : qrState.status === "aguardando" || qrState.status === "aguardando_leitura"
          ? "QR Code pronto — aguardando leitura"
          : qrState.status === "indisponivel"
            ? "QR Code indisponível nesta tentativa"
            : "Não conectado";

  /* ---- Dispositivos (o gestor mantém uma sessão de QR Code) ---- */
  const [deviceSearch, setDeviceSearch] = useState("");
  const [showConnect, setShowConnect] = useState(qrState.status !== "desconectado");
  const [oneDeviceNote, setOneDeviceNote] = useState(false);

  useEffect(() => {
    if (qrPolling) setShowConnect(true);
  }, [qrPolling]);

  const devicePhone = qrState.phone || data.qrWhatsappPhone;
  const devices = qrConnected
    ? [{ name: "Meu WhatsApp", phone: devicePhone || "Número conectado pelo QR Code", status: "Conectado" }]
    : [];
  const dq = deviceSearch.trim().toLowerCase();
  const visibleDevices = devices.filter(
    (d) => !dq || d.name.toLowerCase().includes(dq) || d.phone.toLowerCase().includes(dq) || d.status.toLowerCase().includes(dq),
  );

  /* ---- Preferências do dispositivo ---- */
  const [prefs, setPrefs] = useState({
    blockCalls: data.waBlockCalls,
    transcribeAudio: data.waTranscribeAudio,
    awayEnabled: data.waAwayEnabled,
  });
  const [awayDraft, setAwayDraft] = useState(data.waAwayMessage);
  const [awayOpen, setAwayOpen] = useState(false);
  const [prefsMsg, setPrefsMsg] = useState<string | null>(null);

  useEffect(() => {
    setPrefs({
      blockCalls: data.waBlockCalls,
      transcribeAudio: data.waTranscribeAudio,
      awayEnabled: data.waAwayEnabled,
    });
    if (!awayOpen) setAwayDraft(data.waAwayMessage);
  }, [data.waBlockCalls, data.waTranscribeAudio, data.waAwayEnabled, data.waAwayMessage, awayOpen]);

  const savePrefs = useMutation({
    mutationFn: (p: { blockCalls: boolean; transcribeAudio: boolean; awayEnabled: boolean; awayMessage: string }) =>
      api.saveWhatsAppPrefs(p),
    onSuccess: () => {
      setPrefsMsg("Preferências salvas neste gestor ✓");
      invalidate();
    },
    onError: (e) => setPrefsMsg(`Não foi possível salvar: ${String(e)}`),
  });

  function togglePref(key: "blockCalls" | "transcribeAudio" | "awayEnabled") {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setPrefsMsg(null);
    savePrefs.mutate({ ...next, awayMessage: awayDraft });
  }

  function PrefToggle({
    label,
    checked,
    onToggle,
  }: {
    label: string;
    checked: boolean;
    onToggle: () => void;
  }) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--accent)]" : "border border-[var(--border)] bg-[var(--surface2)]"}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow ${checked ? "right-0.5" : "left-0.5"}`}
          aria-hidden="true"
        />
      </button>
    );
  }

  return (
    <section aria-label="WhatsApp" className="mt-5 space-y-5 lg:mt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-extrabold">WhatsApp</h2>
          <p className="mt-0.5 text-sm text-[var(--dim)]">
            Gerencie múltiplos dispositivos WhatsApp para envio de mensagens
          </p>
          <p className="mt-1 max-w-2xl text-sm text-[var(--dim)]">
            A conexão é <strong className="text-[var(--text)]">somente pelo QR Code</strong>: igual a
            conectar um aparelho novo no WhatsApp. Depois de conectado, ele continua
            conectado até você tocar em desconectar.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-bold ${qrConnected ? "bg-[var(--ok-bg)] text-[var(--card-green)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}>
          {qrStatusLabel}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--ok-bg)] text-[var(--card-green)]" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="m8.5 12.2 2.4 2.4 4.6-5" />
            </svg>
          </span>
          <div>
            <p className="font-display text-2xl font-extrabold leading-none">{qrConnected ? 1 : 0}</p>
            <p className="mt-1 text-sm text-[var(--dim)]">Dispositivos Conectados</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--card-blue-bg)] text-[var(--card-blue)]" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="7" y="2.5" width="10" height="19" rx="2" />
              <path d="M11 18.5h2" />
            </svg>
          </span>
          <div>
            <p className="font-display text-2xl font-extrabold leading-none">{devices.length}</p>
            <p className="mt-1 text-sm text-[var(--dim)]">Total de Dispositivos</p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-lg font-bold">Dispositivos WhatsApp</h3>
        <button
          type="button"
          className={btnPrimary}
          aria-label="Adicionar dispositivo WhatsApp pelo QR Code"
          onClick={() => {
            if (qrConnected) {
              setOneDeviceNote(true);
            } else {
              setOneDeviceNote(false);
              setShowConnect(true);
            }
          }}
        >
          + Adicionar Dispositivo
        </button>
      </div>
      {oneDeviceNote && qrConnected && (
        <p className="rounded-lg bg-[var(--surface2)] px-3 py-2 text-sm text-[var(--dim)]" role="status">
          Este gestor mantém um dispositivo conectado por vez. Para conectar outro
          número, primeiro toque em Desconectar no cartão do dispositivo atual.
        </p>
      )}

      <div>
        <label htmlFor="wa-device-search" className="sr-only">Buscar dispositivos</label>
        <input
          id="wa-device-search"
          className={inputCls}
          value={deviceSearch}
          onChange={(e) => setDeviceSearch(e.target.value)}
          placeholder="Buscar dispositivos por nome, número ou status..."
          autoComplete="off"
        />
      </div>

      {devices.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <p className="font-display text-lg font-bold">Nenhum dispositivo conectado ainda</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--dim)]">
            Toque em <strong className="text-[var(--text)]">Adicionar Dispositivo</strong> e leia o QR Code
            com o seu celular para conectar o seu WhatsApp. Nenhum número fica salvo
            antes de você conectar.
          </p>
        </div>
      ) : visibleDevices.length === 0 ? (
        <p className="text-center text-[var(--dim)]">Nenhum dispositivo bate com esta busca.</p>
      ) : (
        visibleDevices.map((d) => (
          <div key={d.name} className="rounded-2xl border border-[var(--border)] border-l-4 border-l-[var(--card-green)] bg-[var(--surface)] p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] text-[var(--accent-bright)]" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="7" y="2.5" width="10" height="19" rx="2" />
                  <path d="M11 18.5h2" />
                </svg>
              </span>
              <div className="min-w-0">
                <p className="font-display font-bold uppercase">{d.name}</p>
                <p className="text-sm text-[var(--dim)]">{d.phone}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-[var(--card-green)]">
                  <span className="inline-block h-2 w-2 rounded-full bg-[var(--card-green)]" aria-hidden="true" />
                  {d.status}
                </p>
              </div>
            </div>

            <button
              type="button"
              className="mt-4 w-full rounded-lg border border-[var(--border)] px-3 py-2.5 font-semibold disabled:opacity-50"
              disabled={disconnectQr.isPending}
              onClick={() => disconnectQr.mutate()}
              aria-label="Desconectar dispositivo WhatsApp"
            >
              {disconnectQr.isPending ? "Desconectando…" : "Desconectar"}
            </button>

            <div className="mt-4 divide-y divide-[var(--border)]" aria-label="Configurações do dispositivo">
              <div className="flex items-center justify-between gap-3 py-3">
                <p className="text-sm font-medium">Bloqueio de chamadas</p>
                <span className="flex items-center gap-2">
                  <span className="rounded-md bg-[var(--surface2)] px-2 py-1 text-xs font-semibold text-[var(--dim)]">Configurar</span>
                  <PrefToggle label="Bloqueio de chamadas" checked={prefs.blockCalls} onToggle={() => togglePref("blockCalls")} />
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 py-3">
                <p className="text-sm font-medium">Transcrever áudios recebidos</p>
                <span className="flex items-center gap-2">
                  <span className="rounded-md bg-[var(--surface2)] px-2 py-1 text-xs font-semibold text-[var(--dim)]">Configurar</span>
                  <PrefToggle label="Transcrever áudios recebidos" checked={prefs.transcribeAudio} onToggle={() => togglePref("transcribeAudio")} />
                </span>
              </div>
              <div className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">Mensagem de ausência</p>
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-[var(--surface2)] px-2 py-1 text-xs font-semibold"
                      aria-expanded={awayOpen}
                      onClick={() => setAwayOpen((v) => !v)}
                    >
                      Configurar
                    </button>
                    <PrefToggle label="Mensagem de ausência" checked={prefs.awayEnabled} onToggle={() => togglePref("awayEnabled")} />
                  </span>
                </div>
                {awayOpen && (
                  <div className="mt-3">
                    <label htmlFor="wa-away-msg" className={labelCls}>
                      Texto enviado quando a mensagem de ausência está ligada
                    </label>
                    <textarea
                      id="wa-away-msg"
                      className={inputCls}
                      rows={3}
                      value={awayDraft}
                      onChange={(e) => setAwayDraft(e.target.value)}
                      placeholder="Ex.: No momento estou ausente. Já te respondo quando voltar!"
                    />
                    <button
                      type="button"
                      className={`${btnPrimary} mt-2`}
                      disabled={savePrefs.isPending}
                      onClick={() => {
                        setPrefsMsg(null);
                        savePrefs.mutate({ ...prefs, awayMessage: awayDraft });
                      }}
                    >
                      {savePrefs.isPending ? "Salvando…" : "Salvar mensagem de ausência"}
                    </button>
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-[var(--dim)]">
              Preferências salvas neste gestor para o dispositivo conectado.
              {prefsMsg ? ` ${prefsMsg}` : ""}
            </p>
          </div>
        ))
      )}

      {showConnect && !qrConnected && (
        <div className="rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface)] p-4" aria-label="Parear WhatsApp lendo o QR Code">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="font-display text-lg font-bold">Adicionar dispositivo — ler o QR Code para conectar</h3>
            {!qrPolling && (
              <button type="button" className={btnGhost} onClick={() => setShowConnect(false)}>
                Fechar
              </button>
            )}
          </div>
          <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-[var(--dim)]">
            <li>Toque no botão <strong className="text-[var(--text)]">Gerar QR Code</strong> aqui embaixo.</li>
            <li>No seu celular, abra o <strong className="text-[var(--text)]">WhatsApp</strong>.</li>
            <li>Toque em <strong className="text-[var(--text)]">Configurações</strong> (ou nos três pontinhos) e depois em <strong className="text-[var(--text)]">Aparelhos conectados</strong>.</li>
            <li>Toque em <strong className="text-[var(--text)]">Conectar aparelho</strong> e aponte a câmera para o QR Code desta tela.</li>
            <li>Pronto: esta tela verifica sozinha a cada 3 segundos, primeiro até o QR Code aparecer e depois até o celular confirmar a conexão.</li>
          </ol>

          <div className="mt-4 rounded-xl bg-[var(--surface2)] p-4 text-center" aria-live="polite">
            {qrState.imageDataUrl ? (
              <>
                <img
                  src={qrState.imageDataUrl}
                  alt="QR Code do WhatsApp para escanear com o celular"
                  className="mx-auto h-64 w-64 rounded-lg bg-white object-contain p-2"
                />
                <p className="mt-3 font-semibold">Leia este QR Code agora com o celular.</p>
                <p className="mt-1 text-sm text-[var(--dim)]">A tela continua verificando a cada 3 segundos até conectar.</p>
              </>
            ) : qrState.status === "gerando" ? (
              <>
                <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--surface)] px-6">
                  <p className="font-display text-lg font-bold">Gerando QR Code…</p>
                </div>
                <p className="mt-3 text-sm text-[var(--dim)]">Verificando a cada 3 segundos até o QR Code aparecer.</p>
              </>
            ) : (
              <>
                <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--surface)] px-6">
                  <p className="font-display text-lg font-bold">
                    {qrState.status === "indisponivel" ? "Nenhum QR Code foi emitido nesta tentativa" : "O QR Code vai aparecer aqui"}
                  </p>
                </div>
                {qrState.detail && <p className="mx-auto mt-3 max-w-xl text-sm text-[var(--dim)]">{qrState.detail}</p>}
              </>
            )}
          </div>

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className="rounded-xl bg-[var(--accent)] px-6 py-3.5 font-display text-lg font-bold text-[var(--accent-ink)] disabled:opacity-50"
              disabled={startQr.isPending || qrState.status === "gerando"}
              onClick={() => startQr.mutate()}
              aria-label="Gerar QR Code do WhatsApp"
            >
              {startQr.isPending || qrState.status === "gerando" ? "Gerando QR Code…" : qrState.status === "indisponivel" ? "Tentar gerar QR Code de novo" : "Gerar QR Code"}
            </button>
            {qrState.status !== "desconectado" && (
              <button
                type="button"
                className={btnGhost}
                disabled={disconnectQr.isPending}
                onClick={() => disconnectQr.mutate()}
                aria-label="Cancelar conexão do WhatsApp pelo QR Code"
              >
                {disconnectQr.isPending ? "Cancelando…" : "Cancelar"}
              </button>
            )}
          </div>
          <p className="mt-3 text-center text-sm text-[var(--dim)]">
            {qrPolling
              ? "Verificação automática ativa: a cada 3 segundos."
              : "Nenhum QR Code falso é mostrado: o código só aparece quando o serviço de sessão devolve um QR Code real."}
          </p>
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
        <p className="font-display font-bold">Se o envio automático não funcionar</p>
        <p className="mt-1 text-[var(--dim)]">
          No botão de WhatsApp de cada cliente (aba Clientes) continua o jeito manual: um toque abre o seu
          WhatsApp já com a mensagem prontinha para o número do cliente, e você só confirma o envio. Isso
          sempre funciona, mesmo sem nenhuma conexão automática.
        </p>
      </div>
    </section>
  );
}

/* ---------------- Mensagens ---------------- */

type MessageKind = "aviso" | "renovada" | "expirada";

function MessagesTab({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [warnMessage, setWarnMessage] = useState(data.warnMessage);
  const [renewedMessage, setRenewedMessage] = useState(data.renewedMessage);
  const [expiredMessage, setExpiredMessage] = useState(data.expiredMessage);
  const [chargeMessage, setChargeMessage] = useState(data.chargeMessage);
  const [kind, setKind] = useState<MessageKind>("aviso");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWarnMessage(data.warnMessage);
    setRenewedMessage(data.renewedMessage);
    setExpiredMessage(data.expiredMessage);
    setChargeMessage(data.chargeMessage);
  }, [data.warnMessage, data.renewedMessage, data.expiredMessage, data.chargeMessage]);

  const save = useMutation({
    mutationFn: () =>
      api.saveMessageTemplates({
        warnMessage: warnMessage.trim(),
        renewedMessage: renewedMessage.trim(),
        expiredMessage: expiredMessage.trim(),
        chargeMessage: chargeMessage.trim(),
      }),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setError(String(e)),
  });

  const template = kind === "aviso" ? warnMessage : kind === "renovada" ? renewedMessage : expiredMessage;

  return (
    <section aria-label="Mensagens" className="mt-5 space-y-5">
      <div>
        <h2 className="font-display text-xl font-bold">Mensagens do WhatsApp</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Modelos editáveis para vencimento próximo, conta renovada, conta
          expirada e cobrança. Use {"{nome}"}, {"{usuario}"}, {"{telefone}"}, {"{vencimento}"}, {"{novo_vencimento}"}, {"{dias}"}, {"{dias_vencido}"}, {"{valor}"}, {"{plano}"} e {"{link}"} — o {"{link}"} é o endereço completo da fatura daquele cliente, para ele tocar, abrir a fatura e copiar a chave Pix lá dentro. Os modelos de aviso, expirada e cobrança são os mesmos do botão “Enviar mensagem” na lista de clientes.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          setError(null);
          save.mutate();
        }}
        className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
        aria-label="Modelos de mensagens"
      >
        <div>
          <label htmlFor="msg-warn" className={labelCls}>Aviso de vencimento próximo</label>
          <textarea id="msg-warn" className={inputCls} rows={4} value={warnMessage} onChange={(e) => setWarnMessage(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="msg-renewed" className={labelCls}>Conta renovada</label>
          <textarea id="msg-renewed" className={inputCls} rows={4} value={renewedMessage} onChange={(e) => setRenewedMessage(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="msg-expired" className={labelCls}>Conta expirada</label>
          <textarea id="msg-expired" className={inputCls} rows={4} value={expiredMessage} onChange={(e) => setExpiredMessage(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="msg-charge" className={labelCls}>Cobrança</label>
          <textarea id="msg-charge" className={inputCls} rows={4} value={chargeMessage} onChange={(e) => setChargeMessage(e.target.value)} required />
        </div>
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        {saved && <p className="text-sm font-semibold text-[var(--accent)]">Modelos salvos ✓</p>}
        <button type="submit" className={btnPrimary} disabled={save.isPending}>
          {save.isPending ? "Salvando…" : "Salvar modelos"}
        </button>
      </form>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-lg font-bold">Enviar para um cliente</h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de mensagem">
            {(
              [
                ["aviso", "Vencimento próximo"],
                ["renovada", "Conta renovada"],
                ["expirada", "Conta expirada"],
              ] as [MessageKind, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className={kind === value ? "rounded-full bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-ink)]" : "rounded-full border border-[var(--border)] px-3 py-2 text-sm"}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-sm text-[var(--dim)]">
          O envio é manual e direto: o botão de cada cliente abre o seu WhatsApp com a mensagem já montada, e você só
          confirma o envio. Nas mensagens de aviso e de conta expirada, o <strong>link completo da fatura daquele cliente vai junto</strong> —
          ele toca no link, abre a fatura com o plano e o valor dele e copia a chave Pix lá dentro. O WhatsApp do gestor é conectado somente pelo QR Code (aba WhatsApp); a
          alternativa da Meta foi removida deste gestor, então nenhum envio é feito por ela.
        </p>
        <ul className="mt-4 space-y-3">
          {data.clients.map((c) => {
            const newExpiry = c.planDays != null ? todayPlusDays(c.planDays) : c.expiresAt;
            const rendered = renderMsg(template, {
              nome: c.name,
              usuario: c.iptvUser,
              vencimento: fmtDate(c.expiresAt),
              novoVencimento: fmtDate(newExpiry),
              dias: c.planDays,
              valor: brl(c.effectivePriceCents),
              plano: c.planName,
              link: invoiceUrl(c, data.publicBaseUrl),
            });
            // Aviso e expirada são cobranças: o link da fatura vai junto
            // sempre, mesmo que o modelo salvo não tenha o {link}.
            const msg = kind === "renovada" ? rendered : withInvoiceLink(rendered, c, data.publicBaseUrl);
            return (
              <li key={c.id} className="rounded-lg bg-[var(--surface2)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{c.name}</p>
                    <p className="text-sm text-[var(--dim)]">WhatsApp: {c.whatsapp ?? "não cadastrado"} • Vence em {fmtDate(c.expiresAt)}</p>
                  </div>
                  {c.whatsapp ? (
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={waLink(c.whatsapp, msg)}
                        target="_blank"
                        rel="noreferrer"
                        className={btnPrimary}
                        aria-label={`Enviar mensagem no WhatsApp para ${c.name}`}
                      >
                        Enviar no WhatsApp
                      </a>
                    </div>
                  ) : (
                    <span className="rounded-lg bg-[var(--surface)] px-3 py-2 text-sm text-[var(--dim)]">Edite o cliente e cadastre o número</span>
                  )}
                </div>
                <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-[var(--surface)] p-3 font-sans text-sm">{msg}</pre>
              </li>
            );
          })}
        </ul>
        {data.clients.length === 0 && <p className="mt-4 text-center text-[var(--dim)]">Cadastre um cliente para montar e enviar mensagens.</p>}
      </div>
    </section>
  );
}

/* ---------------- Histórico de renovações ---------------- */

function HistoryTab({ data }: { data: State }) {
  return (
    <section aria-label="Histórico de renovações" className="mt-5">
      <h2 className="font-display text-xl font-bold">Renovações ({data.renewals.length})</h2>
      <p className="mt-2 text-sm text-[var(--dim)]">
        Somente renovações realmente aplicadas aparecem aqui, com os créditos
        correspondentes ao usuário específico. Pagamentos aprovados que ainda
        aguardam o painel ficam na aba Pagamentos, não nesta lista.
      </p>
      <ul className="mt-4 space-y-3">
        {data.renewals.map((r) => (
          <li key={r.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-display font-bold">
                {r.clientName} <span className="font-mono text-sm font-normal text-[var(--dim)]">({r.iptvUser})</span>
              </p>
              <span className="rounded-full bg-[var(--surface2)] px-3 py-1 text-xs font-semibold text-[var(--dim)]">
                {r.source === "mercado_pago" ? "Mercado Pago ao vivo" : r.source === "teste_manual" ? "Registro manual anterior" : r.source} • {new Date(r.createdAt).toLocaleString("pt-BR")}
              </span>
            </div>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Plano {r.planName}: {r.days} dias • {r.credits} crédito{r.credits > 1 ? "s" : ""} consumido
              {r.credits > 1 ? "s" : ""} • {brl(r.amountCents)} • vencimento:{" "}
              {r.oldExpiresAt ? fmtDate(r.oldExpiresAt) : "—"} → <strong className="text-[var(--text)]">{fmtDate(r.newExpiresAt)}</strong>
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-medium text-[var(--accent)]">Mensagem de confirmação da renovação</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-[var(--surface2)] p-3 font-sans text-sm">{r.message}</pre>
            </details>
          </li>
        ))}
      </ul>
      {data.renewals.length === 0 && (
        <p className="mt-6 text-center text-[var(--dim)]">
          Nenhuma renovação aplicada ainda. Cobranças e pagamentos confirmados
          ficam na aba Pagamentos; esta aba só lista renovações concluídas.
        </p>
      )}
    </section>
  );
}

/* ---------------- Ajustes ---------------- */

const WARN_OPTIONS = [7, 5, 3, 1, 0];

function SettingsTab({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [warnDays, setWarnDays] = useState<number[]>(data.warnDays);
  const [invoiceTitle, setInvoiceTitle] = useState(data.invoiceTitle);
  const [invoiceMessage, setInvoiceMessage] = useState(data.invoiceMessage);
  const [invoiceColor, setInvoiceColor] = useState(data.invoiceColor);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWarnDays(data.warnDays);
    setInvoiceTitle(data.invoiceTitle);
    setInvoiceMessage(data.invoiceMessage);
    setInvoiceColor(data.invoiceColor);
  }, [data.warnDays, data.invoiceTitle, data.invoiceMessage, data.invoiceColor]);

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        warnDays,
        invoiceTitle: invoiceTitle.trim(),
        invoiceMessage: invoiceMessage.trim(),
        invoiceColor: (Object.keys(INVOICE_THEMES).includes(invoiceColor)
          ? invoiceColor
          : "verde") as "verde" | "azul" | "roxo" | "coral" | "grafite",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setSaved(true);
    },
    onError: (e) => setError(String(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setError(null);
    save.mutate();
  }

  return (
    <section aria-label="Ajustes" className="mt-5">
      <h2 className="font-display text-xl font-bold">Ajustes</h2>
      <form onSubmit={submit} className="mt-4 space-y-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <fieldset>
          <legend className={labelCls}>Avisar o cliente quantos dias antes do vencimento?</legend>
          <div className="flex flex-wrap gap-2">
            {WARN_OPTIONS.map((d) => {
              const active = warnDays.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setWarnDays((prev) =>
                      active ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => b - a),
                    )
                  }
                  className={
                    active
                      ? "rounded-full bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-ink)]"
                      : "rounded-full border border-[var(--border)] px-4 py-2"
                  }
                >
                  {d === 0 ? "No dia do vencimento" : `${d} dia${d > 1 ? "s" : ""} antes`}
                </button>
              );
            })}
          </div>
        </fieldset>

        <p className="rounded-lg bg-[var(--surface2)] px-3 py-2 text-sm text-[var(--dim)]">
          Os textos de aviso, renovação e expiração ficam na aba Mensagens, junto
          da prévia e do envio para o WhatsApp de cada cliente.
        </p>

        <div>
          <label htmlFor="set-title" className={labelCls}>Título da página da fatura</label>
          <input id="set-title" className={inputCls} value={invoiceTitle} onChange={(e) => setInvoiceTitle(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="set-msg" className={labelCls}>Texto da página da fatura</label>
          <textarea id="set-msg" className={inputCls} rows={3} value={invoiceMessage} onChange={(e) => setInvoiceMessage(e.target.value)} required />
        </div>
        <fieldset>
          <legend className={labelCls}>Cor / tema da página da fatura</legend>
          <div className="flex flex-wrap gap-2">
            {Object.entries(INVOICE_THEMES).map(([key, t]) => (
              <button
                key={key}
                type="button"
                aria-pressed={invoiceColor === key}
                onClick={() => setInvoiceColor(key)}
                className={`flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium ${
                  invoiceColor === key ? "border-[var(--accent)] ring-2 ring-[var(--accent)]" : "border-[var(--border)]"
                }`}
              >
                <span className="inline-block h-4 w-4 rounded-full" style={{ background: t.main }} />
                {t.label}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        {saved && <p className="text-sm font-semibold text-[var(--accent)]">Ajustes salvos ✓ — a página da fatura já usa o novo visual.</p>}
        <button type="submit" className={btnPrimary} disabled={save.isPending}>
          {save.isPending ? "Salvando…" : "Salvar ajustes"}
        </button>
      </form>

      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
        <p className="font-display font-bold">Imagem de fundo da fatura</p>
        <p className="mt-1 text-[var(--dim)]">
          Nesta versão a página usa a cor do tema escolhido acima, sem foto de
          fundo editável. Credenciais, status das integrações e modelos de
          mensagem ficam aqui em Integrações (Pagamentos, WhatsApp e Mensagens).
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4 text-sm" role="note" aria-label="Alvo permanente da renovação no painel">
        <p className="font-display font-bold">Alvo permanente da renovação no painel (não muda)</p>
        <p className="mt-1">
          Painel: <span className="font-mono">wwpanel.link/user-list</span> — lista “Meus usuários”. A renovação é o botão <strong>[+] Estender</strong> no canto direito da linha do usuário exato. Ao clicar, o painel pergunta a duração: use a duração do plano do cliente neste gestor (30 dias = 1 crédito, 60 = 2, 90 = 3 — normalmente só 1 mês).
        </p>
        <p className="mt-1">
          O ícone verde do WhatsApp no painel fica imediatamente à esquerda do [+] e <strong>não</strong> é renovação. O botão de WhatsApp deste gestor também não renova: ele só envia a fatura/mensagem. Status atual do painel neste gestor: <strong>{data.panelConnected ? "conectado" : "não conectado — extensão automática bloqueada"}</strong>. {data.panelStatusDetail}
        </p>
      </div>
    </section>
  );
}

/* ---------------- Dashboard (visão geral) ---------------- */

type PeriodKey = "hoje" | "mensal" | "anterior";

function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthKeyOf(d: Date): string {
  return localDayKey(d).slice(0, 7);
}

// Receita = pagamentos REAIS (modo produção) aprovados no Mercado Pago,
// incluindo os aprovados que ainda aguardam a extensão no painel — o
// dinheiro entrou; a pendência é do painel, não do pagamento.
function isRevenue(p: Payment): boolean {
  return p.mode === "producao" && (p.status === "aprovado" || p.status === "aprovado_pendente_painel");
}

function revenueInPeriod(payments: Payment[], period: PeriodKey): number {
  const now = new Date();
  const today = localDayKey(now);
  const month = monthKeyOf(now);
  const prev = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  return payments
    .filter(isRevenue)
    .filter((p) => {
      const d = new Date(p.createdAt);
      if (period === "hoje") return localDayKey(d) === today;
      if (period === "mensal") return monthKeyOf(d) === month;
      return monthKeyOf(d) === prev;
    })
    .reduce((sum, p) => sum + p.amountCents, 0);
}

function costInPeriod(expenses: Expense[], period: PeriodKey): number {
  const now = new Date();
  const today = localDayKey(now);
  const month = monthKeyOf(now);
  const prev = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  return expenses
    .filter((e) =>
      period === "hoje" ? e.spentOn === today : period === "mensal" ? e.spentOn.startsWith(month) : e.spentOn.startsWith(prev),
    )
    .reduce((sum, e) => sum + e.amountCents, 0);
}

// Custo dos créditos das renovações aplicadas no período: custo por
// crédito do servidor do cliente × créditos da renovação — multiplicado
// pelo número de telas do cliente quando o servidor cobra por telas.
// É o mesmo cálculo do consumo de saldo feito pelo servidor.
function creditCostInPeriod(data: State, period: PeriodKey): number {
  const now = new Date();
  const today = localDayKey(now);
  const month = monthKeyOf(now);
  const prev = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const clientById = new Map(data.clients.map((c) => [c.id, c]));
  const serverById = new Map(data.servers.map((s) => [s.id, s]));
  return data.renewals
    .filter((r) => {
      const d = new Date(r.createdAt);
      if (period === "hoje") return localDayKey(d) === today;
      if (period === "mensal") return monthKeyOf(d) === month;
      return monthKeyOf(d) === prev;
    })
    .reduce((sum, r) => {
      const client = clientById.get(r.clientId);
      const server = client?.serverId != null ? serverById.get(client.serverId) : undefined;
      if (!server || server.costPerCreditCents <= 0) return sum;
      const mult = server.chargeByScreens && client?.screens ? client.screens : 1;
      return sum + server.costPerCreditCents * r.credits * mult;
    }, 0);
}

function DashboardTab({
  data,
  onNavigate,
  onShowClients,
}: {
  data: State;
  onNavigate: (tab: Tab) => void;
  onShowClients: (filter: ClientFilter, search?: string) => void;
}) {
  const [hideValues, setHideValues] = useState(false);
  const [query, setQuery] = useState("");
  const money = (cents: number) => (hideValues ? "R$ •••" : brl(cents));

  const regular = data.clients.filter((c) => !c.isTest);
  const testCount = data.clients.length - regular.length;
  const ativos = regular.filter((c) => c.status === "ativo" && daysLeft(c.expiresAt) >= 0);
  const vencidos = regular.filter((c) => daysLeft(c.expiresAt) < 0);
  const sumPrices = (list: Client[]) => list.reduce((s, c) => s + c.effectivePriceCents, 0);

  const periods: { key: PeriodKey; label: string }[] = [
    { key: "hoje", label: "Hoje" },
    { key: "mensal", label: "Mensal" },
    { key: "anterior", label: "Mês Anterior" },
  ];

  const q = query.trim().toLowerCase();
  const results = q
    ? data.clients
        .filter((c) => c.name.toLowerCase().includes(q) || c.iptvUser.toLowerCase().includes(q))
        .slice(0, 6)
    : [];

  const byExpiry = [...data.clients].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const dueGroups: { title: string; items: Client[] }[] = [
    { title: "Vencidos", items: byExpiry.filter((c) => daysLeft(c.expiresAt) < 0) },
    { title: "Vence Hoje", items: byExpiry.filter((c) => daysLeft(c.expiresAt) === 0) },
    { title: "Vence Amanhã", items: byExpiry.filter((c) => daysLeft(c.expiresAt) === 1) },
    { title: "Próximos 7 dias", items: byExpiry.filter((c) => daysLeft(c.expiresAt) >= 2 && daysLeft(c.expiresAt) <= 7) },
  ];
  const hasDue = dueGroups.some((g) => g.items.length > 0);

  const cards: {
    label: string;
    count: number;
    value: number | null;
    hint: string;
    bg: string;
    border: string;
    color: string;
    filter: ClientFilter;
  }[] = [
    {
      label: "Ativos",
      count: ativos.length,
      value: sumPrices(ativos),
      hint: "assinaturas dentro do prazo",
      bg: "var(--card-green-bg)",
      border: "var(--card-green)",
      color: "var(--card-green)",
      filter: "ativos",
    },
    {
      label: "Vencidos",
      count: vencidos.length,
      value: sumPrices(vencidos),
      hint: "precisam de renovação",
      bg: "var(--card-red-bg)",
      border: "var(--card-red)",
      color: "var(--card-red)",
      filter: "vencidos",
    },
    {
      label: "Total de Clientes",
      count: regular.length,
      value: sumPrices(regular),
      hint: testCount > 0 ? `+ ${testCount} de teste (aba Testes)` : "sem clientes de teste",
      bg: "var(--card-blue-bg)",
      border: "var(--card-blue)",
      color: "var(--card-blue)",
      filter: "todos",
    },
    {
      label: "Servidores",
      count: data.servers.length,
      value: null,
      hint: data.servers.length === 1 ? "painel cadastrado" : "painéis cadastrados",
      bg: "var(--card-slate-bg)",
      border: "var(--card-slate)",
      color: "var(--card-slate)",
      filter: "todos",
    },
  ];

  return (
    <section aria-label="Dashboard" className="mt-5 space-y-5 lg:mt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-extrabold">Dashboard</h2>
          <p className="mt-0.5 text-sm text-[var(--dim)]">Visão geral do sistema, calculada dos seus clientes, planos e pagamentos cadastrados.</p>
        </div>
        <button
          type="button"
          className={btnGhost}
          aria-pressed={hideValues}
          onClick={() => setHideValues((v) => !v)}
        >
          {hideValues ? "Mostrar valores" : "Ocultar valores"}
        </button>
      </div>

      <div className="relative">
        <label htmlFor="dash-search" className={labelCls}>Buscar cliente</label>
        <input
          id="dash-search"
          className={inputCls}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onShowClients("todos", query.trim());
            }
          }}
          placeholder="Busque por nome ou usuário IPTV…"
          autoComplete="off"
        />
        {results.length > 0 && (
          <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-lg">
            {results.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[var(--surface2)]"
                  onClick={() => onShowClients("todos", c.name)}
                >
                  <span>
                    <strong>{c.name}</strong>{" "}
                    <span className="font-mono text-sm text-[var(--dim)]">{c.iptvUser}</span>
                    {c.isTest && <span className="ml-2 rounded-full bg-[var(--surface2)] px-2 py-0.5 text-xs font-bold">TESTE</span>}
                  </span>
                  <span className="text-sm text-[var(--dim)]">vence {fmtDate(c.expiresAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {cards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => (card.label === "Servidores" ? onNavigate("servidores") : onShowClients(card.filter))}
            aria-label={`${card.label}: ${card.count}. Abrir a lista correspondente.`}
            className="rounded-2xl border-2 p-4 text-left"
            style={{ background: card.bg, borderColor: card.border }}
          >
            <span className="text-sm font-bold" style={{ color: card.color }}>
              {card.label}
            </span>
            <span className="mt-1 block font-display text-4xl font-extrabold leading-none text-[var(--text)]">
              {card.count}
            </span>
            {card.value != null && (
              <span className="mt-1.5 block text-sm font-semibold text-[var(--text)]">{money(card.value)}</span>
            )}
            <span className="mt-0.5 block text-xs text-[var(--dim)]">{card.hint}</span>
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold">$ Receita x Custo</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Receita: pagamentos reais aprovados no Mercado Pago. Custo: despesas que você lança em Transações
          + custo dos créditos das renovações aplicadas (custo por crédito do servidor × créditos do plano,
          multiplicado pelas telas do cliente quando o servidor cobra por telas). Lucro = receita − custo.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {periods.map((period) => {
            const receita = revenueInPeriod(data.payments, period.key);
            const custo = costInPeriod(data.expenses, period.key) + creditCostInPeriod(data, period.key);
            const lucro = receita - custo;
            return (
              <div key={period.key} className="rounded-xl bg-[var(--surface2)] p-4">
                <p className="font-display font-bold">$ {period.label}</p>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-[var(--dim)]">↗ Receita</dt>
                    <dd className="font-bold text-[var(--card-green)]">{money(receita)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-[var(--dim)]">↘ Custo</dt>
                    <dd className="font-bold text-[var(--card-red)]">{money(custo)}</dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-[var(--border)] pt-2">
                    <dt className="font-semibold">Lucro</dt>
                    <dd className={`font-display font-extrabold ${lucro < 0 ? "text-[var(--card-red)]" : "text-[var(--card-blue)]"}`}>
                      {money(lucro)}
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold">Vencimentos</h3>
        {!hasDue && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Nenhum cliente vencido nem vencendo nos próximos 7 dias. Quando houver, eles aparecem aqui com o botão de renovar.
          </p>
        )}
        <div className="mt-3 space-y-5">
          {dueGroups
            .filter((g) => g.items.length > 0)
            .map((group) => (
              <div key={group.title}>
                <p className="text-sm font-bold uppercase tracking-wide text-[var(--dim)]">
                  {group.title} ({group.items.length})
                </p>
                <ul className="mt-2 space-y-2">
                  {group.items.map((c) => {
                    const left = daysLeft(c.expiresAt);
                    return (
                      <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--surface2)] px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold">
                            {c.name}
                            {c.isTest && <span className="ml-2 rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs font-bold">TESTE</span>}
                          </p>
                          <p className="text-sm text-[var(--dim)]">
                            {c.planName ?? "Sem plano"} • {money(c.effectivePriceCents)} •{" "}
                            {left < 0 ? `venceu em ${fmtDate(c.expiresAt)}` : left === 0 ? "vence hoje" : `vence ${fmtDate(c.expiresAt)}`}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <a
                            href={invoiceHash(c)}
                            className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-ink)]"
                            aria-label={`Renovar ${c.name} — abrir a página da fatura`}
                          >
                            Renovar / abrir fatura
                          </a>
                          {c.whatsapp && (
                            <a
                              href={waLink(
                                c.whatsapp,
                                withInvoiceLink(
                                  renderMsg(data.warnMessage, {
                                    nome: c.name,
                                    usuario: c.iptvUser,
                                    vencimento: fmtDate(c.expiresAt),
                                    dias: c.planDays,
                                    valor: brl(c.effectivePriceCents),
                                    plano: c.planName,
                                    link: invoiceUrl(c, data.publicBaseUrl),
                                  }),
                                  c,
                                  data.publicBaseUrl,
                                ),
                              )}
                              target="_blank"
                              rel="noreferrer"
                              className={btnGhost}
                              aria-label={`Enviar aviso de vencimento com o link da fatura no WhatsApp de ${c.name}`}
                            >
                              Avisar no WhatsApp
                            </a>
                          )}
                          <button
                            type="button"
                            className={btnGhost}
                            onClick={() => onShowClients("todos", c.name)}
                            aria-label={`Ver ${c.name} na lista de clientes`}
                          >
                            Ver cliente
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </div>
      </div>

      <IntegrationStatus data={data} />
    </section>
  );
}

/* ---------------- Vendas ---------------- */

function SalesTab({ data }: { data: State }) {
  const sales = data.payments.filter(isRevenue);
  const total = sales.reduce((s, p) => s + p.amountCents, 0);
  const appliedCount = sales.filter((p) => p.status === "aprovado").length;
  const pendingCount = sales.filter((p) => p.status === "aprovado_pendente_painel").length;

  return (
    <section aria-label="Vendas" className="mt-5 space-y-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Vendas</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Pagamentos reais aprovados no Mercado Pago (modo ao vivo). Validações e testes não entram aqui.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Total vendido</p>
          <p className="mt-1 font-display text-2xl font-extrabold">{brl(total)}</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Renovações concluídas</p>
          <p className="mt-1 font-display text-2xl font-extrabold">{appliedCount}</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Aguardando o painel</p>
          <p className="mt-1 font-display text-2xl font-extrabold">{pendingCount}</p>
        </div>
      </div>

      <div>
        <h3 className="font-display text-lg font-bold">Pagamentos aprovados ({sales.length})</h3>
        <ul className="mt-3 space-y-3">
          {sales.map((p) => (
            <li key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-display font-bold">{p.clientName}</p>
                  <p className="text-sm text-[var(--dim)]">
                    {brl(p.amountCents)} • {p.days} dias • {p.credits} crédito{p.credits > 1 ? "s" : ""} •{" "}
                    {new Date(p.createdAt).toLocaleString("pt-BR")}
                    {p.couponCode ? ` • cupom ${p.couponCode} (−${brl(p.discountCents)})` : ""}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${p.status === "aprovado" ? "bg-[var(--ok-bg)] text-[var(--accent)]" : "bg-[var(--warn-bg)] text-[var(--warn)]"}`}
                >
                  {p.status === "aprovado" ? "Renovação aplicada" : "Aprovado — extensão pendente no painel"}
                </span>
              </div>
              {p.status === "aprovado_pendente_painel" && (
                <p className="mt-2 text-sm text-[var(--warn)]">
                  O dinheiro foi confirmado, mas a extensão deste usuário no painel ainda não aconteceu e nenhum crédito foi dado como gasto.
                </p>
              )}
            </li>
          ))}
        </ul>
        {sales.length === 0 && (
          <p className="mt-4 text-center text-[var(--dim)]">
            Nenhuma venda aprovada ainda. Quando um cliente pagar o Pix da fatura com o modo ao vivo ligado, a venda aparece aqui.
          </p>
        )}
      </div>

      <HistoryTab data={data} />
    </section>
  );
}

/* ---------------- Testes ---------------- */

function TestsTab({
  data,
  onShowClients,
}: {
  data: State;
  onShowClients: (filter: ClientFilter, search?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });

  const testClients = data.clients.filter((c) => c.isTest);
  const validationPayments = data.payments.filter((p) => p.mode === "validacao");

  const create = useMutation({
    mutationFn: (clientId: number) => api.createPix({ clientId, mode: "validacao" }),
    onSuccess: (p) => {
      setMsg(p.detail || null);
      invalidate();
    },
    onError: (e) => setMsg(String(e)),
  });
  const check = useMutation({
    mutationFn: (id: number) => api.checkPaymentStatus({ paymentId: id }),
    onSuccess: (r) => {
      setMsg(r.detail);
      invalidate();
    },
    onError: (e) => setMsg(String(e)),
  });
  const simulate = useMutation({
    mutationFn: (id: number) => api.simulatePaymentApproved({ paymentId: id }),
    onSuccess: (r) => {
      setMsg(r.detail);
      invalidate();
    },
    onError: (e) => setMsg(String(e)),
  });

  return (
    <section aria-label="Testes" className="mt-5 space-y-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Testes</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--dim)]">
          Área separada das vendas de verdade. Clientes marcados como <strong>teste</strong> no cadastro ficam fora dos
          cartões do Dashboard, e as cobranças de validação usam o ambiente de Teste do Mercado Pago:{" "}
          <strong>nunca chamam o painel, nunca alteram o vencimento real e nunca consomem crédito</strong>.
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold">Clientes de teste ({testClients.length})</h3>
        <ul className="mt-3 space-y-2">
          {testClients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--surface2)] px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {c.name} <span className="font-mono text-sm font-normal text-[var(--dim)]">{c.iptvUser}</span>
                </p>
                <p className="text-sm text-[var(--dim)]">
                  {c.planName ?? "Sem plano"} • {brl(c.effectivePriceCents)} • vence {fmtDate(c.expiresAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btnGhost}
                  disabled={c.planId == null || create.isPending || data.mpEnvironment !== "teste"}
                  onClick={() => create.mutate(c.id)}
                  aria-label={`Gerar Pix de validação para o cliente de teste ${c.name}`}
                >
                  Gerar Pix de validação
                </button>
                <a href={invoiceHash(c)} className={btnGhost}>
                  Abrir fatura
                </a>
                <button type="button" className={btnGhost} onClick={() => onShowClients("testes", c.name)}>
                  Ver em Clientes
                </button>
              </div>
            </li>
          ))}
        </ul>
        {testClients.length === 0 && (
          <p className="mt-3 text-sm text-[var(--dim)]">
            Nenhum cliente de teste ainda. Para criar um, cadastre o cliente normalmente na aba Clientes e marque a opção
            “Cliente de teste” no formulário.
          </p>
        )}
        {data.mpEnvironment !== "teste" && (
          <p className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn)]">
            A geração de Pix de validação fica bloqueada enquanto o ambiente salvo do Mercado Pago for Produção
            (Integração Pagamento), para não criar um Pix pagável que não renovaria conta nenhuma.
          </p>
        )}
      </div>

      {msg && <p className="rounded-lg bg-[var(--surface2)] px-3 py-2 text-sm">{msg}</p>}

      <div>
        <h3 className="font-display text-lg font-bold">Cobranças de validação ({validationPayments.length})</h3>
        <ul className="mt-3 space-y-3">
          {validationPayments.map((p) => (
            <li key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-display font-bold">{p.clientName}</p>
                  <p className="text-sm text-[var(--dim)]">
                    {brl(p.amountCents)} • {p.days} dias • {new Date(p.createdAt).toLocaleString("pt-BR")}
                    {p.couponCode ? ` • cupom ${p.couponCode} (−${brl(p.discountCents)})` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-[var(--surface2)] px-3 py-1 text-xs font-bold">
                  VALIDAÇÃO • {paymentStatusLabel(p.status)}
                </span>
              </div>
              {p.detail && <p className="mt-2 text-sm text-[var(--dim)]">{p.detail}</p>}
              {p.wouldExpireAt && (
                <p className="mt-1 text-sm">
                  Novo vencimento que seria aplicado (não foi): <strong>{fmtDate(p.wouldExpireAt)}</strong>
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {p.status === "pendente" && p.mpPaymentId && (
                  <button type="button" className={btnGhost} disabled={check.isPending} onClick={() => check.mutate(p.id)}>
                    Verificar no Mercado Pago
                  </button>
                )}
                {p.status !== "aprovado" && (
                  <button type="button" className={btnGhost} disabled={simulate.isPending} onClick={() => simulate.mutate(p.id)}>
                    Simular confirmação — sem crédito
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {validationPayments.length === 0 && (
          <p className="mt-4 text-center text-[var(--dim)]">Nenhuma cobrança de validação ainda.</p>
        )}
      </div>
    </section>
  );
}

/* ---------------- Transações ---------------- */

function TransactionsTab({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState("");
  const [amountText, setAmountText] = useState("");
  const [spentOn, setSpentOn] = useState(localDayKey(new Date()));
  const [editing, setEditing] = useState<Expense | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });

  const save = useMutation({
    mutationFn: () =>
      api.saveExpense({
        id: editing?.id,
        description: description.trim(),
        amountCents: parseBRL(amountText) ?? 0,
        spentOn,
      }),
    onSuccess: () => {
      setDescription("");
      setAmountText("");
      setEditing(null);
      setSavedMsg("Despesa salva ✓ Ela já entra no Custo do Dashboard.");
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteExpense({ id }),
    onSuccess: invalidate,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedMsg(null);
    if (!description.trim()) {
      setError("Descreva a despesa (ex.: créditos do painel, servidor, divulgação).");
      return;
    }
    if (parseBRL(amountText) == null || (parseBRL(amountText) ?? 0) <= 0) {
      setError("Valor da despesa inválido. Use o formato 50,00.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) {
      setError("Escolha a data da despesa.");
      return;
    }
    save.mutate();
  }

  function startEdit(expense: Expense) {
    setEditing(expense);
    setDescription(expense.description);
    setAmountText((expense.amountCents / 100).toFixed(2).replace(".", ","));
    setSpentOn(expense.spentOn);
    setError(null);
    setSavedMsg(null);
  }

  const receitaMes = revenueInPeriod(data.payments, "mensal");
  const custoMes = costInPeriod(data.expenses, "mensal");

  type Row = {
    key: string;
    dateLabel: string;
    sortKey: string;
    title: string;
    detail: string;
    amount: number;
    kind: "receita" | "custo" | "cobranca";
  };
  const rows: Row[] = [
    ...data.payments.map<Row>((p) => ({
      key: `p-${p.id}`,
      dateLabel: new Date(p.createdAt).toLocaleDateString("pt-BR"),
      sortKey: p.createdAt,
      title: p.clientName,
      detail: `${p.mode === "producao" ? "Ao vivo" : "Validação"} • ${paymentStatusLabel(p.status)} • ${p.days} dias${p.couponCode ? ` • cupom ${p.couponCode}` : ""}`,
      amount: p.amountCents,
      kind: isRevenue(p) ? "receita" : "cobranca",
    })),
    ...data.expenses.map<Row>((e) => ({
      key: `e-${e.id}`,
      dateLabel: fmtDate(`${e.spentOn}T12:00:00`),
      sortKey: `${e.spentOn}T23:59:59`,
      title: e.description,
      detail: "Despesa lançada por você",
      amount: -e.amountCents,
      kind: "custo",
    })),
  ].sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  return (
    <section aria-label="Transações" className="mt-5 space-y-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Transações</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Tudo que entrou e saiu: cobranças do Mercado Pago e as despesas que você lança. É daqui que sai o Custo do Dashboard.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Receita do mês</p>
          <p className="mt-1 font-display text-xl font-extrabold text-[var(--card-green)]">{brl(receitaMes)}</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Custo do mês</p>
          <p className="mt-1 font-display text-xl font-extrabold text-[var(--card-red)]">{brl(custoMes)}</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Lucro do mês</p>
          <p className={`mt-1 font-display text-xl font-extrabold ${receitaMes - custoMes < 0 ? "text-[var(--card-red)]" : "text-[var(--card-blue)]"}`}>
            {brl(receitaMes - custoMes)}
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Lançar despesa">
        <h3 className="font-display text-lg font-bold">{editing ? "Editar despesa" : "Lançar uma despesa"}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <label htmlFor="exp-desc" className={labelCls}>Descrição</label>
            <input id="exp-desc" className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: créditos do painel" />
          </div>
          <div>
            <label htmlFor="exp-amount" className={labelCls}>Valor (R$)</label>
            <input id="exp-amount" className={inputCls} value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="50,00" inputMode="decimal" />
          </div>
          <div>
            <label htmlFor="exp-date" className={labelCls}>Data</label>
            <input id="exp-date" type="date" className={inputCls} value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          </div>
        </div>
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        {savedMsg && <p className="text-sm font-semibold text-[var(--accent)]">{savedMsg}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btnPrimary} disabled={save.isPending}>
            {save.isPending ? "Salvando…" : editing ? "Salvar alterações" : "Lançar despesa"}
          </button>
          {editing && (
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setEditing(null);
                setDescription("");
                setAmountText("");
              }}
            >
              Cancelar edição
            </button>
          )}
        </div>
      </form>

      <div>
        <h3 className="font-display text-lg font-bold">Movimentações ({rows.length})</h3>
        <ul className="mt-3 space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{r.title}</p>
                <p className="text-sm text-[var(--dim)]">
                  {r.dateLabel} • {r.detail}
                </p>
              </div>
              <span
                className={`font-display font-extrabold ${r.kind === "receita" ? "text-[var(--card-green)]" : r.kind === "custo" ? "text-[var(--card-red)]" : "text-[var(--dim)]"}`}
              >
                {r.kind === "custo" ? "−" : r.kind === "receita" ? "+" : ""}
                {brl(Math.abs(r.amount))}
              </span>
            </li>
          ))}
        </ul>
        {rows.length === 0 && (
          <p className="mt-4 text-center text-[var(--dim)]">Nenhuma movimentação ainda. Gere uma cobrança ou lance a primeira despesa.</p>
        )}
      </div>

      {data.expenses.length > 0 && (
        <div>
          <h3 className="font-display text-lg font-bold">Despesas lançadas ({data.expenses.length})</h3>
          <ul className="mt-3 space-y-2">
            {data.expenses.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--surface2)] px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{e.description}</p>
                  <p className="text-sm text-[var(--dim)]">{fmtDate(`${e.spentOn}T12:00:00`)}</p>
                </div>
                <span className="font-display font-bold text-[var(--card-red)]">−{brl(e.amountCents)}</span>
                <button type="button" className={btnGhost} onClick={() => startEdit(e)}>
                  Editar
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  aria-label={`Excluir despesa ${e.description}`}
                  disabled={del.isPending}
                  onClick={() => del.mutate(e.id)}
                >
                  Excluir
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ---------------- Cupons ---------------- */

function CouponsTab({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [code, setCode] = useState("");
  const [percent, setPercent] = useState("10");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });

  const save = useMutation({
    mutationFn: () =>
      api.saveCoupon({
        id: editing?.id,
        code: code.trim().toUpperCase(),
        percentOff: Number(percent),
        active,
      }),
    onSuccess: () => {
      setEditing(null);
      setCode("");
      setPercent("10");
      setActive(true);
      setSavedMsg("Cupom salvo ✓ O cliente já pode digitar o código na página da fatura.");
      invalidate();
    },
    onError: (e) => setError(String(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteCoupon({ id }),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: (c: Coupon) => api.saveCoupon({ id: c.id, code: c.code, percentOff: c.percentOff, active: !c.active }),
    onSuccess: invalidate,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedMsg(null);
    const p = Number(percent);
    if (code.trim().length < 2) {
      setError("O código do cupom precisa de pelo menos 2 caracteres (ex.: VOLTE10).");
      return;
    }
    if (!Number.isInteger(p) || p < 1 || p > 90) {
      setError("O desconto precisa ser um número inteiro de 1 a 90 (por cento).");
      return;
    }
    save.mutate();
  }

  function startEdit(c: Coupon) {
    setEditing(c);
    setCode(c.code);
    setPercent(String(c.percentOff));
    setActive(c.active);
    setError(null);
    setSavedMsg(null);
  }

  return (
    <section aria-label="Cupons" className="mt-5 space-y-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Cupons</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--dim)]">
          Crie códigos de desconto em porcentagem. O cliente digita o código na página da fatura, antes de gerar o Pix,
          e o valor cobrado já sai com o desconto. O desconto fica registrado na cobrança, em Vendas e Transações.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Criar ou editar cupom">
        <h3 className="font-display text-lg font-bold">{editing ? `Editar cupom ${editing.code}` : "Novo cupom"}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="cp-code" className={labelCls}>Código</label>
            <input
              id="cp-code"
              className={`${inputCls} uppercase`}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Ex.: VOLTE10"
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="cp-percent" className={labelCls}>Desconto (%)</label>
            <input id="cp-percent" className={inputCls} value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="numeric" placeholder="10" />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-5 w-5" aria-label="Cupom ativo" />
              Cupom ativo
            </label>
          </div>
        </div>
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        {savedMsg && <p className="text-sm font-semibold text-[var(--accent)]">{savedMsg}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btnPrimary} disabled={save.isPending}>
            {save.isPending ? "Salvando…" : editing ? "Salvar alterações" : "Criar cupom"}
          </button>
          {editing && (
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setEditing(null);
                setCode("");
                setPercent("10");
                setActive(true);
              }}
            >
              Cancelar edição
            </button>
          )}
        </div>
      </form>

      <ul className="space-y-3">
        {data.coupons.map((c) => {
          const uses = data.payments.filter((p) => p.couponCode === c.code);
          const totalDiscount = uses.reduce((s, p) => s + p.discountCents, 0);
          return (
            <li key={c.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-display text-lg font-extrabold tracking-wide">{c.code}</p>
                  <p className="text-sm text-[var(--dim)]">
                    {c.percentOff}% de desconto • usado {uses.length}x{uses.length > 0 ? ` • ${brl(totalDiscount)} em descontos` : ""}
                  </p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-bold ${c.active ? "bg-[var(--ok-bg)] text-[var(--accent)]" : "bg-[var(--surface2)] text-[var(--dim)]"}`}>
                  {c.active ? "Ativo" : "Inativo"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={btnGhost} disabled={toggle.isPending} onClick={() => toggle.mutate(c)}>
                  {c.active ? "Desativar" : "Ativar"}
                </button>
                <button type="button" className={btnGhost} onClick={() => startEdit(c)}>
                  Editar
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  aria-label={`Excluir cupom ${c.code}`}
                  disabled={del.isPending}
                  onClick={() => del.mutate(c.id)}
                >
                  Excluir
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {data.coupons.length === 0 && (
        <p className="text-center text-[var(--dim)]">Nenhum cupom ainda. Crie o primeiro no formulário acima.</p>
      )}
    </section>
  );
}

/* ---------------- Indicação de Clientes ---------------- */

function ReferralsTab({
  data,
  onShowClients,
}: {
  data: State;
  onShowClients: (filter: ClientFilter, search?: string) => void;
}) {
  const referred = data.clients.filter((c) => c.referredBy && c.referredBy.trim() !== "");
  const counts = new Map<string, number>();
  for (const c of referred) {
    const name = c.referredBy!.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const clientNames = new Set(data.clients.map((c) => c.name.trim().toLowerCase()));

  return (
    <section aria-label="Indicação de clientes" className="mt-5 space-y-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Indicação de Clientes</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--dim)]">
          Quem trouxe quem. A indicação é registrada no cadastro do cliente, no campo “Quem indicou este cliente”.
          Aqui você vê o ranking de quem mais indica e a lista de clientes que chegaram por indicação.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Clientes vindos por indicação</p>
          <p className="mt-1 font-display text-3xl font-extrabold">{referred.length}</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--dim)]">Pessoas que já indicaram</p>
          <p className="mt-1 font-display text-3xl font-extrabold">{ranking.length}</p>
        </div>
      </div>

      {ranking.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="font-display text-lg font-bold">Quem mais indica</h3>
          <ul className="mt-3 space-y-2">
            {ranking.map(([name, count]) => (
              <li key={name} className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--surface2)] px-3 py-2.5">
                <p className="min-w-0 flex-1 font-semibold">
                  {name}
                  {!clientNames.has(name.toLowerCase()) && (
                    <span className="ml-2 text-xs font-medium text-[var(--dim)]">(não é cliente cadastrado)</span>
                  )}
                </p>
                <span className="rounded-full bg-[var(--surface)] px-3 py-1 text-sm font-bold">
                  {count} indicação{count > 1 ? "ões" : ""}
                </span>
                {clientNames.has(name.toLowerCase()) && (
                  <button type="button" className={btnGhost} onClick={() => onShowClients("todos", name)}>
                    Ver indicador
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="font-display text-lg font-bold">Clientes indicados ({referred.length})</h3>
        <ul className="mt-3 space-y-2">
          {referred.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{c.name}</p>
                <p className="text-sm text-[var(--dim)]">
                  Indicado por <strong className="text-[var(--text)]">{c.referredBy}</strong> • {c.planName ?? "Sem plano"} • vence {fmtDate(c.expiresAt)}
                </p>
              </div>
              <a href={invoiceHash(c)} className={btnGhost}>
                Abrir fatura
              </a>
              <button type="button" className={btnGhost} onClick={() => onShowClients("todos", c.name)}>
                Ver cliente
              </button>
            </li>
          ))}
        </ul>
        {referred.length === 0 && (
          <p className="mt-4 text-center text-[var(--dim)]">
            Nenhuma indicação registrada ainda. Ao cadastrar ou editar um cliente, preencha “Quem indicou este cliente”
            com o nome de quem indicou — a lista aparece aqui automaticamente.
          </p>
        )}
      </div>
    </section>
  );
}

/* ---------------- Integrações ---------------- */

type IntegrationSub = "paineis" | "mensagens" | "ajustes";

function IntegrationsTab({ data }: { data: State }) {
  const [sub, setSub] = useState<IntegrationSub>("paineis");
  const subs: { id: IntegrationSub; label: string }[] = [
    { id: "paineis", label: "Painéis IPTV" },
    { id: "mensagens", label: "Mensagens" },
    { id: "ajustes", label: "Ajustes da fatura" },
  ];
  return (
    <section aria-label="Integrações" className="mt-5 lg:mt-8">
      <h2 className="font-display text-2xl font-extrabold">Integrações</h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Gerencie suas integrações com painéis IPTV — é aqui que você adiciona o servidor/painel
        que depois aparece no cadastro de Servidor. Pagamento é só Mercado Pago, na aba Integração Pagamento,
        e o WhatsApp é só por QR Code, na aba WhatsApp.
      </p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Áreas das integrações">
        {subs.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={sub === s.id}
            onClick={() => setSub(s.id)}
            className={
              sub === s.id
                ? "rounded-full bg-[var(--accent)] px-4 py-2 font-semibold text-[var(--accent-ink)]"
                : "rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 font-medium"
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      {sub === "paineis" && <PanelsIntegration data={data} />}
      {sub === "mensagens" && <MessagesTab data={data} />}
      {sub === "ajustes" && <SettingsTab data={data} />}
    </section>
  );
}

/* ---------------- Integrações com painéis (WPlay) ---------------- */

function PanelsIntegration({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showProviders, setShowProviders] = useState(false);
  const [editing, setEditing] = useState<Integration | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [panelUser, setPanelUser] = useState("");
  const [panelPass, setPanelPass] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Record<number, string>>({});
  const [linkFor, setLinkFor] = useState<number | null>(null);
  const [linkServerId, setLinkServerId] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });

  const save = useMutation({
    mutationFn: () =>
      api.saveIntegration({
        id: editing?.id,
        name: name.trim(),
        url: url.trim(),
        panelUser: panelUser.trim(),
        panelPass,
      }),
    onSuccess: () => {
      setEditing(undefined);
      setPanelPass("");
      setFormError(null);
      invalidate();
    },
    onError: (e) => setFormError(String(e)),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteIntegration({ id }),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: (id: number) => api.testIntegration({ id }),
    onSuccess: (r, id) => {
      setMsgs((prev) => ({ ...prev, [id]: r.detail }));
      invalidate();
    },
    onError: (e, id) => setMsgs((prev) => ({ ...prev, [id]: String(e) })),
  });
  const info = useMutation({
    mutationFn: (id: number) => api.integrationInfo({ id }),
    onSuccess: (_r, id) => {
      setMsgs((prev) => ({ ...prev, [id]: "Informações do painel atualizadas no cartão abaixo." }));
      invalidate();
    },
    onError: (e, id) => setMsgs((prev) => ({ ...prev, [id]: String(e) })),
  });
  const syncIds = useMutation({
    mutationFn: (id: number) => api.syncIntegrationIds({ id }),
    onSuccess: (r, id) => {
      setMsgs((prev) => ({ ...prev, [id]: r.detail }));
      invalidate();
    },
    onError: (e, id) => setMsgs((prev) => ({ ...prev, [id]: String(e) })),
  });
  const link = useMutation({
    mutationFn: (args: { integrationId: number; serverId: number }) => api.linkIntegration(args),
    onSuccess: (r, args) => {
      setMsgs((prev) => ({ ...prev, [args.integrationId]: r.detail }));
      setLinkFor(null);
      invalidate();
    },
    onError: (e) => setMsgs((prev) => ({ ...prev, [-1]: String(e) })),
  });

  function openNew() {
    setEditing(null);
    setName("");
    setUrl("");
    setPanelUser("");
    setPanelPass("");
    setFormError(null);
    setShowProviders(false);
  }
  function openEdit(i: Integration) {
    setEditing(i);
    setName(i.name);
    setUrl(i.url);
    setPanelUser(i.panelUser);
    setPanelPass("");
    setFormError(null);
  }

  const q = search.trim().toLowerCase();
  const visible = data.integrations.filter(
    (i) => !q || i.name.toLowerCase().includes(q) || i.url.toLowerCase().includes(q) || i.panelUser.toLowerCase().includes(q),
  );

  const statusBadge = (i: Integration) =>
    i.status === "ativo" ? (
      <span className="rounded-full bg-[var(--ok-bg)] px-2.5 py-1 text-xs font-bold text-[var(--card-green)]">Ativo</span>
    ) : i.status === "falhou" ? (
      <span className="rounded-full bg-[var(--danger-bg)] px-2.5 py-1 text-xs font-bold text-[var(--danger)]">Falhou no teste</span>
    ) : (
      <span className="rounded-full bg-[var(--warn-bg)] px-2.5 py-1 text-xs font-bold text-[var(--warn)]">Não testado</span>
    );

  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-52 flex-1">
          <label htmlFor="integrations-search" className="sr-only">Buscar integração por nome, URL ou usuário</label>
          <input
            id="integrations-search"
            className={inputCls}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar integração…"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)]"
          aria-expanded={showProviders}
          onClick={() => setShowProviders((v) => !v)}
        >
          Adicionar Integração
        </button>
      </div>

      {showProviders && editing === undefined && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Escolha o painel para integrar">
          <p className="font-display font-bold">Qual painel você quer integrar?</p>
          <p className="mt-1 text-sm text-[var(--dim)]">Por enquanto só o WPlay está disponível.</p>
          <button
            type="button"
            className="mt-3 flex w-full max-w-xs flex-col items-start gap-1 rounded-xl border-2 border-[var(--accent)] bg-[var(--surface2)] p-4 text-left"
            onClick={openNew}
            aria-label="Adicionar integração WPlay"
          >
            <span className="font-display text-lg font-extrabold">WPlay</span>
            <span className="text-sm text-[var(--dim)]">Painel IPTV — nome, URL do servidor, usuário e senha do painel.</span>
          </button>
        </div>
      )}

      {editing !== undefined && (
        <form
          className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
          aria-label={editing ? "Editar integração WPlay" : "Nova integração WPlay"}
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            if (!name.trim() || !url.trim() || !panelUser.trim() || (!editing && !panelPass)) {
              setFormError("Preencha nome, URL do servidor, usuário e senha do painel.");
              return;
            }
            save.mutate();
          }}
        >
          <h3 className="font-display text-lg font-bold">{editing ? "Editar integração — WPlay" : "Nova integração — WPlay"}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="int-name" className={labelCls}>Nome da integração *</label>
              <input id="int-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Meu painel principal" autoComplete="off" required />
            </div>
            <div>
              <label htmlFor="int-url" className={labelCls}>URL do servidor *</label>
              <input id="int-url" className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://painel.exemplo.com" autoComplete="off" required />
            </div>
            <div>
              <label htmlFor="int-user" className={labelCls}>Usuário do painel *</label>
              <input id="int-user" className={inputCls} value={panelUser} onChange={(e) => setPanelUser(e.target.value)} autoComplete="off" required />
            </div>
            <div>
              <label htmlFor="int-pass" className={labelCls}>
                {editing ? "Senha do painel (em branco mantém a salva)" : "Senha do painel *"}
              </label>
              <input
                id="int-pass"
                type="password"
                className={inputCls}
                value={panelPass}
                onChange={(e) => setPanelPass(e.target.value)}
                placeholder={editing ? "•••••• salva no gestor — nunca exibida" : ""}
                autoComplete="off"
              />
              <p className="mt-1 text-sm text-[var(--dim)]">A senha fica salva no gestor e nunca volta para a tela.</p>
            </div>
          </div>
          {formError && <p className="text-sm font-medium text-[var(--danger)]" role="alert">{formError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)] disabled:opacity-50" disabled={save.isPending}>
              {save.isPending ? "Salvando…" : editing ? "Salvar alterações" : "Salvar integração"}
            </button>
            <button type="button" className={btnGhost} onClick={() => setEditing(undefined)}>
              Cancelar
            </button>
          </div>
          <p className="text-sm text-[var(--dim)]">
            Depois de salvar, use “Testar conexão” no cartão da integração. Ela também aparece no cadastro de
            Servidor, em Integração → Painel IPTV, para vincular testes e renovações automáticas.
          </p>
        </form>
      )}

      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display text-lg font-bold">Integrações Wplay</h3>
          <button type="button" className={btnGhost} onClick={openNew}>
            Adicionar
          </button>
        </div>
        {msgs[-1] && <p className="mt-2 text-sm font-medium text-[var(--danger)]" role="alert">{msgs[-1]}</p>}
        {visible.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-sm text-[var(--dim)]">
            {data.integrations.length === 0
              ? "Nenhuma integração cadastrada ainda. Toque em “Adicionar Integração” e escolha WPlay para cadastrar a sua."
              : "Nenhuma integração combina com a busca."}
          </p>
        ) : (
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            {visible.map((i) => (
              <article key={i.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-label={`Integração ${i.name}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-display text-lg font-bold">{i.name}</p>
                    <p className="text-sm text-[var(--dim)]">WPlay • usuário: {i.panelUser} • senha: {i.hasPass ? "salva (nunca exibida)" : "não salva"}</p>
                  </div>
                  {statusBadge(i)}
                </div>
                <a href={i.url} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-sm text-[var(--accent-bright)] underline">
                  {i.url}
                </a>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Criada em {new Date(i.createdAt).toLocaleDateString("pt-BR")}
                  {i.testedAt ? ` • último teste em ${new Date(i.testedAt).toLocaleString("pt-BR")}` : ""}
                </p>
                {i.testDetail && <p className="mt-1 text-sm">{i.testDetail}</p>}
                {i.panelInfo && (
                  <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface2)] p-3 font-sans text-sm">{i.panelInfo}</pre>
                )}
                {i.syncDetail && <p className="mt-1 text-sm text-[var(--dim)]">{i.syncDetail}</p>}
                {msgs[i.id] && <p className="mt-1 text-sm font-medium" role="status">{msgs[i.id]}</p>}

                {linkFor === i.id && (
                  <div className="mt-3 grid gap-2 rounded-xl bg-[var(--surface2)] p-3 sm:grid-cols-[1fr_auto]">
                    <div>
                      <label htmlFor={`link-server-${i.id}`} className={labelCls}>Vincular a qual servidor?</label>
                      <select id={`link-server-${i.id}`} className={inputCls} value={linkServerId} onChange={(e) => setLinkServerId(e.target.value)}>
                        <option value="">Selecione um servidor…</option>
                        {data.servers.map((sv) => (
                          <option key={sv.id} value={sv.id}>{sv.name}</option>
                        ))}
                      </select>
                      {data.servers.length === 0 && (
                        <p className="mt-1 text-sm text-[var(--warn)]">Nenhum servidor cadastrado ainda — cadastre um na aba Servidores primeiro.</p>
                      )}
                    </div>
                    <div className="flex items-end gap-2">
                      <button
                        type="button"
                        className={btnPrimary}
                        disabled={!linkServerId || link.isPending}
                        onClick={() => link.mutate({ integrationId: i.id, serverId: Number(linkServerId) })}
                      >
                        Confirmar vínculo
                      </button>
                      <button type="button" className={btnGhost} onClick={() => setLinkFor(null)}>
                        Fechar
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={btnGhost} disabled={info.isPending} onClick={() => info.mutate(i.id)} aria-label={`Ver informações do painel da integração ${i.name}`}>
                    Info Painel
                  </button>
                  <button type="button" className={btnGhost} disabled={syncIds.isPending} onClick={() => syncIds.mutate(i.id)} aria-label={`Sincronizar IDs da integração ${i.name}`}>
                    Sync IDs
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    aria-expanded={linkFor === i.id}
                    onClick={() => { setLinkFor(linkFor === i.id ? null : i.id); setLinkServerId(""); }}
                    aria-label={`Vincular a integração ${i.name} a um servidor`}
                  >
                    Vincular
                  </button>
                  <button type="button" className={btnGhost} disabled={test.isPending} onClick={() => test.mutate(i.id)} aria-label={`Testar conexão da integração ${i.name}`}>
                    {test.isPending ? "Testando…" : "Testar conexão"}
                  </button>
                  <button type="button" className={btnPrimary} onClick={() => openEdit(i)}>
                    Editar
                  </button>
                  <button type="button" className={btnGhost} onClick={() => del.mutate(i.id)} aria-label={`Excluir integração ${i.name}`}>
                    Excluir
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Hospedagem fora do Muse (Render gratuito) ---------------- */

const RENDER_DOCS_URL = "https://render.com/docs/free";

const RENDER_YAML = `# Gestor IPTV — deploy no Render (Blueprint)
# No Render: New → Blueprint → conecte o repositório do projeto.
# NENHUM segredo fica neste arquivo: DATABASE_URL vem do banco
# criado no Render e SESSION_SECRET é gerado pelo próprio Render.
services:
  - type: web
    name: gestor-iptv
    runtime: docker
    plan: free
    dockerfilePath: ./Dockerfile
    envVars:
      - key: NODE_ENV
        value: production
      - key: PUBLIC_BASE_URL
        sync: false # preencha no painel: https://gestor-iptv.onrender.com
      - key: DATABASE_URL
        fromDatabase:
          name: gestor-iptv-db
          property: connectionString
      - key: SESSION_SECRET
        generateValue: true
databases:
  - name: gestor-iptv-db
    plan: free
`;

const DOCKERFILE = `# Gestor IPTV — imagem do Web Service no Render
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
ENV NODE_ENV=production
# O Render define a porta na variável PORT em tempo de execução.
# Serve as páginas compiladas (client/dist) com o servidor estático
# do projeto; ao exportar o projeto completo com servidor próprio,
# troque este CMD pelo entrypoint dele.
CMD ["bun", "hospedagem-render/static-server.ts"]
`;

const ENV_EXAMPLE = `# Copie para as Environment Variables do serviço no Render.
# NUNCA cole valores reais em arquivos do projeto nem em chats.
NODE_ENV=production
# Endereço público do seu serviço (o Render mostra na página do serviço):
PUBLIC_BASE_URL=https://gestor-iptv.onrender.com
# URL do banco Postgres criado no Render (o painel preenche sozinho
# quando o banco é ligado ao serviço pelo render.yaml):
DATABASE_URL=
# Chave de sessão: deixe o Render gerar (generateValue no render.yaml).
SESSION_SECRET=
# Tokens do Mercado Pago e senhas de painel NÃO vão aqui:
# eles continuam salvos dentro do gestor, nas abas próprias.
`;

function HostingSection({ data }: { data: State }) {
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(data.publicBaseUrl);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(data.publicBaseUrl);
  }, [data.publicBaseUrl]);

  const save = useMutation({
    mutationFn: () => api.saveHostingSettings({ publicBaseUrl: baseUrl.trim() }),
    onSuccess: (r) => {
      setFeedback(
        r.publicBaseUrl
          ? "Endereço público salvo ✓ A partir de agora, os links de fatura das mensagens usam este endereço — o cliente abre sem login do Muse."
          : "Endereço público apagado. Os links voltaram a usar o endereço do Muse (que pede login do Muse para quem abre).",
      );
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setFeedback(friendlyAuthError(e)),
  });

  const exampleClient = data.clients.find((c) => c.listState === "normal") ?? data.clients[0];
  const exampleLink = exampleClient
    ? invoiceUrl(exampleClient, baseUrl.trim() || data.publicBaseUrl)
    : null;

  const files: { name: string; content: string }[] = [
    { name: "render.yaml", content: RENDER_YAML },
    { name: "Dockerfile", content: DOCKERFILE },
    { name: ".env.example", content: ENV_EXAMPLE },
  ];

  return (
    <section
      aria-label="Hospedagem fora do Muse no Render"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h3 className="font-display text-lg font-bold">Hospedar fora do Muse — link da fatura público (Render gratuito)</h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Por que o link de hoje não abre para o cliente: este gestor roda dentro do Muse, e o endereço
        dele pede login do Muse — o cliente não tem esse login. Com a hospedagem no Render, o gestor
        ganha um <strong>endereço público próprio</strong>: o cliente toca no link da mensagem e cai
        direto na fatura dele, <strong>sem login nenhum</strong>. A fatura só abre com o código secreto
        do link daquele cliente — trocar o número ou o código na mão não abre a fatura de ninguém.
      </p>

      <div className="mt-4 rounded-xl bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn)]" role="note">
        <p className="font-bold">Limites do plano gratuito do Render (leia antes)</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>O site gratuito <strong>dorme depois de uns 15 minutos sem uso</strong>: a primeira abertura depois disso pode demorar cerca de 1 minuto. Avise os clientes para aguardar essa primeira abertura.</li>
          <li>O <strong>banco de dados gratuito tem prazo de expiração</strong>: depois dele, o Render pode apagar o banco. Para não perder clientes e cobranças, passe para um plano pago do banco antes do prazo ou guarde cópias dos dados.</li>
          <li>O gratuito serve para começar e testar o link. Quando o movimento crescer, o plano pago mantém o site sempre acordado.</li>
        </ul>
      </div>

      <div className="mt-4">
        <label htmlFor="hosting-public-url" className={labelCls}>
          Endereço público do gestor (depois do deploy no Render)
        </label>
        <input
          id="hosting-public-url"
          className={inputCls}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setFeedback(null);
          }}
          placeholder="https://gestor-iptv.onrender.com"
          inputMode="url"
          autoComplete="off"
        />
        <p className="mt-1 text-xs text-[var(--dim)]">
          É o endereço que o Render mostra na página do seu serviço (termina em .onrender.com). Salvando aqui,
          todos os links de fatura — no botão Fatura, em Enviar mensagem e nas mensagens da aba Mensagens —
          passam a usar este endereço na hora.
        </p>
        <button
          type="button"
          className={`${btnPrimary} mt-2`}
          disabled={save.isPending}
          aria-label="Salvar endereço público do gestor"
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Salvando…" : "Salvar endereço público"}
        </button>
        {feedback && (
          <p className="mt-2 text-sm font-medium" role="status">
            {feedback}
          </p>
        )}
        {exampleLink && (
          <div className="mt-3">
            <p className="text-sm font-semibold">Como fica o link da fatura (exemplo com {exampleClient?.name}):</p>
            <p className="mt-1 break-all rounded-lg bg-[var(--surface2)] px-3 py-2 font-mono text-xs">{exampleLink}</p>
          </div>
        )}
      </div>

      <div className="mt-5">
        <h4 className="font-display font-bold">Passo a passo da hospedagem no Render</h4>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-[var(--dim)]">
          <li>
            <strong className="text-[var(--text)]">Crie a conta no Render.</strong> Abra{" "}
            <a href={RENDER_DOCS_URL} target="_blank" rel="noreferrer" className="font-semibold text-[var(--accent-bright)] underline">
              Render — Deploy for Free
            </a>{" "}
            e crie a conta com seu e-mail (ou Google/GitHub). Nessa página o Render explica o plano gratuito.
          </li>
          <li>
            <strong className="text-[var(--text)]">Crie o banco de dados.</strong> No painel do Render: <em>New → Postgres</em>,
            escolha o plano <strong>Free</strong> e crie com o nome <span className="font-mono text-xs">gestor-iptv-db</span>.
            Você não precisa copiar a URL do banco para nenhum arquivo: o deploy liga o banco ao site sozinho
            (variável <span className="font-mono text-xs">DATABASE_URL</span>).
          </li>
          <li>
            <strong className="text-[var(--text)]">Suba o projeto.</strong> Coloque o código do gestor em um repositório
            (GitHub) com os arquivos <span className="font-mono text-xs">render.yaml</span>,{" "}
            <span className="font-mono text-xs">Dockerfile</span> e <span className="font-mono text-xs">.env.example</span>{" "}
            na raiz (o conteúdo deles está logo abaixo, para copiar). No Render: <em>New → Blueprint</em> e conecte o
            repositório — o <span className="font-mono text-xs">render.yaml</span> cria o site e o banco juntos, no plano Free.
          </li>
          <li>
            <strong className="text-[var(--text)]">Confira as variáveis de ambiente</strong> do serviço (aba Environment):
            <span className="font-mono text-xs"> PUBLIC_BASE_URL</span> com o endereço do serviço
            (ex.: <span className="font-mono text-xs">https://gestor-iptv.onrender.com</span>),
            <span className="font-mono text-xs"> DATABASE_URL</span> vinda do banco e
            <span className="font-mono text-xs"> SESSION_SECRET</span> gerada pelo Render.{" "}
            <strong>Nunca</strong> coloque token do Mercado Pago, senha de painel ou senha sua em arquivo do projeto —
            essas credenciais continuam salvas só dentro do gestor, nas abas próprias.
          </li>
          <li>
            <strong className="text-[var(--text)]">Aperte Deploy e espere a primeira publicação terminar.</strong> O Render
            mostra o endereço do serviço no topo da página dele — é um endereço terminado em .onrender.com.
          </li>
          <li>
            <strong className="text-[var(--text)]">Cole esse endereço no campo aqui em cima e salve.</strong> A partir daí,
            os links das mensagens já saem com o endereço público e o código secreto de cada cliente.
          </li>
          <li>
            <strong className="text-[var(--text)]">Teste o link como o cliente testa:</strong> abra uma janela anônima do
            navegador (ou outro celular, sem entrar no Muse), cole o link da fatura de um cliente e abra. A fatura
            dele tem que abrir direto, sem pedir login, com o plano e o valor dele e o botão de copiar a chave Pix.
            Se demorar na primeira abertura, é o site gratuito acordando — espere cerca de 1 minuto e tente de novo.
          </li>
        </ol>
      </div>

      <div className="mt-5 space-y-3">
        <h4 className="font-display font-bold">Arquivos de deploy (copie para a raiz do projeto)</h4>
        {files.map((f) => (
          <details key={f.name} className="rounded-xl border border-[var(--border)] bg-[var(--surface2)] p-3">
            <summary className="cursor-pointer font-mono text-sm font-bold">{f.name}</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--surface)] p-3 font-mono text-xs">{f.content}</pre>
            <button
              type="button"
              className={`${btnGhost} mt-2`}
              aria-label={`Copiar o conteúdo de ${f.name}`}
              onClick={async () => {
                if (await copyText(f.content)) setCopiedFile(f.name);
              }}
            >
              {copiedFile === f.name ? "Copiado ✓" : `Copiar ${f.name}`}
            </button>
          </details>
        ))}
        <p className="text-xs text-[var(--dim)]">
          Estes mesmos arquivos acompanham esta versão do gestor: render.yaml, Dockerfile, .env.example e o guia
          HOSPEDAGEM-RENDER.md estão na raiz do projeto e também na pasta hospedagem-render. Eles não contêm
          nenhum segredo: os valores reais das variáveis ficam só no painel do Render.
        </p>
      </div>
    </section>
  );
}

/* ---------------- Suporte ---------------- */

function SupportTab({
  data,
  onNavigate,
}: {
  data: State;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <section aria-label="Suporte" className="mt-5 space-y-5 lg:mt-8">
      <div>
        <h2 className="font-display text-2xl font-extrabold">Suporte</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">O que está funcionando, o que falta e os caminhos mais comuns quando algo não anda.</p>
      </div>

      <IntegrationStatus data={data} />

      <HostingSection data={data} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="font-display font-bold">O Pix não gera na fatura</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--dim)]">
            <li>Confira se o access token do Mercado Pago está salvo e testado.</li>
            <li>Para cobrar de verdade: ambiente Produção + modo ao vivo ligado.</li>
            <li>Ambiente de Teste só gera cobranças de validação (aba Testes).</li>
          </ol>
          <button type="button" className={`${btnGhost} mt-3`} onClick={() => onNavigate("pagamento")}>
            Abrir Integração Pagamento
          </button>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="font-display font-bold">Pagamento aprovado, mas não renovou</h3>
          <p className="mt-2 text-sm text-[var(--dim)]">
            Isso é a “extensão pendente”: o dinheiro foi confirmado, mas o gestor ainda não conseguiu estender o usuário
            na API do painel — nenhum crédito foi gasto. Confira o token do painel e o teste de conexão em Servidores e
            use “Tentar a extensão no painel de novo” na cobrança.
          </p>
          <button type="button" className={`${btnGhost} mt-3`} onClick={() => onNavigate("servidores")}>
            Abrir Servidores
          </button>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="font-display font-bold">Conectar o WhatsApp</h3>
          <p className="mt-2 text-sm text-[var(--dim)]">
            O único caminho é o QR Code: aba WhatsApp → “Gerar QR Code” e ler com o celular em
            Aparelhos conectados. Não existe mais a alternativa da Meta neste gestor.
          </p>
          <button type="button" className={`${btnGhost} mt-3`} onClick={() => onNavigate("whatsapp")}>
            Abrir WhatsApp
          </button>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="font-display font-bold">Como uma renovação acontece</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--dim)]">
            <li>Você envia a página da fatura do cliente (aba Clientes).</li>
            <li>O cliente gera o Pix e paga; o gestor confere no Mercado Pago.</li>
            <li>Com o pagamento aprovado, o gestor estende aquele usuário no painel pela duração do plano (30 dias = 1 crédito).</li>
            <li>A confirmação fica pronta em Mensagens para enviar ao cliente.</li>
          </ol>
          <button type="button" className={`${btnGhost} mt-3`} onClick={() => onNavigate("dashboard")}>
            Voltar ao Dashboard
          </button>
        </div>
      </div>
    </section>
  );
}
