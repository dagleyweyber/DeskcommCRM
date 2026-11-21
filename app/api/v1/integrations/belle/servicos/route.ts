/** Ligação de serviços do Belle — lógica em `lib/agenda-externa/servicos-handler.ts`. */
import type { NextRequest } from "next/server";

import { PROVEDOR } from "@/lib/agenda-externa/provedor";
import { getServicos, patchServicos } from "@/lib/agenda-externa/servicos-handler";

export const dynamic = "force-dynamic";

export const GET = (): Promise<Response> => getServicos(PROVEDOR);
export const PATCH = (req: NextRequest): Promise<Response> => patchServicos(req, PROVEDOR);
