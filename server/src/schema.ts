import { bigint, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Contas de acesso ao gestor: o gestor é usado por várias pessoas e
// TODOS os dados (servidores, clientes, planos, vendas, transações,
// cupons, mensagens, WhatsApp e configurações) pertencem a uma conta
// (owner_id). Conta nova começa vazia, do zero. A senha guarda apenas
// o hash PBKDF2 com sal — nunca a senha em si.
export const accounts = pgTable("accounts", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  email: text("email").notNull(),
  passHash: text("pass_hash").notNull(),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
  // Papel e assinatura do gestor: a primeira conta do banco é a
  // administradora (dona). Conta nova começa em teste grátis de 7
  // dias (trialEndsAt); depois, sem assinatura paga, o acesso à
  // interface bloqueia — SEM apagar nenhum dado (bloqueio é só de
  // acesso; tudo permanece e volta ao pagar). subStatus 'blocked' é
  // bloqueio manual pela administradora. A SENHA NUNCA APARECE EM
  // NENHUMA RESPOSTA: aqui fica só o hash (passHash), e a área de
  // Administração mostra e-mail, datas, status, valor e contagens —
  // nunca senha nem hash.
  role: text("role").notNull().default("user"),
  trialEndsAt: timestamp("trial_ends_at", { mode: "date", precision: 3 }),
  subExpiresAt: timestamp("sub_expires_at", { mode: "date", precision: 3 }),
  subPriceCents: integer("sub_price_cents").notNull().default(0),
  subStatus: text("sub_status").notNull().default("trial"),
  lastLoginAt: timestamp("last_login_at", { mode: "date", precision: 3 }),
  // Indicação de contas: código próprio de 8 caracteres (único quando
  // preenchido) e a conta que indicou esta conta (null = chegou sem
  // link). Nada aqui é senha nem credencial.
  referralCode: text("referral_code"),
  referredByAccountId: integer("referred_by_account_id"),
});

// Tokens de redefinição de senha: guarda só o HASH do token (sha256),
// nunca o token. Uso único e validade curta (1 hora).
export const passwordResets = pgTable("password_resets", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  accountId: integer("account_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", precision: 3 }).notNull(),
  used: integer("used").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Pagamentos da assinatura do gestor: cada pagamento aprovado libera
// APENAS 30 dias de acesso. Não se confunde com a tabela payments
// (cobranças Pix dos clientes IPTV de cada conta): aqui quem paga é
// a conta que usa o gestor, com o Mercado Pago da administradora.
export const subscriptionPayments = pgTable("subscription_payments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  accountId: integer("account_id").notNull(),
  mpPaymentId: text("mp_payment_id"),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("pendente"),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
  paidAt: timestamp("paid_at", { mode: "date", precision: 3 }),
});

// Sessões de login: guardam só o hash do token (o token em si fica no
// aparelho de quem entrou). expiresAt em milissegundos.
export const sessions = pgTable("sessions", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  accountId: integer("account_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const servers = pgTable("servers", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  name: text("name").notNull(),
  panelUrl: text("panel_url").notNull(),
  panelUser: text("panel_user").notNull(),
  panelPass: text("panel_pass").notNull(),
  // API do painel: base (ex.: https://mcapi.knewcms.com:2087) e token
  // estático. O token fica só no banco do gestor e NUNCA é devolvido
  // para a tela — a API expõe apenas se ele está salvo e se o teste de
  // autenticação passou (apiVerified).
  apiBase: text("api_base").notNull().default(""),
  apiToken: text("api_token").notNull().default(""),
  apiVerified: integer("api_verified").notNull().default(0),
  apiStatusDetail: text("api_status_detail").notNull().default(""),
  // Diagnóstico estruturado do último teste de conexão (JSON): URL
  // normalizada, avisos sobre a base, cada variação de autenticação
  // tentada, HTTP e corpo da resposta já sem o token. Nunca guarda o
  // token nem substitui o resultado real do teste.
  apiDiagnostic: text("api_diagnostic").notNull().default(""),
  // Chamada de extensão (o botão [+] Estender do painel) via API,
  // conforme a referência oficial WManage: primeiro GET /lines com
  // generalSearch para achar o id exato do cliente, depois
  // PATCH /lines/v2/extend/{id} com {"months": N} (planos de
  // 30/60/90 dias; só 15 dias usa {"days": 15}). Caminho, método e
  // corpo continuam EDITÁVEIS na aba Servidores; {id} e {meses} estão
  // disponíveis nos modelos. extendVerified só vira 1 quando uma
  // extensão REAL retorna sucesso — até lá, "extensão pendente".
  extendPath: text("extend_path").notNull().default("/lines/v2/extend/{id}"),
  extendMethod: text("extend_method").notNull().default("PATCH"),
  extendBody: text("extend_body")
    .notNull()
    .default('{"months":{meses}}'),
  extendVerified: integer("extend_verified").notNull().default(0),
  extendStatusDetail: text("extend_status_detail").notNull().default(""),
  // Provedor do painel deste servidor: "wplay" (WPlay/WManage, o
  // padrão de todos os servidores). Linhas antigas com outro valor
  // são ignoradas pelo servidor (nunca contam como conectadas nem
  // como prontas para extensão) e nenhum dado é apagado.
  panelProvider: text("panel_provider").notNull().default("wplay"),
  // Conexão simples do servidor (link + usuário + senha do painel):
  // ao salvar, o gestor testa o link de verdade e guarda aqui se
  // conectou (panelConnected), o motivo em linguagem simples e quando
  // testou. É este status que a lista de servidores mostra como
  // "Conectado". A senha em si nunca volta para a tela.
  panelConnected: integer("panel_connected").notNull().default(0),
  panelConnectionDetail: text("panel_connection_detail").notNull().default(""),
  panelConnectionTestedAt: bigint("panel_connection_tested_at", { mode: "number" }),
  // Colunas herdadas de uma automação de navegador removida do
  // gestor a pedido da dona: sem uso no código atual, mantidas
  // para não mudar o formato do backup nem o banco já aplicado.
  browserLocateFound: integer("browser_locate_found").notNull().default(0),
  browserLocateDetail: text("browser_locate_detail").notNull().default(""),
  browserLocateTestedAt: bigint("browser_locate_tested_at", { mode: "number" }),
  // Diagnóstico herdado da mesma automação removida (JSON em
  // texto): sem uso no código atual, mantido pelo mesmo motivo.
  browserLocateDiagnostic: text("browser_locate_diagnostic").notNull().default(""),
  // Campos do formulário "Novo Servidor" (modelo pedido pela dona do
  // gestor): identificador interno opcional, créditos e custo.
  // creditsBalance é o saldo atual: nasce com initialCredits, sobe nas
  // recargas e desce nas renovações aplicadas. costPerCreditCents entra
  // no "Custo" do Receita x Custo do dashboard; chargeByScreens
  // multiplica o custo (e o consumo) pelo número de telas do cliente.
  identifier: text("identifier").notNull().default(""),
  initialCredits: integer("initial_credits").notNull().default(0),
  // Saldo de créditos acompanhado LOCALMENTE (a API do painel não
  // informa o saldo do revendedor): decimal para guardar frações
  // (ex.: 4,53, ou 0,5 de um plano de 15 dias).
  creditsBalance: doublePrecision("credits_balance").notNull().default(0),
  creditsBalanceUpdatedAt: timestamp("credits_balance_updated_at", { mode: "date", precision: 3 }),
  costPerCreditCents: integer("cost_per_credit_cents").notNull().default(0),
  chargeByScreens: integer("charge_by_screens").notNull().default(0),
  notes: text("notes").notNull().default(""),
  active: integer("active").notNull().default(1),
  // Integração com o painel IPTV: "propria" usa a API configurada
  // neste servidor; "vinculada" usa a API do servidor apontado em
  // integrationServerId; "nenhuma" deixa a renovação automática
  // pendente. autoRenewEnabled é o interruptor do formulário — ele só
  // funciona de verdade com integração configurada e teste aprovado.
  integrationMode: text("integration_mode")
    .notNull()
    .default("propria"),
  integrationServerId: integer("integration_server_id"),
  // Integração de painel (tabela integrations, aba Integrações) quando
  // integrationMode = "vinculada".
  panelIntegrationId: integer("panel_integration_id"),
  autoRenewEnabled: integer("auto_renew_enabled").notNull().default(0),
  // Por onde saem as mensagens deste servidor: padrão do sistema ou o
  // dispositivo WhatsApp conectado por QR Code (único caminho).
  sendVia: text("send_via")
    .notNull()
    .default("padrao"),
  // Aba App do formulário: aplicativo recomendado aos clientes deste
  // servidor (nome, link de download e código do Downloader).
  appName: text("app_name").notNull().default(""),
  appDownloadUrl: text("app_download_url").notNull().default(""),
  downloaderCode: text("downloader_code").notNull().default(""),
  // Aba URLs: endereços que o cliente coloca no aplicativo.
  serverUrl: text("server_url").notNull().default(""),
  serverUrlBackup: text("server_url_backup").notNull().default(""),
  epgUrl: text("epg_url").notNull().default(""),
  // Aba PIX: a renovação Pix deste servidor é processada SOMENTE pelo
  // Mercado Pago global do gestor. pixEnabled desliga a geração de Pix
  // para os clientes deste servidor; pixInstructions é um texto extra
  // exibido na fatura desses clientes.
  pixEnabled: integer("pix_enabled").notNull().default(1),
  pixInstructions: text("pix_instructions").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Integrações com painéis IPTV (aba Integrações): só "wplay"
// (nome, URL, usuário e senha do painel). O teste de conexão grava
// status/detail; Info Painel e Sync IDs gravam o que o painel
// respondeu de verdade. Um servidor vincula uma integração em
// servers.panelIntegrationId para testes e renovações automáticas.
// Nota interna: um segundo provedor existiu e foi removido do
// gestor a pedido da dona; linhas antigas dele são ignoradas e
// nenhum dado é apagado.
export const integrations = pgTable("integrations", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  provider: text("provider").notNull().default("wplay"),
  name: text("name").notNull(),
  url: text("url").notNull(),
  panelUser: text("panel_user").notNull(),
  panelPass: text("panel_pass").notNull(),
  // Campos herdados do provedor removido: sem uso no código
  // atual, mantidos para não mudar o formato do backup nem o
  // banco já aplicado. Nada aqui é devolvido para a tela.
  apiBase: text("api_base").notNull().default(""),
  apiToken: text("api_token").notNull().default(""),
  // Segredo ("secret") da API TopSul: vai no corpo JSON de cada
  // chamada TopSul, junto com o token no caminho da URL. Fica só
  // no banco e NUNCA é devolvido para a tela — a API expõe apenas
  // se ele está salvo (hasApiSecret).
  apiSecret: text("api_secret").notNull().default(""),
  status: text("status")
    .notNull()
    .default("nao_testado"),
  testDetail: text("test_detail").notNull().default(""),
  testedAt: bigint("tested_at", { mode: "number" }),
  panelInfo: text("panel_info").notNull().default(""),
  syncDetail: text("sync_detail").notNull().default(""),
  syncedAt: bigint("synced_at", { mode: "number" }),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Movimentações de crédito dos servidores: recargas feitas pela dona
// do gestor e consumos de renovações aplicadas. É o "controle
// detalhado" citado no campo Créditos Iniciais do formulário.
export const serverCreditLogs = pgTable("server_credit_logs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  serverId: integer("server_id").notNull(),
  delta: doublePrecision("delta").notNull(),
  balanceAfter: doublePrecision("balance_after").notNull(),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const plans = pgTable("plans", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  name: text("name").notNull(),
  days: integer("days").notNull(),
  priceCents: integer("price_cents").notNull(),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const clients = pgTable("clients", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  name: text("name").notNull(),
  whatsapp: text("whatsapp"),
  iptvUser: text("iptv_user").notNull(),
  iptvPass: text("iptv_pass").notNull(),
  serverId: integer("server_id"),
  planId: integer("plan_id"),
  priceOverrideCents: integer("price_override_cents"),
  expiresAt: timestamp("expires_at", { mode: "date", precision: 3 }).notNull(),
  status: text("status")
    .notNull()
    .default("ativo"),
  // Cliente de teste: fica fora dos cartões principais do dashboard e
  // aparece na aba Testes. referredBy guarda o NOME de quem indicou
  // este cliente (texto livre escolhido no cadastro), usado na aba
  // Indicação de Clientes.
  isTest: integer("is_test").notNull().default(0),
  referredBy: text("referred_by"),
  // Campos da lista de clientes no modelo pedido pela dona do gestor:
  // aplicativo e dispositivo que o cliente usa, número de telas, como
  // o cliente chegou (captação) e painel extra. Ficam vazios até ela
  // preencher no cadastro — os filtros da lista usam estes valores.
  app: text("app").notNull().default(""),
  device: text("device").notNull().default(""),
  screens: integer("screens"),
  source: text("source").notNull().default(""),
  extraPanel: text("extra_panel").notNull().default(""),
  // Lista onde o cliente está: normal, arquivados ou lixeira. Excluir
  // de verdade continua sendo uma ação separada, feita na lixeira.
  listState: text("list_state")
    .notNull()
    .default("normal"),
  // Código secreto do link público da fatura DESTE cliente. O link
  // que vai na mensagem é #/fatura/<este código>: ele abre a fatura
  // sem login do gestor, mas só quem recebeu o link tem o código —
  // o número sequencial do cliente sozinho NÃO abre mais nenhuma
  // fatura (antes, adivinhar outro número abria a fatura de outro
  // cliente). Gerado no servidor ao criar o cliente (e para os
  // clientes antigos, na primeira leitura do estado); pode ser
  // trocado pelo dono em "Gerar novo link", o que invalida o antigo.
  invoiceToken: text("invoice_token").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const renewals = pgTable("renewals", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  clientId: integer("client_id").notNull(),
  clientName: text("client_name").notNull(),
  iptvUser: text("iptv_user").notNull(),
  planName: text("plan_name").notNull(),
  days: integer("days").notNull(),
  credits: integer("credits").notNull(),
  amountCents: integer("amount_cents").notNull(),
  oldExpiresAt: timestamp("old_expires_at", { mode: "date", precision: 3 }),
  newExpiresAt: timestamp("new_expires_at", { mode: "date", precision: 3 }).notNull(),
  source: text("source").notNull().default("teste_manual"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const payments = pgTable("payments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  clientId: integer("client_id").notNull(),
  clientName: text("client_name").notNull(),
  amountCents: integer("amount_cents").notNull(),
  days: integer("days").notNull(),
  credits: integer("credits").notNull(),
  // validacao = nunca chama o painel, nenhum crédito consumido.
  // producao = pagamento real confirmado com o modo ao vivo ligado.
  mode: text("mode")
    .notNull()
    .default("validacao"),
  status: text("status")
    .notNull()
    .default("pendente"),
  mpPaymentId: text("mp_payment_id"),
  pixCode: text("pix_code"),
  // Cupom de desconto aplicado nesta cobrança (código + valor abatido
  // do preço cheio). amountCents guarda o valor efetivamente cobrado.
  couponCode: text("coupon_code"),
  discountCents: integer("discount_cents").notNull().default(0),
  detail: text("detail").notNull().default(""),
  wouldExpireAt: timestamp("would_expire_at", { mode: "date", precision: 3 }),
  appliedRenewalId: integer("applied_renewal_id"),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Despesas lançadas pela dona do gestor (custos do negócio). Entram no
// "Custo" da seção Receita x Custo do dashboard e na aba Transações.
// spentOn é a data da despesa em YYYY-MM-DD (dia local, sem hora).
export const expenses = pgTable("expenses", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  spentOn: text("spent_on").notNull(),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Cupons de desconto criados pela dona do gestor. O cliente digita o
// código na página da fatura e o desconto (percentual) é abatido do
// valor da cobrança Pix na hora de gerar.
export const coupons = pgTable("coupons", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  ownerId: integer("owner_id").notNull().default(0),
  code: text("code").notNull(),
  percentOff: integer("percent_off").notNull(),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at", { mode: "date", precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const settings = pgTable("settings", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  // Uma linha de configurações POR CONTA (owner_id). A linha antiga
  // (owner_id = 0) é herdada pela primeira conta criada.
  ownerId: integer("owner_id").notNull().default(0),
  warnDays: text("warn_days").notNull().default("3,0"),
  // Credenciais do Mercado Pago: ficam só no banco do gestor, nunca são
  // devolvidas para a tela (a API expõe apenas se estão configuradas).
  mpAccessToken: text("mp_access_token").notNull().default(""),
  mpPublicKey: text("mp_public_key").notNull().default(""),
  mpVerified: integer("mp_verified").notNull().default(0),
  mpAccountLabel: text("mp_account_label").notNull().default(""),
  // E-mail da própria conta do Mercado Pago, lido de /users/me no
  // teste de conexão. A API exige um payer.email válido para criar a
  // cobrança Pix; sem ele a cobrança era recusada ("payer.email must
  // be a valid email"). Nunca é devolvido para a tela.
  mpPayerEmail: text("mp_payer_email").notNull().default(""),
  mpEnvironment: text("mp_environment")
    .notNull()
    .default("teste"),
  liveMode: integer("live_mode").notNull().default(0),
  renewedMessage: text("renewed_message")
    .notNull()
    .default(
      "{saudacao} {nome}! ✅\n\nSua renovação foi confirmada!\n\n📋 Plano: {plano}\n📅 Novo vencimento: {novo_vencimento}\n💰 Valor: {valor}\n\nObrigado pela confiança! Qualquer dúvida, fale conosco.",
    ),
  expiredMessage: text("expired_message")
    .notNull()
    .default(
      "{saudacao} {nome}! 🔔\n\nSeu acesso venceu!\n\n📅 Vencimento: {vencimento}\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!",
    ),
  // Modelo "Vence amanhã" do envio direto de mensagem ao cliente
  // (botão Enviar mensagem na lista de clientes): editável na aba
  // Mensagens. O campo continua se chamando charge_message no banco
  // para não precisar migrar dados; só o texto e o rótulo mudaram.
  chargeMessage: text("charge_message")
    .notNull()
    .default(
      "{saudacao} {nome}! 🔔\n\nSeu acesso vence amanhã!\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!",
    ),
  whatsappStatus: text("whatsapp_status")
    .notNull()
    .default("desconectado"),
  whatsappPhone: text("whatsapp_phone").notNull().default(""),
  // WhatsApp por QR Code — caminho principal pedido pela dona do
  // gestor. O estado abaixo é apenas o que o serviço de sessão informou
  // na última verificação; QR/payload nunca é inventado pela interface.
  waQrStatus: text("wa_qr_status").notNull().default("desconectado"),
  waQrPhone: text("wa_qr_phone").notNull().default(""),
  waQrDetail: text("wa_qr_detail").notNull().default(""),
  waQrImage: text("wa_qr_image").notNull().default(""),
  waQrUpdatedAt: bigint("wa_qr_updated_at", { mode: "number" }).notNull().default(0),
  // Preferências do dispositivo WhatsApp conectado (cartão do
  // dispositivo na aba WhatsApp): bloqueio de chamadas, transcrição
  // de áudios recebidos e mensagem de ausência. São escolhas da dona
  // do gestor guardadas aqui; nada é inventado sobre o aparelho.
  waBlockCalls: integer("wa_block_calls").notNull().default(0),
  waTranscribeAudio: integer("wa_transcribe_audio").notNull().default(0),
  waAwayEnabled: integer("wa_away_enabled").notNull().default(0),
  waAwayMessage: text("wa_away_message").notNull().default(""),
  // Endereço público do gestor fora do Muse (ex.: o endereço
  // .onrender.com da hospedagem gratuita no Render). Quando está
  // salvo, TODOS os links de fatura gerados nas mensagens usam este
  // endereço — assim o cliente abre a fatura sem login do Muse.
  // Vazio = o link usa o endereço atual do gestor (dentro do Muse,
  // que pede login do Muse para quem abre).
  publicBaseUrl: text("public_base_url").notNull().default(""),
  invoiceTitle: text("invoice_title").notNull().default("Renove sua assinatura"),
  invoiceMessage: text("invoice_message")
    .notNull()
    .default(
      "Pague com Pix e sua conta é renovada assim que o pagamento for confirmado.",
    ),
  invoiceColor: text("invoice_color").notNull().default("verde"),
  warnMessage: text("warn_message")
    .notNull()
    .default(
      "{saudacao} {nome}! 🔔\n\nSeu acesso vence hoje!\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!",
    ),
  // Aviso de 3 dias antes: modelo separado, no mesmo estilo, porque
  // a frase muda ("vence em 3 dias", e não "vence hoje").
  warnSoonMessage: text("warn_soon_message")
    .notNull()
    .default(
      "{saudacao} {nome}! 🔔\n\nSeu acesso vence em 3 dias!\n\n📌 Segue o link abaixo para efetuar pagamento:\n🔗 {link}\n\nConte conosco!",
    ),
  // E-mail (Resend) e valor padrão da assinatura, configurados pela
  // administradora. A chave do Resend fica só no banco e NUNCA volta
  // nas respostas (a tela vê só se existe chave salva). O valor
  // padrão é 0 (sem valor) até a administradora definir — nenhum
  // valor é inventado aqui.
  resendApiKey: text("resend_api_key").notNull().default(""),
  resendFrom: text("resend_from").notNull().default(""),
  defaultSubPriceCents: integer("default_sub_price_cents").notNull().default(0),
  // Dias de assinatura concedidos à conta que indicou outra conta
  // quando a indicada paga a primeira assinatura. 0 = recompensas
  // desligadas. Só a administradora edita (nas configurações dela).
  referralRewardDays: integer("referral_reward_days").notNull().default(30),
});

// Recompensas de indicação de contas: uma linha por conta indicada
// que pagou a assinatura (uma só, para sempre) e por cobrança que a
// gerou — os índices únicos impedem conceder duas vezes. Não entra
// em conflito com a aba "Indicação de Clientes" (clients.referredBy),
// que é outro mecanismo e não é tocado aqui.
export const referralRewards = pgTable(
  "referral_rewards",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    referrerAccountId: integer("referrer_account_id").notNull(),
    referredAccountId: integer("referred_account_id").notNull(),
    subscriptionPaymentId: integer("subscription_payment_id").notNull(),
    daysGranted: integer("days_granted").notNull(),
    grantedAt: timestamp("granted_at", { mode: "date", precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("referral_rewards_referred_uidx").on(t.referredAccountId),
    uniqueIndex("referral_rewards_payment_uidx").on(t.subscriptionPaymentId),
  ],
);

// Registro dos avisos automáticos de vencimento (scheduler 07h-09h):
// uma linha por conta + cliente + tipo + dia (data de São Paulo).
// O índice parcial UNIQUE só vale para linhas 'enviado': é ele que
// garante um envio por dia mesmo com reinício, e uma falha libera a
// vaga para tentar de novo no mesmo dia. Não entra no backup (é
// registro transitório de envio, não dado do negócio).
export const warningSends = pgTable(
  "warning_sends",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    ownerId: integer("owner_id").notNull().default(0),
    clientId: integer("client_id").notNull(),
    kind: text("kind").notNull(),
    sentDate: text("sent_date").notNull(),
    sentAt: timestamp("sent_at", { mode: "date", precision: 3 }),
    status: text("status").notNull().default("enviado"),
    detail: text("detail").notNull().default(""),
  },
  (t) => [
    uniqueIndex("warning_sends_once_per_day_idx")
      .on(t.ownerId, t.clientId, t.kind, t.sentDate)
      .where(sql`${t.status} = 'enviado'`),
    index("warning_sends_owner_idx").on(t.ownerId, t.sentDate),
  ],
);
