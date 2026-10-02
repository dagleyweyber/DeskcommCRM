import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isPublicPath } from "@/lib/auth/public-paths";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";

const COOKIE_NAME = "sb-deskcomm-auth";

/**
 * Superfícies secretas-mas-sem-conta: crons, rotas internas, MCP e o heartbeat
 * do agente do host. Cada uma já se defende com um bearer/secret comparado em
 * tempo constante — o que faltava era limitar VOLUME de tentativa na frente
 * disso (threat-model.md T1). Não há "conta" aqui pra travar por falha, então
 * o limite é por IP, um balde por classe de rota (não por rota individual —
 * um atacante sondando 20 crons em sequência não deveria resetar o contador a
 * cada rota nova).
 *
 * Limite calibrado contra o tráfego legítimo real: `docker/scheduler/
 * entrypoint.sh` dispara ~6-8 crons por minuto, sempre da MESMA origem (o
 * container scheduler, direto na rede interna — sem `x-forwarded-for`, cai no
 * balde "unknown" junto com qualquer outro chamador interno). 30/60s deixa
 * ~4x de folga pra esse tráfego normal e ainda derruba um brute-force de
 * verdade pra uma fração do throughput.
 */
const ROTAS_SECRETAS_SEM_LIMITE: Array<{ re: RegExp; balde: string }> = [
  { re: /^\/api\/v1\/cron\//, balde: "cron" },
  { re: /^\/api\/internal\//, balde: "internal" },
  { re: /^\/api\/mcp(\/.*)?$/, balde: "mcp" },
  { re: /^\/api\/v1\/system\/agent$/, balde: "system-agent" },
];
const LIMITE_POR_IP = 30;
const JANELA_SEGUNDOS = 60;

function respostaDeLimiteExcedido(requestId: string): NextResponse {
  return new NextResponse(
    JSON.stringify({ error: { code: "rate_limited", message: "Too many requests." } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "Retry-After": String(JANELA_SEGUNDOS),
      },
    },
  );
}

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request: { headers: request.headers } });

  // Inject X-Request-Id for downstream correlation (audit log, error wrappers).
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  response.headers.set("x-request-id", requestId);

  const { pathname, search } = request.nextUrl;
  // Expose pathname to Server Components via header (used by onboarding layout).
  response.headers.set("x-pathname", pathname);
  request.headers.set("x-pathname", pathname);

  // EPIC-11: in dev we route by path (`/admin/*`); in prod the
  // `admin.deskcomm.com` sub-domain is mapped via Vercel rewrites to the same
  // `/admin/*` paths. The host-based branch below stays a NOOP today and only
  // exists as documentation of the intended deploy topology.
  const host = request.headers.get("host") ?? "";
  const isAdminSurface = host.startsWith("admin.") || pathname.startsWith("/admin");

  if (isPublicPath(pathname)) {
    const rota = ROTAS_SECRETAS_SEM_LIMITE.find((r) => r.re.test(pathname));
    if (rota) {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const rl = await checkRateLimit(`guard:${rota.balde}:${ip}`, LIMITE_POR_IP, JANELA_SEGUNDOS);
      if (!rl.allowed) {
        return respostaDeLimiteExcedido(requestId);
      }
    }
    return response;
  }

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
      cookieOptions: {
        name: COOKIE_NAME,
        sameSite: "strict",
        httpOnly: true,
        secure: cookieSecure(),
        path: "/",
      },
    },
  );

  // Validate JWT server-side (NEVER use getSession on backend per CLAUDE.md).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // API routes must respond with JSON envelope (contract: {error:{code,message}})
    // — never redirect HTML to JSON consumers. UI routes redirect to /login as before.
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: "unauthenticated",
            message: "Authentication required",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
        },
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  // EPIC-11 S-11.07: validate impersonate cookie on /app/* paths. Middleware
  // runs in Edge — no DB access, only HMAC + expiry. On any failure we delete
  // the cookie (defence-in-depth) and let the request continue (the layout
  // re-checks server-side; downstream code that depends on the cookie will
  // simply see no impersonation in effect).
  if (pathname.startsWith("/app")) {
    const impCookie = request.cookies.get(IMPERSONATE_COOKIE_NAME_EDGE)?.value;
    if (impCookie) {
      const result = await verifyImpersonateCookieEdge(
        impCookie,
        env.IMPERSONATE_COOKIE_SECRET ?? "",
      );
      if (!result.valid) {
        console.warn(
          `[middleware] impersonate cookie invalid (${result.reason ?? "unknown"}) — clearing`,
        );
        response.cookies.delete(IMPERSONATE_COOKIE_NAME_EDGE);
      }
    }
  }

  // /admin/* additionally requires platform_admin (early gate — authoritative
  // check is server-side in `requirePlatformAdmin`). Skip the RPC for
  // `/admin/forbidden` (rendered to non-admins, would otherwise loop).
  if (isAdminSurface && pathname.startsWith("/admin") && pathname !== "/admin/forbidden") {
    const { data: isAdmin, error } = await supabase.rpc("fn_is_platform_admin");
    if (error || !isAdmin) {
      return NextResponse.redirect(new URL("/admin/forbidden", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Run on all paths except static assets / Next internals.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};
