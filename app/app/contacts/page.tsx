import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ContactsListClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string | string[] }>;
}) {
  const { tag } = await searchParams;
  const user = await loadAuthUser();
  const org = user ? await resolveActiveOrg(user) : null;
  // Importar é manager+ (ver app/api/v1/contacts/import/route.ts) — o botão só
  // aparece para quem vai conseguir usar.
  const podeImportar = Boolean(org && ROLE_RANK[org.role] >= ROLE_RANK.manager);

  return <ContactsListClient tagInicial={typeof tag === "string" ? tag : undefined} podeImportar={podeImportar} />;
}
