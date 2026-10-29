// Localização (SÓ LEITURA) do botão "Renovar" do painel Sigma por
// navegador automatizado — ETAPA 1 da automação pedida pela dona do
// gestor. O caminho por API de sessão não foi comprovado (nenhum
// endpoint interno apareceu em evidência pública nem na navegação
// logada só-leitura), então esta etapa abre o painel como se fosse a
// dona, entra com o link/usuário/senha JÁ SALVOS no servidor, vai à
// lista de clientes, abre o menu "Ações" e verifica se o item
// "Renovar" existe, está visível e habilitado.
//
// LIMITES DUROS DESTA ETAPA (não afrouxar sem autorização nova):
// - UMA única tentativa por chamada, timeout total de 60 segundos,
//   navegador sempre fechado em `finally`.
// - NENHUM clique em Renovar, confirmar, salvar ou qualquer ação que
//   mude dados ou gaste crédito. Os ÚNICOS cliques deste módulo são:
//   (1) o botão "Fazer login com outra conta", quando a tela de
//   login salvo aparece; (2) o botão "Continuar" (envio do login,
//   com fallback para o submit do formulário) e (3) o botão que
//   abre o menu "Ações" da linha do cliente. O menu é fechado com
//   a tecla Escape. O clique real no "Renovar" fica para uma etapa
//   futura, com autorização separada e cliente escolhido.
// - Nenhum retry automático, nenhuma repetição: bloqueio (captcha /
//   Cloudflare / anti-automação), login recusado, cliente não
//   encontrado ou botão ausente viram motivo em linguagem simples.
// - Credenciais só chegam pelos argumentos (vindos dos campos já
//   salvos do servidor); nunca vão para URL, log ou evidência. O
//   diagnóstico devolve SÓ o estágio, tempos, flags de presença de
//   textos visíveis e um trecho curto SANITIZADO da tela (sem
//   valores de inputs, sem e-mail, sem token, sem HTML, sem cookies,
//   sem localStorage, sem screenshot) — nunca uma credencial.

export type SigmaBrowserLocateStage =
  | "encontrado"
  | "bloqueado"
  | "login_recusado"
  | "cliente_nao_encontrado"
  | "botao_ausente"
  | "erro";

// Estágio de progresso do navegador (onde a tentativa parou). Usado
// só no diagnóstico: diz o que o navegador do servidor realmente
// viu, em vez de uma mensagem genérica.
export type SigmaBrowserProgressStage =
  | "browser_launch"
  | "page_goto"
  | "spa_load"
  | "saved_login_screen"
  | "login_form"
  | "dashboard"
  | "customers_list"
  | "actions_menu"
  | "renew_found";

export type SigmaBrowserDiagnosticFlagKey =
  | "saved_login"
  | "last_use"
  | "user_placeholder"
  | "password_placeholder"
  | "continue_button"
  | "forgot_password"
  | "dashboard"
  | "human_check"
  | "cloudflare"
  | "captcha"
  | "access_denied"
  | "just_a_moment";

export type SigmaBrowserLocateDiagnostic = {
  /** Último estágio de progresso alcançado. */
  stage: SigmaBrowserProgressStage;
  /** Tempo total decorrido da tentativa, em ms. */
  elapsedMs: number;
  /** ms decorridos quando cada estágio foi alcançado (só os visitados). */
  stepTimesMs: Partial<Record<SigmaBrowserProgressStage, number>>;
  /** Título da página no momento da captura (pode ser ""). */
  pageTitle: string;
  /** Origem + caminho + hash da URL atual, sem query (sem segredo). */
  pagePath: string;
  /** Comprimento do texto visível da página no momento da captura. */
  visibleTextLength: number;
  /** Presença (true/false) de cada texto visível vigiado. */
  flags: Record<SigmaBrowserDiagnosticFlagKey, boolean>;
  /** Trecho sanitizado (máx. 200 caracteres) do texto visível. */
  snippet: string;
};

export type SigmaBrowserLocateResult = {
  found: boolean;
  stage: SigmaBrowserLocateStage;
  detail: string;
  testedAt: string;
  diagnostic: SigmaBrowserLocateDiagnostic;
};

export type SigmaBrowserLocateInput = {
  panelUrl: string;
  panelUser: string;
  panelPass: string;
  iptvUser: string;
  /** Timeout total da tentativa, em ms. Padrão: 60_000. */
  timeoutMs?: number;
};

const TOTAL_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 12_000;
// Espera pelo carregamento do SPA na tela de login: a página fica em
// branco com spinner por vários segundos (observado até ~15s) antes
// de exibir o seletor de login salvo ou o formulário.
const LOGIN_SCREEN_TIMEOUT_MS = 30_000;

// Textos visíveis vigiados no diagnóstico. A presença é só um
// booleano — nenhum texto da página é devolvido além do trecho
// sanitizado. "senha" também casa "Mostrar senha": indica apenas que
// há conteúdo de formulário na tela.
const DIAGNOSTIC_FLAGS: Array<{
  key: SigmaBrowserDiagnosticFlagKey;
  needles: string[];
}> = [
  { key: "saved_login", needles: ["fazer login com outra conta"] },
  { key: "last_use", needles: ["último uso", "ultimo uso"] },
  { key: "user_placeholder", needles: ["usuário ou e-mail", "usuario ou e-mail"] },
  { key: "password_placeholder", needles: ["senha"] },
  { key: "continue_button", needles: ["continuar"] },
  { key: "forgot_password", needles: ["esqueceu a senha"] },
  { key: "dashboard", needles: ["dashboard", "clientes"] },
  {
    key: "human_check",
    needles: ["verify you are human", "verifique que você é humano", "verifique se você é humano"],
  },
  { key: "cloudflare", needles: ["cloudflare"] },
  { key: "captcha", needles: ["captcha"] },
  { key: "access_denied", needles: ["acesso negado", "access denied"] },
  { key: "just_a_moment", needles: ["just a moment"] },
];

function emptyFlags(): Record<SigmaBrowserDiagnosticFlagKey, boolean> {
  const flags = {} as Record<SigmaBrowserDiagnosticFlagKey, boolean>;
  for (const flag of DIAGNOSTIC_FLAGS) flags[flag.key] = false;
  return flags;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Sanitiza o texto visível da página antes de ele virar diagnóstico:
// remove qualquer ocorrência dos segredos (usuário/senha do painel,
// usuário IPTV — a tela de login salvo pode exibir o nome da conta),
// e-mails, tokens e sequências longas parecidas com código. O texto
// visível (innerText) já não inclui valores digitados nos inputs;
// esta limpeza cobre os casos em que a página EXIBE o dado (nome da
// conta salva, saudação, etc.). Se não sobrar nada, registra
// "texto visível vazio" em vez de string vazia.
function sanitizeVisibleText(raw: string, secrets: string[]): string {
  let text = raw.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    text = text.replace(new RegExp(escapeRegExp(secret), "gi"), "[oculto]");
  }
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail oculto]");
  text = text.replace(/eyJ[A-Za-z0-9_-]{10,}/g, "[token oculto]");
  text = text.replace(/[A-Za-z0-9][A-Za-z0-9_\-./]{31,}/g, "[código oculto]");
  text = text.slice(0, 200).trim();
  return text ? text : "texto visível vazio";
}

// Instantâneo seguro da página no momento da falha (ou do sucesso):
// título, caminho da URL sem query, comprimento do texto visível,
// flags de presença e trecho sanitizado. NUNCA captura HTML bruto,
// cookies, localStorage, valores de inputs ou screenshot. Defensivo:
// qualquer erro de leitura vira instantâneo vazio, sem derrubar o
// resultado da localização.
async function captureDiagnosticSnapshot(
  page: import("playwright").Page | null,
  secrets: string[],
): Promise<Omit<SigmaBrowserLocateDiagnostic, "stage" | "elapsedMs" | "stepTimesMs">> {
  const empty = {
    pageTitle: "",
    pagePath: "",
    visibleTextLength: 0,
    flags: emptyFlags(),
    snippet: "texto visível vazio",
  };
  if (!page) return empty;
  try {
    const pageTitle = await page.title().catch(() => "");
    let pagePath = "";
    try {
      const parsed = new URL(page.url());
      pagePath = `${parsed.origin}${parsed.pathname}${parsed.hash}`;
    } catch {
      pagePath = "";
    }
    const text = await page
      .locator("body")
      .innerText({ timeout: 3000 })
      .catch(() => "");
    const lower = text.toLowerCase();
    const flags = emptyFlags();
    for (const flag of DIAGNOSTIC_FLAGS) {
      flags[flag.key] = flag.needles.some((needle) => lower.includes(needle));
    }
    return {
      pageTitle,
      pagePath,
      visibleTextLength: text.length,
      flags,
      snippet: sanitizeVisibleText(text, secrets),
    };
  } catch {
    return empty;
  }
}

// Sinais de bloqueio por automação/captcha na página (só leitura do
// texto — nenhum deles é devolvido na resposta).
const BLOCK_MARKERS = [
  "cloudflare",
  "captcha",
  "protected against bots",
  "attention required",
  "verify you are human",
  "verifique que você é humano",
  "verifique se você é humano",
  "are you a robot",
  "access denied",
  "ray id",
];

// Sinais de login recusado na tela de login, após o envio.
const LOGIN_REFUSED_MARKERS = [
  "incorret",
  "inválid",
  "invalid",
  "credenciais",
  "credentials",
  "não encontrado",
  "not found",
  "wrong",
  "failed",
  "falhou",
  "tente novamente",
];

function panelOrigin(panelUrl: string): string {
  const parsed = new URL(panelUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("A URL do painel precisa começar com http:// ou https://.");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

async function pageShowsBlock(page: {
  locator: (selector: string) => {
    count: () => Promise<number>;
    innerText: () => Promise<string>;
  };
}): Promise<boolean> {
  const captchaFrames = await page
    .locator('iframe[src*="captcha"], iframe[src*="challenges.cloudflare"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"]')
    .count()
    .catch(() => 0);
  if (captchaFrames > 0) return true;
  // Texto VISÍVEL (innerText), não o HTML bruto: o código JavaScript
  // da própria página pode citar as palavras de bloqueio sem que a
  // tela de bloqueio esteja sendo exibida.
  const text = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  return BLOCK_MARKERS.some((m) => text.includes(m));
}

// Localização dos campos de login POR PLACEHOLDER, com fallbacks por
// ordem. A tela real do painel NÃO tem rótulos visíveis nos campos:
// o campo 1 usa o placeholder "Usuário ou E-mail" e o campo 2 usa o
// placeholder "Senha". Um único seletor rígido quebraria à toa — por
// isso a ordem é: placeholder → label associada → tipo do input.
async function locateLoginUserField(page: import("playwright").Page) {
  const byPlaceholder = page.getByPlaceholder(/usuário ou e-mail/i);
  if ((await byPlaceholder.count().catch(() => 0)) > 0) return byPlaceholder.first();
  const byLabel = page.getByLabel(/usuário|e-mail/i);
  if ((await byLabel.count().catch(() => 0)) > 0) return byLabel.first();
  return page
    .locator('input:not([type="password"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):visible')
    .first();
}

async function locateLoginPasswordField(page: import("playwright").Page) {
  const byPlaceholder = page.getByPlaceholder(/senha/i);
  if ((await byPlaceholder.count().catch(() => 0)) > 0) return byPlaceholder.first();
  return page.locator('input[type="password"]:visible').first();
}

export async function locateSigmaRenewButton(
  input: SigmaBrowserLocateInput,
): Promise<SigmaBrowserLocateResult> {
  const totalTimeout = input.timeoutMs ?? TOTAL_TIMEOUT_MS;
  // Rastreador de diagnóstico: vive fora do `run()` para que o
  // caminho de tempo esgotado (Promise.race) também saiba em que
  // estágio a tentativa parou.
  const diagStartedAt = Date.now();
  const diagState: {
    stage: SigmaBrowserProgressStage;
    stepTimesMs: Partial<Record<SigmaBrowserProgressStage, number>>;
  } = { stage: "browser_launch", stepTimesMs: { browser_launch: 0 } };
  const markStage = (stage: SigmaBrowserProgressStage) => {
    diagState.stage = stage;
    if (diagState.stepTimesMs[stage] === undefined) {
      diagState.stepTimesMs[stage] = Date.now() - diagStartedAt;
    }
  };
  let diagPage: import("playwright").Page | null = null;
  const secrets = [input.panelUser, input.panelPass, input.iptvUser];
  const buildDiagnostic = async (): Promise<SigmaBrowserLocateDiagnostic> => {
    const snapshot = await captureDiagnosticSnapshot(diagPage, secrets);
    return {
      stage: diagState.stage,
      elapsedMs: Date.now() - diagStartedAt,
      stepTimesMs: diagState.stepTimesMs,
      ...snapshot,
    };
  };
  const run = async (): Promise<SigmaBrowserLocateResult> => {
    // ATENÇÃO: todo retorno deste fluxo usa `return await finish(...)`
    // (e NUNCA `return finish(...)`): o `finally` abaixo fecha o
    // navegador, e sem o `await` ele fecharia ANTES de o diagnóstico
    // terminar de ler a página — a captura falharia com "target
    // closed" e o diagnóstico sairia vazio. Não "otimizar" isso.
    const finish = async (
      stage: SigmaBrowserLocateStage,
      detail: string,
    ): Promise<SigmaBrowserLocateResult> => {
      const diagnostic = await buildDiagnostic();
      return { found: stage === "encontrado", stage, detail, testedAt: new Date().toISOString(), diagnostic };
    };
    let origin: string;
    try {
      origin = panelOrigin(input.panelUrl);
    } catch {
      return await finish(
        "erro",
        "Não foi possível abrir o painel: a URL salva no servidor não é um endereço válido. Confira o link do painel no cadastro do servidor.",
      );
    }
    if (!input.panelUser.trim() || !input.panelPass) {
      return await finish(
        "erro",
        "Não foi possível entrar no painel: o usuário ou a senha do painel não estão salvos neste servidor. Edite o servidor e salve o link, o usuário e a senha do painel.",
      );
    }

    // Import dinâmico: se o pacote do navegador não estiver instalado
    // neste servidor, a falha vira motivo honesto em vez de derrubar
    // o gestor. O binário do navegador é outro requisito (ver o
    // relatório da etapa 1): sem ele, o launch abaixo falha e cai no
    // mesmo motivo.
    let chromium: typeof import("playwright").chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      return await finish(
        "erro",
        "O navegador de automação não está instalado neste servidor, por isso a localização do botão não pôde rodar. A renovação continua pendente e nenhum crédito foi consumido.",
      );
    }

    let browser: import("playwright").Browser | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        timeout: STEP_TIMEOUT_MS,
      });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();
      diagPage = page;
      page.setDefaultTimeout(STEP_TIMEOUT_MS);

      // 1) Tela de login. O SPA demora para montar (branco + spinner
      // por vários segundos, observado até ~15s) e a primeira tela
      // NÃO é o formulário: é um seletor de login salvo. Por isso se
      // espera o seletor OU o formulário aparecer, com folga, em vez
      // de procurar os campos de imediato.
      try {
        await page.goto(`${origin}/#/sign-in?redirect=/dashboard`, {
          waitUntil: "domcontentloaded",
          timeout: STEP_TIMEOUT_MS,
        });
      } catch {
        return await finish(
          "erro",
          "O painel não respondeu a tempo. Ele pode estar fora do ar. A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      markStage("page_goto");
      if (await pageShowsBlock(page)) {
        return await finish(
          "bloqueado",
          "O painel barrou a automação (tela de verificação/bloqueio), por isso não foi possível nem entrar. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
        );
      }

      const savedLoginButton = page.getByRole("button", { name: /fazer login com outra conta/i });
      const userByPlaceholder = page.getByPlaceholder(/usuário ou e-mail/i);
      const loginScreenReady = await savedLoginButton
        .or(userByPlaceholder)
        .first()
        .waitFor({ state: "visible", timeout: LOGIN_SCREEN_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      if (!loginScreenReady) {
        // A tela de bloqueio pode renderizar depois do carregamento
        // inicial (o SPA monta devagar): re-checar antes de concluir
        // que os campos simplesmente não vieram.
        if (await pageShowsBlock(page)) {
          return await finish(
            "bloqueado",
            "O painel barrou a automação (tela de verificação/bloqueio), por isso não foi possível nem entrar. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
          );
        }
        return await finish(
          "erro",
          "A tela de login do painel não trouxe os campos de usuário e senha do jeito esperado, por isso a localização parou antes de entrar. Nenhum crédito foi consumido.",
        );
      }
      markStage("spa_load");
      if (await pageShowsBlock(page)) {
        return await finish(
          "bloqueado",
          "O painel barrou a automação (tela de verificação/bloqueio), por isso não foi possível nem entrar. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
        );
      }

      // Se o seletor de login salvo apareceu, clicar em "Fazer login
      // com outra conta" — clique que só troca a tela, não entra em
      // conta nenhuma — e aguardar o formulário aparecer.
      const savedLoginVisible =
        (await savedLoginButton.count().catch(() => 0)) > 0 &&
        (await savedLoginButton.first().isVisible().catch(() => false));
      if (savedLoginVisible) {
        markStage("saved_login_screen");
        await savedLoginButton.first().click({ timeout: STEP_TIMEOUT_MS });
        const formReady = await userByPlaceholder
          .first()
          .waitFor({ state: "visible", timeout: LOGIN_SCREEN_TIMEOUT_MS })
          .then(() => true)
          .catch(() => false);
        if (!formReady) {
          if (await pageShowsBlock(page)) {
            return await finish(
              "bloqueado",
              "O painel barrou a automação (tela de verificação/bloqueio), por isso não foi possível nem entrar. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
            );
          }
          return await finish(
            "erro",
            "A tela de login do painel não trouxe os campos de usuário e senha do jeito esperado, por isso a localização parou antes de entrar. Nenhum crédito foi consumido.",
          );
        }
      }

      // 2) Preencher login com as credenciais JÁ SALVAS no servidor.
      // Campos localizados por placeholder (sem rótulo visível), com
      // fallbacks por ordem. Nenhum valor digitado é registrado ou
      // devolvido.
      const userField = await locateLoginUserField(page);
      const passwordField = await locateLoginPasswordField(page);
      if ((await userField.count()) === 0 || (await passwordField.count()) === 0) {
        return await finish(
          "erro",
          "A tela de login do painel não trouxe os campos de usuário e senha do jeito esperado, por isso a localização parou antes de entrar. Nenhum crédito foi consumido.",
        );
      }
      markStage("login_form");
      await userField.fill(input.panelUser);
      await passwordField.fill(input.panelPass);
      // Enviar clicando em "Continuar" — botão principal da tela
      // real (não há botão "Entrar"/"Login") — com fallback para o
      // submit do formulário. Clique de envio: entrar no painel. Não
      // é ação sobre cliente nenhum e não gasta crédito.
      const continueButton = page.getByRole("button", { name: /continuar/i }).first();
      if ((await continueButton.count()) > 0) {
        await continueButton.click({ timeout: STEP_TIMEOUT_MS });
      } else {
        const submit = page.locator('button[type="submit"]:visible').first();
        if ((await submit.count()) > 0) {
          await submit.click({ timeout: STEP_TIMEOUT_MS });
        } else {
          await passwordField.press("Enter");
        }
      }

      // 3) Aguardar o dashboard (ou a lista) — prova de login. O
      // teste olha o HASH da URL (#/dashboard, #/customers): o
      // endereço de login já traz "dashboard" na query
      // (?redirect=/dashboard) e um teste por substring daria
      // "logado" antes mesmo de entrar.
      const loggedIn = await page
        .waitForURL(
          (url) => url.hash === "#/dashboard" || url.hash.startsWith("#/customers"),
          { timeout: STEP_TIMEOUT_MS },
        )
        .then(() => true)
        .catch(() => false);
      if (!loggedIn) {
        const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
        if (await pageShowsBlock(page)) {
          return await finish(
            "bloqueado",
            "O painel barrou a automação (tela de verificação/bloqueio) depois do login, por isso a localização parou. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
          );
        }
        if (LOGIN_REFUSED_MARKERS.some((m) => bodyText.includes(m))) {
          return await finish(
            "login_recusado",
            "O painel não aceitou o usuário ou a senha salvos neste servidor. Confira o usuário e a senha do painel no cadastro do servidor e tente de novo. Nenhum crédito foi consumido.",
          );
        }
        return await finish(
          "login_recusado",
          "Não foi possível confirmar a entrada no painel com o usuário e a senha salvos neste servidor (a tela de login continuou aberta). Confira as credenciais no cadastro do servidor. Nenhum crédito foi consumido.",
        );
      }
      markStage("dashboard");

      // 4) Lista de clientes.
      try {
        await page.goto(`${origin}/#/customers`, {
          waitUntil: "domcontentloaded",
          timeout: STEP_TIMEOUT_MS,
        });
      } catch {
        return await finish(
          "erro",
          "A lista de clientes do painel não respondeu a tempo. A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      markStage("customers_list");
      if (await pageShowsBlock(page)) {
        return await finish(
          "bloqueado",
          "O painel barrou a automação (tela de verificação/bloqueio) na lista de clientes. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
        );
      }

      // 5) Pesquisar o usuário IPTV exato do cliente.
      const searchField = page
        .locator('input[type="search"]:visible, input[placeholder*="Pesquis"]:visible, input[placeholder*="Search"]:visible')
        .first();
      if ((await searchField.count()) > 0) {
        await searchField.fill(input.iptvUser);
      }
      await page.waitForTimeout(1500);
      const row = page
        .locator("tbody tr, [role='row']")
        .filter({ hasText: input.iptvUser })
        .first();
      if ((await row.count()) === 0) {
        const exactText = page.getByText(input.iptvUser, { exact: true });
        if ((await exactText.count()) === 0) {
          return await finish(
            "cliente_nao_encontrado",
            "O cliente não foi encontrado na lista do painel com esse usuário. Confira se o usuário IPTV do cliente é exatamente o mesmo do painel. Nenhum crédito foi consumido.",
          );
        }
      }

      // 6) Abrir o menu "Ações" da linha — clique permitido nesta
      // etapa: só abre o menu. O item "Renovar" NÃO é clicado em
      // hipótese alguma (verificação só de existência).
      const actionsTrigger = row
        .getByRole("button", { name: /aç(õ|o)es/i })
        .first();
      const trigger =
        (await actionsTrigger.count()) > 0
          ? actionsTrigger
          : row.locator("button:visible").last();
      try {
        await trigger.click({ timeout: STEP_TIMEOUT_MS });
      } catch {
        return await finish(
          "botao_ausente",
          "O menu de ações do cliente não abriu na tela do painel, por isso o botão Renovar não pôde ser localizado. Nenhum crédito foi consumido.",
        );
      }
      markStage("actions_menu");
      await page.waitForTimeout(800);

      // 7) Verificar o item "Renovar": existe, visível e habilitado.
      // Somente leitura — NENHUM clique aqui.
      const renewItem = page.getByText("Renovar", { exact: true }).first();
      if ((await renewItem.count()) === 0) {
        await page.keyboard.press("Escape").catch(() => {});
        return await finish(
          "botao_ausente",
          "O botão Renovar não apareceu no menu de ações do cliente na tela do painel. O painel pode ter mudado a tela. Nenhum crédito foi consumido.",
        );
      }
      const visible = await renewItem.isVisible().catch(() => false);
      const enabled = await renewItem.isEnabled().catch(() => false);
      await page.keyboard.press("Escape").catch(() => {});
      if (!visible || !enabled) {
        return await finish(
          "botao_ausente",
          "O botão Renovar apareceu no menu de ações, mas está invisível ou desabilitado para este cliente. Nenhum crédito foi consumido.",
        );
      }
      markStage("renew_found");
      return await finish(
        "encontrado",
        "O botão Renovar foi localizado na tela do painel para este cliente. Nada foi clicado e nenhum crédito foi consumido — o clique real fica para a próxima etapa, com a sua autorização.",
      );
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (/executable doesn't exist|browser.*not found|failed to launch/i.test(raw)) {
        return await finish(
          "erro",
          "O navegador de automação não está instalado neste servidor, por isso a localização do botão não pôde rodar. A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      if (/timeout|timed out/i.test(raw)) {
        return await finish(
          "erro",
          "O painel demorou demais para responder e a localização parou por tempo esgotado (60 segundos). A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      return await finish(
        "erro",
        "A localização do botão parou por um erro no painel ou na conexão, sem concluir. A renovação continua pendente e nenhum crédito foi consumido.",
      );
    } finally {
      // O navegador SEMPRE fecha, tenha a localização terminado ou
      // falhado no meio do caminho.
      await browser?.close().catch(() => {});
    }
  };

  // Limite total de 60s para a chamada inteira: se estourar, a
  // promessa rejeita, mas o `finally` do fluxo acima ainda fecha o
  // navegador quando as operações pendentes terminarem.
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Tempo esgotado: 60 segundos.")),
      totalTimeout,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([run(), timeout]);
  } catch {
    // Tempo esgotado no race: o diagnóstico sai sem instantâneo da
    // página (a página pode estar no meio de uma operação), mas com
    // o estágio e os tempos registrados até ali.
    return {
      found: false,
      stage: "erro",
      detail:
        "O painel demorou demais para responder e a localização parou por tempo esgotado (60 segundos). A renovação continua pendente e nenhum crédito foi consumido.",
      testedAt: new Date().toISOString(),
      diagnostic: {
        stage: diagState.stage,
        elapsedMs: Date.now() - diagStartedAt,
        stepTimesMs: diagState.stepTimesMs,
        pageTitle: "",
        pagePath: "",
        visibleTextLength: 0,
        flags: emptyFlags(),
        snippet: "texto visível vazio",
      },
    };
  }
}
