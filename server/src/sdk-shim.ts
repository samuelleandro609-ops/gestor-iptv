import { z } from "zod";

// Substituto local do `defineAction` do SDK do Muse. Mantém exatamente o
// formato usado em actions.ts: cada ação declara `request`/`response`
// (zod) e um `handler(ctx, args)`. A validação acontece no dispatcher
// do servidor (server.ts), não aqui — este módulo só carrega a definição.
export { z };

export type PrivilegedContractLike = {
  name: string;
  request: z.ZodType;
  response: z.ZodType;
};

export type Ctx = {
  /** Acesso ao banco Drizzle. O genérico existe só para o código
   *  original (`ctx.db<typeof schema>()`) continuar compilando. */
  db: <_TSchema = unknown>() => any;
  executePrivileged: <C extends PrivilegedContractLike>(
    contract: C,
    args: z.infer<C["request"]>,
  ) => Promise<z.infer<C["response"]>>;
  /** No Muse isto invalidava o cache do React Query no servidor; fora
   *  dele não há cache de servidor — é um no-op de propósito. */
  invalidateQueries: () => void;
};

export type ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> = {
  request: Req;
  response: Res;
  privileged?: readonly PrivilegedContractLike[];
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
};

export function defineAction<
  Req extends z.ZodType,
  Res extends z.ZodType,
>(spec: {
  request: Req;
  response: Res;
  privileged?: readonly PrivilegedContractLike[];
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): ActionDefinition<Req, Res> {
  return spec;
}

export type ActionsModule = Record<
  string,
  {
    request: z.ZodType;
    response: z.ZodType;
    handler: (ctx: Ctx, args: any) => Promise<any>;
  }
>;
