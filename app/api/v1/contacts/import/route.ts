/**
 * POST /api/v1/contacts/import — um lote de importação de contatos por planilha.
 *
 * Thin wrapper: papel + Zod + ok/fail. Lógica em ./_handler.ts.
 *
 * `manager`+: importar põe milhares de pessoas no público de campanha de uma
 * vez — não é o mesmo gesto de cadastrar um contato (que é `agent`+).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { importLoteSchema, importarLoteHandler, type ImportLote } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  let input: ImportLote;
  try {
    input = (await validateRequest(importLoteSchema, req)) as ImportLote;
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const supabase = await createClient();
    const result = await importarLoteHandler(
      supabase,
      { organization_id: authz.org.orgId, actor: { type: "user", id: authz.user.id }, requestId },
      input,
    );
    return ok(result, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
