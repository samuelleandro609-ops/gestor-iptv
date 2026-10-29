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
//   (1) o botão de enviar do formulário de login e (2) o botão que
//   abre o menu "Ações" da linha do cliente. O menu é fechado com a
//   tecla Escape. O clique real no "Renovar" fica para uma etapa
//   futura, com autorização separada e cliente escolhido.
// - Nenhum retry automático, nenhuma repetição: bloqueio (captcha /
//   Cloudflare / anti-automação), login recusado, cliente não
//   encontrado ou botão ausente viram motivo em linguagem simples.
// - Credenciais só chegam pelos argumentos (vindos dos campos já
//   salvos do servidor); nunca vão para URL, log ou evidência, e
//   nenhum texto da página do painel é devolvido na resposta.

export type SigmaBrowserLocateStage =
  | "encontrado"
  | "bloqueado"
  | "login_recusado"
  | "cliente_nao_encontrado"
  | "botao_ausente"
  | "erro";

export type SigmaBrowserLocateResult = {
  found: boolean;
  stage: SigmaBrowserLocateStage;
  detail: string;
  testedAt: string;
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

function result(
  stage: SigmaBrowserLocateStage,
  detail: string,
): SigmaBrowserLocateResult {
  return { found: stage === "encontrado", stage, detail, testedAt: new Date().toISOString() };
}

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

export async function locateSigmaRenewButton(
  input: SigmaBrowserLocateInput,
): Promise<SigmaBrowserLocateResult> {
  const totalTimeout = input.timeoutMs ?? TOTAL_TIMEOUT_MS;
  const run = async (): Promise<SigmaBrowserLocateResult> => {
    let origin: string;
    try {
      origin = panelOrigin(input.panelUrl);
    } catch {
      return result(
        "erro",
        "Não foi possível abrir o painel: a URL salva no servidor não é um endereço válido. Confira o link do painel no cadastro do servidor.",
      );
    }
    if (!input.panelUser.trim() || !input.panelPass) {
      return result(
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
      return result(
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
      page.setDefaultTimeout(STEP_TIMEOUT_MS);

      // 1) Tela de login.
      try {
        await page.goto(`${origin}/#/sign-in?redirect=/dashboard`, {
          waitUntil: "domcontentloaded",
          timeout: STEP_TIMEOUT_MS,
        });
      } catch {
        return result(
          "erro",
          "O painel não respondeu a tempo. Ele pode estar fora do ar. A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      if (await pageShowsBlock(page)) {
        return result(
          "bloqueado",
          "O painel barrou a automação (tela de verificação/bloqueio), por isso não foi possível nem entrar. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
        );
      }

      // 2) Preencher login com as credenciais JÁ SALVAS no servidor.
      // Os campos são procurados de forma genérica (a tela observada
      // tem usuário + senha + botão de enviar); nenhum valor digitado
      // é registrado ou devolvido.
      const passwordField = page.locator('input[type="password"]:visible').first();
      const userField = page
        .locator('input:not([type="password"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):visible')
        .first();
      if ((await userField.count()) === 0 || (await passwordField.count()) === 0) {
        return result(
          "erro",
          "A tela de login do painel não trouxe os campos de usuário e senha do jeito esperado, por isso a localização parou antes de entrar. Nenhum crédito foi consumido.",
        );
      }
      await userField.fill(input.panelUser);
      await passwordField.fill(input.panelPass);
      const submit = page.locator('button[type="submit"]:visible').first();
      if ((await submit.count()) > 0) {
        // ÚNICO clique de envio deste módulo: entrar no painel. Não
        // é ação sobre cliente nenhum e não gasta crédito.
        await submit.click({ timeout: STEP_TIMEOUT_MS });
      } else {
        await passwordField.press("Enter");
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
          return result(
            "bloqueado",
            "O painel barrou a automação (tela de verificação/bloqueio) depois do login, por isso a localização parou. Tente de novo mais tarde ou use o caminho do token da API Sigma. Nenhum crédito foi consumido.",
          );
        }
        if (LOGIN_REFUSED_MARKERS.some((m) => bodyText.includes(m))) {
          return result(
            "login_recusado",
            "O painel não aceitou o usuário ou a senha salvos neste servidor. Confira o usuário e a senha do painel no cadastro do servidor e tente de novo. Nenhum crédito foi consumido.",
          );
        }
        return result(
          "login_recusado",
          "Não foi possível confirmar a entrada no painel com o usuário e a senha salvos neste servidor (a tela de login continuou aberta). Confira as credenciais no cadastro do servidor. Nenhum crédito foi consumido.",
        );
      }

      // 4) Lista de clientes.
      try {
        await page.goto(`${origin}/#/customers`, {
          waitUntil: "domcontentloaded",
          timeout: STEP_TIMEOUT_MS,
        });
      } catch {
        return result(
          "erro",
          "A lista de clientes do painel não respondeu a tempo. A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      if (await pageShowsBlock(page)) {
        return result(
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
          return result(
            "cliente_nao_encontrado",
            "O cliente não foi encontrado na lista do painel com esse usuário. Confira se o usuário IPTV do cliente é exatamente o mesmo do painel. Nenhum crédito foi consumido.",
          );
        }
      }

      // 6) Abrir o menu "Ações" da linha — SEGUNDO E ÚLTIMO clique
      // permitido nesta etapa: só abre o menu. O item "Renovar" NÃO
      // é clicado em hipótese alguma (verificação só de existência).
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
        return result(
          "botao_ausente",
          "O menu de ações do cliente não abriu na tela do painel, por isso o botão Renovar não pôde ser localizado. Nenhum crédito foi consumido.",
        );
      }
      await page.waitForTimeout(800);

      // 7) Verificar o item "Renovar": existe, visível e habilitado.
      // Somente leitura — NENHUM clique aqui.
      const renewItem = page.getByText("Renovar", { exact: true }).first();
      if ((await renewItem.count()) === 0) {
        await page.keyboard.press("Escape").catch(() => {});
        return result(
          "botao_ausente",
          "O botão Renovar não apareceu no menu de ações do cliente na tela do painel. O painel pode ter mudado a tela. Nenhum crédito foi consumido.",
        );
      }
      const visible = await renewItem.isVisible().catch(() => false);
      const enabled = await renewItem.isEnabled().catch(() => false);
      await page.keyboard.press("Escape").catch(() => {});
      if (!visible || !enabled) {
        return result(
          "botao_ausente",
          "O botão Renovar apareceu no menu de ações, mas está invisível ou desabilitado para este cliente. Nenhum crédito foi consumido.",
        );
      }
      return result(
        "encontrado",
        "O botão Renovar foi localizado na tela do painel para este cliente. Nada foi clicado e nenhum crédito foi consumido — o clique real fica para a próxima etapa, com a sua autorização.",
      );
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (/executable doesn't exist|browser.*not found|failed to launch/i.test(raw)) {
        return result(
          "erro",
          "O navegador de automação não está instalado neste servidor, por isso a localização do botão não pôde rodar. A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      if (/timeout|timed out/i.test(raw)) {
        return result(
          "erro",
          "O painel demorou demais para responder e a localização parou por tempo esgotado (60 segundos). A renovação continua pendente e nenhum crédito foi consumido.",
        );
      }
      return result(
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
    return result(
      "erro",
      "O painel demorou demais para responder e a localização parou por tempo esgotado (60 segundos). A renovação continua pendente e nenhum crédito foi consumido.",
    );
  }
}
