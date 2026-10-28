import type { Ctx, PrivilegedContractLike } from "./sdk-shim";
import type { Db } from "./db";
import { privilegedHandlers } from "./privileged";
import { z } from "zod";

/** Contexto entregue a cada handler de actions.ts, equivalente ao Ctx
 *  do SDK: banco via ctx.db(), WhatsApp via ctx.executePrivileged() e
 *  invalidateQueries como no-op. */
export function createCtx(db: Db): Ctx {
  return {
    db: () => db,
    invalidateQueries: () => {},
    executePrivileged: async <C extends PrivilegedContractLike>(
      contract: C,
      args: z.infer<C["request"]>,
    ): Promise<z.infer<C["response"]>> => {
      const parsedArgs = contract.request.safeParse(args);
      if (!parsedArgs.success) {
        throw new Error(`Pedido inválido para o serviço do WhatsApp: ${parsedArgs.error.message}`);
      }
      const handler = privilegedHandlers[contract.name];
      if (!handler) {
        throw new Error(`Serviço do WhatsApp indisponível: ${contract.name}`);
      }
      const raw = await handler(parsedArgs.data);
      const parsedRes = contract.response.safeParse(raw);
      if (!parsedRes.success) {
        throw new Error(`Resposta inválida do serviço do WhatsApp: ${parsedRes.error.message}`);
      }
      return parsedRes.data as z.infer<C["response"]>;
    },
  };
}
