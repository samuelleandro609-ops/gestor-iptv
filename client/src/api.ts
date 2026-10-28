// Cliente RPC da versão externa: POST {action, args} para ./actions e
// devolve body.data (ou lança Error com body.error), o mesmo protocolo
// que o cliente original usava com o SDK do Muse. Sem SDK, sem login
// do Muse. Os tipos vêm de server/src/actions.ts (import type-only).

import type { Actions } from "../../server/src/actions";
import type { z } from "zod";

type ActionClient<A extends Record<string, { request: z.ZodType; response: z.ZodType }>> = {
  [K in keyof A]: (
    args: z.infer<A[K]["request"]>,
  ) => Promise<z.infer<A[K]["response"]>>;
};

export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];
export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;

// Sessão de login: o token é injetado em todas as chamadas — o servidor
// usa ele para saber de qual conta são os dados. A página pública da
// fatura não usa login: as ações dela ignoram o campo.
//
// O token fica guardado EM MEMÓRIA (variável do módulo) como fonte
// principal durante a visita, e no localStorage só como persistência
// entre visitas. Isso é essencial: dentro de alguns navegadores o
// localStorage pode falhar em silêncio — se o cliente dependesse só
// dele, o login "sumia" logo depois de entrar.
const SESSION_KEY = "gestor-iptv-session";

let memoryToken: string | null = null;

export function getSessionToken(): string {
  if (memoryToken !== null) return memoryToken;
  try {
    memoryToken = window.localStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    memoryToken = "";
  }
  return memoryToken;
}

export function setSessionToken(token: string): void {
  memoryToken = token;
  try {
    if (token) window.localStorage.setItem(SESSION_KEY, token);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Sem armazenamento disponível, a sessão vale só para esta visita —
    // o token em memória acima mantém o login funcionando nela.
  }
}

function resolveEndpoint(): string {
  const href = globalThis.location?.href;
  if (typeof href !== "string" || href.length === 0) return "./actions";
  const base = new URL(href);
  base.hash = "";
  base.search = "";
  return new URL("./actions", base).toString();
}

function createActionClient(): ActionClient<typeof Actions> {
  const endpoint = resolveEndpoint();
  const callAction = async (action: string, args: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args: args ?? {}, actionCallId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok || (body && typeof body === "object" && "error" in body && body.error)) {
      throw new Error(`action ${action} error: ${String(body?.error ?? response.status)}`);
    }
    return body.data;
  };
  return new Proxy({} as ActionClient<typeof Actions>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "then" || name === "catch" || name === "finally") return undefined;
      return (args: Record<string, unknown> = {}) => callAction(name, args);
    },
  });
}

const rawApi = createActionClient();

export const api = new Proxy(rawApi, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (args: Record<string, unknown> = {}) => {
      // Um token passado explicitamente na chamada (ex.: a verificação
      // de login logo após entrar) vale mais que o guardado: nunca
      // sobrescrever um token explícito com o valor do armazenamento.
      const explicit =
        typeof args.session === "string" && args.session
          ? (args.session as string)
          : null;
      return (value as (a: Record<string, unknown>) => unknown).call(target, {
        ...args,
        session: explicit ?? getSessionToken(),
      });
    };
  },
}) as typeof rawApi;
