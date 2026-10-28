/**
 * O que o cliente cola nas landing pages e nos anúncios para o CRM saber a origem de
 * cada lead. Mostrado na tela da fonte de webhook (`SourceDetail`), com botão de
 * copiar. Puro: o texto exato é coberto por teste, porque um caractere errado aqui
 * vira lead sem origem em TODAS as páginas do cliente.
 */

/** A linha do script, com o envio direto ao webhook desta fonte. */
export function scriptDeRastreio(origemDoCrm: string, urlDoWebhook: string): string {
  return `<script src="${origemDoCrm}/rastreio.js" data-webhook="${urlDoWebhook}" async></script>`;
}

/**
 * O endereço onde o script registra o clique no botão do WhatsApp: o mesmo token do webhook,
 * em outro caminho (`/rastreio/clique/`). A rota resolve a organização por ele.
 */
export function urlDeCliqueDoWebhook(urlDoWebhook: string): string {
  return urlDoWebhook.replace("/webhooks/in/", "/rastreio/clique/");
}

/**
 * A linha do script SEM envio direto — para quando o construtor já manda o formulário ao
 * webhook. Com `urlDoWebhook`, leva também `data-clique`: o botão do WhatsApp continua
 * rastreado (esse modo não tem `data-webhook` de onde derivar o endereço).
 */
export function scriptSoCampos(origemDoCrm: string, urlDoWebhook?: string): string {
  const clique = urlDoWebhook ? ` data-clique="${urlDeCliqueDoWebhook(urlDoWebhook)}"` : "";
  return `<script src="${origemDoCrm}/rastreio.js"${clique} async></script>`;
}

/**
 * Meta → campo "Parâmetros de URL" do anúncio. As macros `{{…}}` são preenchidas
 * pela própria Meta no clique: id E nome de campanha, conjunto e anúncio.
 */
export const PARAMETROS_URL_META =
  "utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}";

/**
 * Google → campo "Sufixo do URL final" (nível de conta ou campanha). ValueTrack
 * `{…}` preenchido pelo Google; o gclid entra sozinho com a marcação automática.
 * O id do anúncio vai em `creative` (não em `ad_id` — ver ponto-de-contato.ts).
 */
export const PARAMETROS_URL_GOOGLE =
  "utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&campaign_id={campaignid}&adgroup_id={adgroupid}&creative={creative}&keyword={keyword}";
