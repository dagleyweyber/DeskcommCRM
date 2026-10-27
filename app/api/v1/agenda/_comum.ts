/**
 * Peças repetidas pelas rotas de configuração da Agenda (salas, horário da
 * clínica, bloqueios, serviços) — validação do corpo com o mesmo formato de
 * erro de `validateRequest` + `fail()` que as demais rotas do repo devolvem.
 */
import type { ZodSchema } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail } from "@/lib/api/wrappers";
import { validateRequest } from "@/lib/schemas";

export async function lerCorpo<T>(
  schema: ZodSchema<T>,
  req: Request,
  requestId: string,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, data: await validateRequest(schema, req) };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        response: fail(err.code, err.message, err.status, {
          details: err.details as Record<string, unknown> | undefined,
          requestId,
        }),
      };
    }
    throw err;
  }
}
