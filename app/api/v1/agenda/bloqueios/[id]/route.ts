/** DELETE /api/v1/agenda/bloqueios/[id] — remove um bloqueio de sala/clínica (manager+). */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const authz = await requireRole("manager", { requestId, resource: "calendar_availability_exceptions" });
  if (!authz.ok) return authz.response;

  const { data, error } = await supabase
    .from("calendar_availability_exceptions")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .is("user_id", null)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Bloqueio não encontrado.", 404, { requestId });

  await audit({
    action: "calendar_block.deleted",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "calendar_availability_exception",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
