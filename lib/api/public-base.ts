import type { NextRequest } from "next/server";

import { env } from "@/lib/env";

/**
 * Base pública desta instalação — o que o operador cola em painéis externos e o que
 * enviamos a terceiros como callback.
 *
 * `env.*` e NÃO `process.env.NEXT_PUBLIC_APP_URL` direto: variáveis `NEXT_PUBLIC_` são
 * substituídas no BUILD, e a imagem genérica do self-host é construída com
 * `https://placeholder.invalid` (Dockerfile). Lendo direto do `process.env`, a URL
 * apontaria para o nada, sem erro em lugar nenhum.
 */
export function publicBase(req: NextRequest): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  return usavel ?? req.headers.get("origin") ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
}
