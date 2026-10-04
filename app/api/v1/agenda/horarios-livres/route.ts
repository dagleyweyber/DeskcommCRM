/**
 * GET /api/v1/agenda/horarios-livres — a MESMA função que a ferramenta MCP
 * do agente de IA chama (`lib/agenda/consulta.ts`'s `horariosLivresDaOrg`) —
 * garante que a tela e a IA nunca discordem sobre o que está livre.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { TipoDeCompromissoInvalido, horariosLivresDaOrg } from "@/lib/agenda/consulta";
import { horariosLivresQuerySchema } from "@/lib/schemas/agenda";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const authz = await requireRole("agent", { requestId, resource: "calendar_appointments" });
  if (!authz.ok) return authz.response;

  const { searchParams } = new URL(req.url);
  const parsed = horariosLivresQuerySchema.safeParse({
    event_type_id: searchParams.get("event_type_id"),
    owner_user_id: searchParams.get("owner_user_id") ?? undefined,
  });
  if (!parsed.success) {
    return fail("unprocessable_entity", "Informe event_type_id (uuid).", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const { horarios } = await horariosLivresDaOrg(supabase, {
      organizationId: authz.org.orgId,
      eventTypeId: parsed.data.event_type_id,
      ownerUserId: parsed.data.owner_user_id ?? "",
      agora: new Date(),
    });
    return ok(horarios, { requestId });
  } catch (err) {
    if (err instanceof TipoDeCompromissoInvalido) {
      return fail("not_found", "Tipo de compromisso inválido ou inativo.", 404, { requestId });
    }
    throw err;
  }
}
