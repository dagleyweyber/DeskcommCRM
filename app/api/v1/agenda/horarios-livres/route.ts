/**
 * GET /api/v1/agenda/horarios-livres — a MESMA função que a ferramenta MCP
 * do agente de IA chama (`lib/agenda/consulta.ts`'s `horariosLivresDaOrg`) —
 * garante que a tela e a IA nunca discordem sobre o que está livre.
 *
 * `data` (YYYY-MM-DD): a tela escolhe o dia no calendário e pede só ele —
 * sem isso a lista cortava nos primeiros horários e não passava de ~3 dias.
 * `room_id` ausente = qualquer sala permitida para o serviço.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { SalaInvalida, TipoDeCompromissoInvalido, horariosLivresDaOrg } from "@/lib/agenda/consulta";
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
    room_id: searchParams.get("room_id") || undefined,
    data: searchParams.get("data") || undefined,
    ignorar_id: searchParams.get("ignorar_id") || undefined,
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
      roomId: parsed.data.room_id ?? null,
      data: parsed.data.data ?? null,
      ignorarCompromissoId: parsed.data.ignorar_id ?? null,
      agora: new Date(),
      origem: "equipe",
    });
    return ok(horarios, { requestId });
  } catch (err) {
    if (err instanceof TipoDeCompromissoInvalido) {
      return fail("not_found", "Tipo de compromisso inválido ou inativo.", 404, { requestId });
    }
    if (err instanceof SalaInvalida) {
      return fail("unprocessable_entity", "Esta sala não está disponível para este serviço.", 422, { requestId });
    }
    throw err;
  }
}
