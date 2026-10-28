import { spawn } from "node:child_process";
import {
existsSync,
mkdirSync,
readFileSync,
rmSync,
writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Serviço de sessão do WhatsApp INTERNO do gestor: um processo Node
// por conta, persistente, que mantém a conexão com o WhatsApp (via
// Baileys) e grava o estado (status, QR Code em imagem, número) em
// status.json dentro da pasta da conta. Apertar "Gerar QR Code" sobe
// o processo; ele emite o QR real do pareamento, mantém a sessão
// salva (auth/) e reconecta sozinho — fica conectado até a dona da
// conta tocar em Desconectar (logout.request).
//
// A ponte local (bridge) existe porque, nesta rede, a resposta 101 do
// WhatsApp chega com "Connection: close" e o cliente websocket comum
// a rejeita: a ponte faz o handshake com o WhatsApp manualmente
// (CONNECT no proxy + TLS) e repassa os quadros para o Baileys por
// 127.0.0.1, com a versão atual do WhatsApp Web informada.

const waStatusShape = z.object({
  running: z.boolean(),
  status: z.string(),
  phone: z.string(),
  qrImage: z.string(),
  detail: z.string(),
  updatedAt: z.number(),
});

export const privileged = {
  waStart: {
    name: "waStart",
    request: z.object({ accountId: z.number().int().positive() }),
    response: z.object({
      running: z.boolean(),
      status: z.string(),
      phone: z.string(),
      qrImage: z.string(),
      detail: z.string(),
      updatedAt: z.number(),
    }),
  },
  waStatus: {
    name: "waStatus",
    request: z.object({ accountId: z.number().int().positive() }),
    response: z.object({
      running: z.boolean(),
      status: z.string(),
      phone: z.string(),
      qrImage: z.string(),
      detail: z.string(),
      updatedAt: z.number(),
    }),
  },
  waStop: {
    name: "waStop",
    request: z.object({ accountId: z.number().int().positive() }),
    response: z.object({
      running: z.boolean(),
      status: z.string(),
      phone: z.string(),
      qrImage: z.string(),
      detail: z.string(),
      updatedAt: z.number(),
    }),
  },
  // Envio AUTOMÁTICO de uma mensagem pelo WhatsApp já conectado
  // desta conta: o serviço de sessão (processo persistente) recebe o
  // pedido por arquivo, manda pelo socket aberto e devolve o
  // resultado — enviado ou o motivo simples da falha.
  waSend: {
    name: "waSend",
    request: z.object({
      accountId: z.number().int().positive(),
      to: z.string().min(8).max(20),
      text: z.string().min(1).max(2000),
    }),
    response: z.object({
      sent: z.boolean(),
      status: z.string(),
      detail: z.string(),
    }),
  },
};

const SERVICE_SOURCE = `
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ACCOUNT_DIR = process.env.WA_ACCOUNT_DIR;
const SPACE_ROOT = process.env.WA_SPACE_ROOT;
const AUTH_DIR = join(ACCOUNT_DIR, "auth");
const STATUS_FILE = join(ACCOUNT_DIR, "status.json");
const LOGOUT_FILE = join(ACCOUNT_DIR, "logout.request");
mkdirSync(AUTH_DIR, { recursive: true });
writeFileSync(join(ACCOUNT_DIR, "pid"), String(process.pid));
// Um servico novo so sobe porque alguem tocou em "Gerar QR Code" (ou
// porque o gestor quer reconectar a sessao salva): qualquer pedido de
// logout que tenha ficado de uma desconexao anterior ja foi atendido
// e NAO pode derrubar esta sessao nova. Apagar aqui e essencial: sem
// isso, o laco de 1,5s lia o arquivo velho, encerrava o processo em
// segundos e o QR Code nunca aparecia, tentativa apos tentativa.
try { rmSync(LOGOUT_FILE, { force: true }); } catch {}

let currentStatus = { status: "iniciando", phone: "", qrImage: "", detail: "Abrindo a sessao do WhatsApp...", updatedAt: Date.now() };
function setStatus(patch) {
  currentStatus = { ...currentStatus, ...patch, updatedAt: Date.now() };
  try {
    writeFileSync(STATUS_FILE + ".tmp", JSON.stringify(currentStatus));
    renameSync(STATUS_FILE + ".tmp", STATUS_FILE);
  } catch {}
}
setStatus({});

const req = createRequire(join(SPACE_ROOT, "package.json"));
async function loadPkg(name) {
  const p = req.resolve(name);
  return import(pathToFileURL(p).href);
}

function startBridge() {
  return new Promise((resolvePromise) => {
    const server = http.createServer();
    server.on("upgrade", (request, clientSocket) => {
      const key = request.headers["sec-websocket-key"];
      const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      clientSocket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
      upstream(request.url || "/ws/chat").then((up) => {
        clientSocket.pipe(up).pipe(clientSocket);
        clientSocket.on("error", () => up.destroy());
        up.on("error", () => clientSocket.destroy());
      }).catch(() => clientSocket.destroy());
    });
    server.listen(0, "127.0.0.1", () => resolvePromise(server.address().port));
  });
}

function upstream(path) {
  return new Promise((resolvePromise, reject) => {
    const proxyEnv = process.env.https_proxy || process.env.HTTPS_PROXY || "";
    const doTls = (raw) => {
      const t = tls.connect({ socket: raw, servername: "web.whatsapp.com" }, () => {
        const key = crypto.randomBytes(16).toString("base64");
        t.write("GET " + path + " HTTP/1.1\\r\\nHost: web.whatsapp.com\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: " + key + "\\r\\nSec-WebSocket-Version: 13\\r\\nOrigin: https://web.whatsapp.com\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36\\r\\n\\r\\n");
      });
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf("\\r\\n\\r\\n");
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        t.removeListener("data", onData);
        if (!head.includes("101")) { reject(new Error("upstream nao respondeu 101: " + head.split("\\r\\n")[0])); t.destroy(); return; }
        const rest = buf.slice(idx + 4);
        if (rest.length) t.unshift(rest);
        resolvePromise(t);
      };
      t.on("data", onData);
      t.on("error", reject);
    };
    if (!proxyEnv) {
      const raw = net.connect(443, "web.whatsapp.com", () => doTls(raw));
      raw.on("error", reject);
      return;
    }
    let p;
    try { p = new URL(proxyEnv); } catch { reject(new Error("proxy invalido")); return; }
    const auth = p.username ? "Proxy-Authorization: Basic " + Buffer.from(decodeURIComponent(p.username) + ":" + decodeURIComponent(p.password)).toString("base64") + "\\r\\n" : "";
    const raw = net.connect(Number(p.port), p.hostname, () => {
      raw.write("CONNECT web.whatsapp.com:443 HTTP/1.1\\r\\nHost: web.whatsapp.com:443\\r\\n" + auth + "Proxy-Connection: Keep-Alive\\r\\n\\r\\n");
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf("\\r\\n\\r\\n");
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString();
      raw.removeListener("data", onData);
      if (!/ 200 /.test(head)) { reject(new Error("CONNECT falhou: " + head.split("\\r\\n")[0])); raw.destroy(); return; }
      const rest = buf.slice(idx + 4);
      if (rest.length) raw.unshift(rest);
      doTls(raw);
    };
    raw.on("data", onData);
    raw.on("error", reject);
  });
}

const silentLogger = { level: "silent" };
silentLogger.child = () => silentLogger;
for (const m of ["info", "debug", "warn", "error", "trace", "fatal"]) silentLogger[m] = () => {};

let sock = null;
let stopping = false;
let retryDelay = 3000;
let isOpen = false;
let recoveredFromLogout = false;

async function connect(baileys, QRCode, port, version) {
  if (stopping) return;
  const { state, saveCreds } = await baileys.useMultiFileAuthState(AUTH_DIR);
  sock = baileys.makeWASocket({
    auth: state,
    logger: silentLogger,
    waWebSocketUrl: "ws://127.0.0.1:" + port + "/ws/chat",
    browser: ["Gestor IPTV", "Chrome", "1.0"],
    version,
    connectTimeoutMs: 30000,
    qrTimeout: 60000,
    keepAliveIntervalMs: 25000,
    syncFullHistory: false,
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      recoveredFromLogout = false;
      try {
        const img = await QRCode.toDataURL(u.qr, { margin: 1, width: 264 });
        setStatus({ status: "aguardando_leitura", qrImage: img, detail: "QR Code pronto: abra o WhatsApp do celular em Aparelhos conectados e leia o codigo." });
      } catch {}
    }
    if (u.connection === "open") {
      isOpen = true;
      recoveredFromLogout = false;
      retryDelay = 3000;
      const rawId = (sock.user && sock.user.id) || "";
      const phone = rawId.split(":")[0].split("@")[0] || "";
      setStatus({ status: "conectado", phone, qrImage: "", detail: "WhatsApp conectado pelo QR Code. Ele fica conectado ate voce desconectar aqui no gestor." });
    }
    if (u.connection === "close") {
      isOpen = false;
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      const loggedOut = code === 401 || code === baileys.DisconnectReason.loggedOut;
      if (stopping) {
        // Desconexao pedida pela dona da conta (arquivo de logout):
        // encerra de verdade. Antes de sair, garante que nenhum
        // pedido de logout fique para tras.
        try { rmSync(LOGOUT_FILE, { force: true }); } catch {}
        setStatus({ status: "desconectado", phone: "", qrImage: "", detail: "Sessao encerrada. Para conectar de novo, toque em Gerar QR Code." });
        process.exit(0);
      }
      if (loggedOut) {
        // A sessao SALVA foi revogada pelo WhatsApp (401): o
        // aparelho foi encerrado do lado do WhatsApp. Era este o
        // beco sem saida da conta que ja conectou uma vez: com a
        // credencial morta ainda no disco, o Baileys NUNCA emite um
        // QR Code novo — ele tenta entrar com a sessao morta,
        // recebe 401 e cai em segundos, tentativa apos tentativa
        // (a tela "carrega um pouquinho" e nao aparece nada).
        // Saida: apagar SO a autenticacao morta e reconectar NO
        // MESMO processo como pareamento novo — o QR Code sai
        // nesta mesma tentativa de "Gerar QR Code". Se o WhatsApp
        // revogar de novo logo depois da limpeza (sem QR e sem
        // conexao), encerra: a autenticacao ja esta limpa e o
        // proximo toque comeca do zero.
        if (recoveredFromLogout) {
          try { rmSync(LOGOUT_FILE, { force: true }); } catch {}
          setStatus({ status: "desconectado", phone: "", qrImage: "", detail: "Sessao encerrada. Para conectar de novo, toque em Gerar QR Code." });
          process.exit(0);
        }
        recoveredFromLogout = true;
        try { if (sock) { sock.ev.removeAllListeners("connection.update"); sock.ev.removeAllListeners("creds.update"); } } catch {}
        try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        try { mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
        setStatus({ status: "iniciando", phone: "", qrImage: "", detail: "A sessao salva nao vale mais (o WhatsApp encerrou esse aparelho). Gerando um QR Code novo para conectar de novo..." });
        setTimeout(() => { connect(baileys, QRCode, port, version).catch(reportFatal); }, 1500);
        return;
      }
      setStatus({ status: "iniciando", qrImage: "", detail: "A conexao caiu e o gestor esta reconectando sozinho..." });
      setTimeout(() => { connect(baileys, QRCode, port, version).catch(reportFatal); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    }
  });
}

function reportFatal(e) {
  setStatus({ status: "erro", qrImage: "", detail: "O servico de sessao do WhatsApp nao conseguiu abrir a conexao (" + (e && e.message ? e.message : String(e)) + "). Toque em Gerar QR Code para tentar de novo." });
}

async function main() {
  try { writeFileSync(join(ACCOUNT_DIR, "service-version"), "4"); } catch {}
  const baileys = await loadPkg("@whiskeysockets/baileys");
  const QRCode = (await loadPkg("qrcode")).default;
  const port = await startBridge();
  let version;
  try {
    const v = await baileys.fetchLatestBaileysVersion();
    version = v.version;
  } catch {}
  await connect(baileys, QRCode, port, version);
  setInterval(async () => {
    // Pedidos de envio do gestor (botao "Enviar mensagem" em
    // Clientes): arquivos send-<id>.json nesta pasta. O resultado de
    // cada pedido vai em send-<id>.result.json para o gestor ler se
    // foi enviado ou o motivo de nao ter sido.
    try {
      const files = readdirSync(ACCOUNT_DIR).filter((f) => f.startsWith("send-") && f.endsWith(".json") && !f.endsWith(".result.json"));
      for (const f of files) {
        const full = join(ACCOUNT_DIR, f);
        let job = null;
        try { job = JSON.parse(readFileSync(full, "utf8")); } catch {}
        try { rmSync(full, { force: true }); } catch {}
        if (!job) continue;
        const resultFile = full.replace(/\.json$/, ".result.json");
        if (!isOpen || !sock) {
          try { writeFileSync(resultFile, JSON.stringify({ sent: false, detail: "O WhatsApp nao esta conectado neste momento. Abra a aba WhatsApp do gestor, confira a conexao e tente de novo." })); } catch {}
          continue;
        }
        try {
          const jid = String(job.to || "").replace(/\D/g, "") + "@s.whatsapp.net";
          await sock.sendMessage(jid, { text: String(job.text || "") });
          try { writeFileSync(resultFile, JSON.stringify({ sent: true, detail: "Mensagem enviada pelo WhatsApp conectado." })); } catch {}
        } catch (e) {
          try { writeFileSync(resultFile, JSON.stringify({ sent: false, detail: "O WhatsApp recusou o envio agora (" + (e && e.message ? e.message : String(e)) + "). Tente de novo em alguns segundos." })); } catch {}
        }
      }
    } catch {}
    if (existsSync(LOGOUT_FILE)) {
      stopping = true;
      // Apaga o pedido PRIMEIRO: o logout fecha a conexao e o
      // tratador de "close" chama process.exit(0) na hora — se o
      // arquivo fosse apagado so depois do await, a saida ganhava a
      // corrida e o pedido orfao derrubava a proxima sessao.
      try { rmSync(LOGOUT_FILE, { force: true }); } catch {}
      try { if (sock) await sock.logout(); } catch {}
      try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
      setStatus({ status: "desconectado", phone: "", qrImage: "", detail: "WhatsApp desconectado por voce. Para conectar de novo, toque em Gerar QR Code." });
      process.exit(0);
    }
  }, 1500);
}
main().catch(reportFatal);
`;

function dataBaseDir(): string {
  const fromEnv = process.env.GESTOR_DATA_DIR;
  if (fromEnv) return fromEnv;
  return join(process.cwd(), ".gestor-data");
}

function accountDir(accountId: number): string {
  return join(dataBaseDir(), `wa-${accountId}`);
}

function resolveSpaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), ".."),
    resolve(process.cwd(), "../.."),
    resolve(here, "..", ".."),
    resolve(here, "..", "..", ".."),
    resolve(here, ".."),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "node_modules", "@whiskeysockets", "baileys"))) return c;
  }
  return process.cwd();
}

function resolveNodeBin(): string {
  // O serviço de sessão do WhatsApp roda em Node. No Dockerfile desta
  // versão o Node é instalado junto ao Bun; se ele não existir no
  // PATH, o Bun (process.execPath) executa o mesmo script .mjs como
  // último recurso. Se nenhum dos dois abrir a sessão, o erro aparece
  // na tela em linguagem simples — nenhum QR Code é inventado.
  if (existsSync("/usr/bin/node")) return "/usr/bin/node";
  if (existsSync("/usr/local/bin/node")) return "/usr/local/bin/node";
  return process.execPath.includes("bun") ? process.execPath : "node";
}

type WaStatusFile = {
  status: string;
  phone: string;
  qrImage: string;
  detail: string;
  updatedAt: number;
};

function readStatus(accountId: number): z.infer<typeof waStatusShape> {
  const dir = accountDir(accountId);
  let running = false;
  try {
    const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        running = false;
      }
    }
  } catch {
    running = false;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, "status.json"), "utf8"),
    ) as WaStatusFile;
    return {
      running,
      status: parsed.status || "desconectado",
      phone: parsed.phone || "",
      qrImage: parsed.qrImage || "",
      detail: parsed.detail || "",
      updatedAt: parsed.updatedAt || 0,
    };
  } catch {
    return {
      running,
      status: "desconectado",
      phone: "",
      qrImage: "",
      detail: "",
      updatedAt: 0,
    };
  }
}

// Versão do código do serviço de sessão. A v2 ganhou o envio de
// mensagens (pedidos send-<id>.json). A v3 corrige o pedido de
// logout órfão: a v2 podia encerrar deixando logout.request no
// disco, e esse arquivo derrubava toda sessão nova em segundos —
// o QR Code nunca aparecia. A v4 corrige a conta que JÁ conectou
// uma vez: quando o WhatsApp revoga a sessão salva (401), o
// serviço apaga a autenticação morta e gera um QR Code novo na
// mesma tentativa, em vez de cair e deixar a credencial morta
// bloqueando toda geração seguinte. Um serviço antigo ainda
// rodando é reiniciado UMA vez: o login salvo em auth/ é
// reaproveitado e ele reconecta sozinho, sem precisar ler QR
// Code de novo.
const SERVICE_VERSION = 4;

function readServiceVersion(accountId: number): number {
  try {
    const v = Number(
      readFileSync(join(accountDir(accountId), "service-version"), "utf8").trim(),
    );
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waNotConnectedDetail(st: z.infer<typeof waStatusShape>): string {
  if (st.status === "aguardando_leitura") {
    return "O WhatsApp ainda não está conectado: abra a aba WhatsApp do gestor, gere o QR Code e leia com o celular. Depois tente enviar de novo.";
  }
  if (st.status === "iniciando") {
    return "O WhatsApp está conectando agora. Aguarde alguns segundos e tente enviar de novo.";
  }
  if (st.status === "erro") {
    return st.detail || "O serviço do WhatsApp está com erro. Abra a aba WhatsApp do gestor e confira a conexão.";
  }
  return "O WhatsApp não está conectado. Abra a aba WhatsApp do gestor, toque em “Gerar QR Code” e conecte para poder enviar mensagens.";
}

function ensureService(accountId: number): z.infer<typeof waStatusShape> {
  const dir = accountDir(accountId);
  mkdirSync(dir, { recursive: true });
  // Quem chama quer a sessão NO AR (gerar QR ou reconectar): um
  // pedido de logout esquecido de uma desconexão anterior já foi
  // atendido e não pode derrubar a sessão que está subindo.
  try {
    rmSync(join(dir, "logout.request"), { force: true });
  } catch {}
  const current = readStatus(accountId);
  if (current.running) return current;
  const base = dataBaseDir();
  mkdirSync(base, { recursive: true });
  const scriptPath = join(base, "wa-service.mjs");
  writeFileSync(scriptPath, SERVICE_SOURCE);
  const child = spawn(resolveNodeBin(), [scriptPath], {
    cwd: resolveSpaceRoot(),
    env: {
      ...process.env,
      WA_ACCOUNT_DIR: dir,
      WA_SPACE_ROOT: resolveSpaceRoot(),
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    running: true,
    status: "iniciando",
    phone: "",
    qrImage: "",
    detail: "Abrindo a sessão do WhatsApp… o QR Code aparece em alguns segundos.",
    updatedAt: Date.now(),
  };
}

export const privilegedHandlers: Record<string, (args: any) => any> = {
  async waStart(args) {
    // Serviço antigo ainda rodando (ex.: a v2, que deixava o pedido
    // de logout órfão e derrubava a sessão seguinte): reinicia uma
    // vez com o código novo. O login salvo em auth/ é reaproveitado
    // — se a sessão estava conectada, ela reconecta sozinha; se
    // estava desconectada, o serviço novo emite o QR Code.
    const dir = accountDir(args.accountId);
    const st = readStatus(args.accountId);
    if (st.running && readServiceVersion(args.accountId) < SERVICE_VERSION) {
      try {
        const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
        if (pid > 0) process.kill(pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 12 && readStatus(args.accountId).running; i++) {
        await sleep(500);
      }
    }
    // Conta que JÁ conectou uma vez e cuja sessão morreu: o
    // serviço anterior gravou "Sessao encerrada" (o WhatsApp
    // revogou o aparelho, HTTP 401) e saiu, mas deixou as
    // credenciais mortas em auth/. Com elas no disco, o serviço
    // novo tenta entrar com a sessão morta, cai em segundos e
    // NUNCA emite QR Code — a tela só "carrega um pouquinho" e
    // não aparece nada, tentativa após tentativa. Como quem
    // chamou quer gerar QR (ou reconectar), a limpeza certa é
    // apagar SÓ a autenticação morta — a conta e todos os dados
    // do gestor ficam intactos — e subir o serviço já como
    // pareamento novo, que emite o QR Code. (Se a sessão salva
    // estiver VÁLIDA, o estado gravado é conectado/iniciando e
    // nada é apagado: ela reconecta sozinha, sem QR.)
    const beforeStart = readStatus(args.accountId);
    if (
      !beforeStart.running &&
      beforeStart.status === "desconectado" &&
      beforeStart.detail.startsWith("Sessao encerrada")
    ) {
      try {
        rmSync(join(dir, "auth"), { recursive: true, force: true });
      } catch {}
    }
    const started = ensureService(args.accountId);
    // Recém-disparado: o processo novo leva alguns instantes para
    // gravar o próprio pid e o status "iniciando" — até lá, uma
    // leitura (waStatus) ainda enxerga o pid morto e o status
    // "desconectado" do serviço anterior. Esperar o processo novo
    // aparecer (até ~5s) evita que quem chamou conclua, errado,
    // que o serviço "encerrou antes de emitir o QR Code" bem na
    // janela da religação. Se ele já estava no ar, a primeira
    // leitura já vem running e o laço nem gira.
    for (let i = 0; i < 10; i++) {
      const st = readStatus(args.accountId);
      if (st.running) return st;
      await sleep(500);
    }
    return started;
  },
  async waSend(args) {
    const dir = accountDir(args.accountId);
    mkdirSync(dir, { recursive: true });
    let st = readStatus(args.accountId);
    // Serviço antigo (sem a função de envio) ainda rodando:
    // reinicia uma vez reaproveitando o login salvo.
    if (st.running && readServiceVersion(args.accountId) < SERVICE_VERSION) {
      try {
        const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
        if (pid > 0) process.kill(pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 12 && readStatus(args.accountId).running; i++) {
        await sleep(500);
      }
      st = readStatus(args.accountId);
    }
    if (!st.running) {
      ensureService(args.accountId);
    }
    // Espera a (re)conexão automática com o login salvo.
    for (let i = 0; i < 20; i++) {
      st = readStatus(args.accountId);
      if (st.status === "conectado") break;
      if (!st.running && st.status === "desconectado") break;
      await sleep(1000);
    }
    st = readStatus(args.accountId);
    if (st.status !== "conectado") {
      return { sent: false, status: st.status, detail: waNotConnectedDetail(st) };
    }
    let num = args.to.replace(/\D/g, "");
    if (num && !num.startsWith("55") && num.length <= 11) num = `55${num}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reqFile = join(dir, `send-${id}.json`);
    const resFile = join(dir, `send-${id}.result.json`);
    writeFileSync(reqFile, JSON.stringify({ to: num, text: args.text }));
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const parsed = JSON.parse(readFileSync(resFile, "utf8")) as {
          sent?: boolean;
          detail?: string;
        };
        try {
          rmSync(resFile, { force: true });
        } catch {}
        return {
          sent: parsed.sent === true,
          status: "conectado",
          detail:
            parsed.detail ||
            (parsed.sent
              ? "Mensagem enviada pelo WhatsApp conectado."
              : "O envio não foi confirmado pelo WhatsApp."),
        };
      } catch {}
    }
    try {
      rmSync(reqFile, { force: true });
    } catch {}
    return {
      sent: false,
      status: st.status,
      detail:
        "O serviço do WhatsApp não respondeu ao pedido de envio. Confira a conexão na aba WhatsApp e tente de novo.",
    };
  },
  waStatus(args) {
    return readStatus(args.accountId);
  },
  waStop(args) {
    const dir = accountDir(args.accountId);
    mkdirSync(dir, { recursive: true });
    const current = readStatus(args.accountId);
    if (!current.running) {
      // Sem serviço no ar, NÃO gravar logout.request: o arquivo
      // ficava esquecido no disco e a próxima sessão o lia como um
      // pedido novo, encerrando em segundos — o QR Code nunca
      // aparecia. Aqui a desconexão é só o estado gravado.
      try {
        rmSync(join(dir, "logout.request"), { force: true });
      } catch {}
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({
          status: "desconectado",
          phone: "",
          qrImage: "",
          detail:
            "WhatsApp desconectado. Para conectar de novo, toque em “Gerar QR Code”.",
          updatedAt: Date.now(),
        }),
      );
      return { ...current, running: false, status: "desconectado", phone: "", qrImage: "" };
    }
    // Serviço no ar: ele atende o pedido em até ~1,5s, apaga o
    // próprio arquivo e encerra.
    writeFileSync(join(dir, "logout.request"), String(Date.now()));
    return current;
  },
};
