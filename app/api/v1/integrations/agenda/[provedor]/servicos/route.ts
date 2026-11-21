/** Ligação de serviços do Uno/Zandu — lógica em `lib/agenda-externa/servicos-handler.ts`. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { getServicos, patchServicos } from "@/lib/agenda-externa/servicos-handler";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ provedor: string }>;
}

async function provedorDe(ctx: RouteCtx): Promise<"uno" | "zandu" | null> {
  const { provedor } = await ctx.params;
  return provedor === "uno" || provedor === "zandu" ? provedor : null;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const p = await provedorDe(ctx);
  return p ? getServicos(p) : fail("not_found", "Sistema desconhecido.", 404, { requestId: randomUUID() });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const p = await provedorDe(ctx);
  return p ? patchServicos(req, p) : fail("not_found", "Sistema desconhecido.", 404, { requestId: randomUUID() });
}
