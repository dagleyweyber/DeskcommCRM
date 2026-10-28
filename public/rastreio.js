/*!
 * DeskcommCRM — rastreamento de campanha para landing pages.
 *
 * Uma linha na página (antes de </body>):
 *   <script src="https://SEU-CRM/rastreio.js" async></script>
 *
 * O que faz:
 *  1. Na chegada, guarda os parâmetros do anúncio que vieram na URL (UTMs, fbclid,
 *     gclid/gbraid/wbraid, campaign_id, adset_id, ad_id, adgroup_id, creative,
 *     keyword…) — o PRIMEIRO toque (por 90 dias) e o ÚLTIMO.
 *  2. Lê os cookies do Pixel da Meta (_fbc/_fbp); sem _fbc, monta o fbc a partir do
 *     fbclid com a hora REAL do clique (formato fb.1.<milissegundos>.<fbclid>).
 *  3. Acrescenta tudo como campos ocultos em TODO formulário da página no momento do
 *     envio — inclusive formulários que aparecem depois (popups, Elementor, etc.).
 *     Quem recebe o formulário só precisa repassar os campos para o webhook do CRM.
 *
 * Envio direto ao CRM (funciona com QUALQUER construtor de página):
 *   <script src="https://SEU-CRM/rastreio.js" data-webhook="URL-DO-WEBHOOK" async></script>
 *   Com `data-webhook`, todo formulário enviado na página também é mandado ao CRM
 *   (nome, telefone, e-mail, os demais campos e a origem), sem depender de o
 *   construtor repassar campos ocultos. Use OU este modo OU o webhook do próprio
 *   construtor — os dois juntos criariam o lead duas vezes.
 *   Formulário que não deve ir ao CRM: <form data-dc-rastreio="off">.
 *
 * Integração manual (formulário próprio em JavaScript):
 *   window.DeskcommRastreio.dados()          → objeto com os campos
 *   window.DeskcommRastreio.preencher(form)  → acrescenta os campos ocultos
 *
 * Sem dependências, sem cookie próprio de terceiros, sem enviar nada sozinho: o dado
 * só sai junto com o formulário que a pessoa decidiu enviar.
 */
(function () {
  "use strict";
  if (window.DeskcommRastreio) return;

  var script = document.currentScript;
  var WEBHOOK = script && script.getAttribute ? script.getAttribute("data-webhook") : null;
  var CHAVE = "dc_rastreio_v1";
  var DIAS = 90;
  var PARAMETROS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "fbclid", "gclid", "gbraid", "wbraid", "ttclid",
    "campaign_id", "adset_id", "ad_id", "adgroup_id", "creative", "keyword",
    "campaign_name", "adset_name", "ad_name", "gad_source", "gad_campaignid"
  ];

  function limpo(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).replace(/^\s+|\s+$/g, "");
    // parâmetro dinâmico não substituído ({{ad.id}}, {campaignid}) não é origem
    if (!s || /[{}]/.test(s)) return null;
    return s.slice(0, 500);
  }

  function lerCookie(nome) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + nome.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function carregar() {
    var bruto = null;
    try { bruto = window.localStorage.getItem(CHAVE); } catch (e) { /* sem storage */ }
    if (!bruto) bruto = lerCookie(CHAVE);
    if (!bruto) return {};
    try {
      var obj = JSON.parse(bruto);
      if (obj && obj.expira && obj.expira < Date.now()) return {};
      return obj || {};
    } catch (e) { return {}; }
  }

  function salvar(estado) {
    estado.expira = Date.now() + DIAS * 864e5;
    var txt = JSON.stringify(estado);
    try { window.localStorage.setItem(CHAVE, txt); } catch (e) { /* sem storage */ }
    try {
      document.cookie = CHAVE + "=" + encodeURIComponent(txt) + "; max-age=" + DIAS * 86400 + "; path=/; SameSite=Lax";
    } catch (e) { /* sem cookie */ }
  }

  function paramsDaUrl() {
    var achados = {};
    var tem = false;
    var busca = window.location.search.replace(/^\?/, "");
    if (!busca) return null;
    var pares = busca.split("&");
    for (var i = 0; i < pares.length; i++) {
      var kv = pares[i].split("=");
      var k = decodeURIComponent((kv[0] || "").replace(/\+/g, " ")).toLowerCase();
      if (PARAMETROS.indexOf(k) === -1) continue;
      var v = limpo(decodeURIComponent((kv.slice(1).join("=") || "").replace(/\+/g, " ")));
      if (v) { achados[k] = v; tem = true; }
    }
    return tem ? achados : null;
  }

  var estado = carregar();
  var agora = paramsDaUrl();
  if (agora) {
    var toque = { ts: new Date().toISOString(), landing_url: window.location.href.slice(0, 1000) };
    if (document.referrer) toque.referrer = document.referrer.slice(0, 1000);
    for (var p in agora) if (Object.prototype.hasOwnProperty.call(agora, p)) toque[p] = agora[p];
    // fbc com a hora do CLIQUE — é o formato que a Meta espera
    if (toque.fbclid) toque.fbc = "fb.1." + Date.now() + "." + toque.fbclid;
    if (!estado.primeiro) estado.primeiro = toque;
    estado.ultimo = toque;
    salvar(estado);
  }

  function mesmoAnuncio(a, b) {
    for (var i = 0; i < PARAMETROS.length; i++) {
      if ((a[PARAMETROS[i]] || null) !== (b[PARAMETROS[i]] || null)) return false;
    }
    return true;
  }

  function dados() {
    var d = {};
    var ultimo = estado.ultimo || {};
    for (var k in ultimo) {
      if (!Object.prototype.hasOwnProperty.call(ultimo, k) || k === "ts") continue;
      d[k] = ultimo[k];
    }
    var fbc = lerCookie("_fbc") || ultimo.fbc || null;
    var fbp = lerCookie("_fbp");
    if (fbc) d.fbc = fbc; else delete d.fbc;
    if (fbp) d.fbp = fbp;
    if (!d.landing_url) d.landing_url = window.location.href.slice(0, 1000);
    d.page_url = window.location.href.slice(0, 1000);
    if (navigator.userAgent) d.client_user_agent = navigator.userAgent.slice(0, 500);
    // Compara os PARÂMETROS do anúncio, não o horário: duas visitas no mesmo
    // milissegundo com anúncios diferentes continuam sendo dois toques.
    if (estado.primeiro && estado.ultimo && !mesmoAnuncio(estado.primeiro, estado.ultimo)) {
      d.dc_primeiro_contato = JSON.stringify(estado.primeiro);
    }
    return d;
  }

  function preencher(form) {
    if (!form || !form.elements || form.getAttribute("data-dc-rastreio") === "off") return;
    var d = dados();
    for (var k in d) {
      if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
      var existente = form.elements.namedItem ? form.elements.namedItem(k) : null;
      if (existente && existente.getAttribute && existente.getAttribute("data-dc") !== "1") continue;
      if (!existente) {
        existente = document.createElement("input");
        existente.type = "hidden";
        existente.name = k;
        existente.setAttribute("data-dc", "1");
        form.appendChild(existente);
      }
      existente.value = d[k];
    }
  }

  function preencherTodos() {
    var forms = document.getElementsByTagName("form");
    for (var i = 0; i < forms.length; i++) preencher(forms[i]);
  }

  /** Nome do campo sem o invólucro do construtor: "form_fields[email]" → "email". */
  function nomeDoCampo(nome) {
    var m = /^[^\[]+\[([^\]]+)\]$/.exec(nome);
    return m ? m[1] : nome;
  }

  function idDoEnvio() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) { /* segue */ }
    return "dc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 12);
  }

  /** Modo envio direto: manda o formulário ao webhook do CRM sem atrapalhar o envio da página. */
  function enviarAoCrm(form) {
    if (!WEBHOOK || !form || form.getAttribute("data-dc-rastreio") === "off") return;
    if (form.getAttribute("data-dc-enviado") === "1") return;
    form.setAttribute("data-dc-enviado", "1");
    setTimeout(function () { form.removeAttribute("data-dc-enviado"); }, 4000);

    var corpo = [];
    var vistos = {};
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name || el.disabled) continue;
      var tipo = (el.type || "").toLowerCase();
      if (tipo === "file" || tipo === "password" || tipo === "submit" || tipo === "button") continue;
      if ((tipo === "checkbox" || tipo === "radio") && !el.checked) continue;
      var nome = nomeDoCampo(el.name);
      if (vistos[nome] || el.value === "") continue;
      vistos[nome] = true;
      corpo.push(encodeURIComponent(nome) + "=" + encodeURIComponent(el.value));
    }
    var d = dados();
    for (var k in d) {
      if (Object.prototype.hasOwnProperty.call(d, k) && !vistos[k]) {
        corpo.push(encodeURIComponent(k) + "=" + encodeURIComponent(d[k]));
      }
    }
    // Reenvio (clique duplo, retry) não duplica o lead: o webhook deduplica por external_id.
    corpo.push("external_id=" + encodeURIComponent(idDoEnvio()));
    var texto = corpo.join("&");
    var tipoCorpo = "application/x-www-form-urlencoded;charset=UTF-8";
    try {
      // sendBeacon sobrevive à troca de página que costuma vir logo após o envio
      if (navigator.sendBeacon && navigator.sendBeacon(WEBHOOK, new Blob([texto], { type: tipoCorpo }))) return;
    } catch (e) { /* cai para o fetch */ }
    try {
      fetch(WEBHOOK, { method: "POST", mode: "no-cors", keepalive: true, headers: { "Content-Type": tipoCorpo }, body: texto });
    } catch (e) { /* sem rede: a página segue o próprio fluxo */ }
  }

  // Na fase de CAPTURA: roda antes do handler do construtor da página, que costuma
  // montar o envio (FormData) no próprio evento de submit.
  // Só a instância ATIVA age: o script colado duas vezes na mesma página não pode
  // mandar o lead em dobro.
  function ativa() { return typeof window !== "undefined" && window.DeskcommRastreio === api; }

  document.addEventListener("submit", function (e) {
    if (!ativa()) return;
    preencher(e.target);
    enviarAoCrm(e.target);
  }, true);

  var api = { dados: dados, preencher: preencher, enviar: enviarAoCrm, versao: 1 };
  window.DeskcommRastreio = api;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { if (ativa()) preencherTodos(); });
  } else {
    preencherTodos();
  }
  if (window.MutationObserver) {
    new MutationObserver(function (mut) {
      if (!ativa()) return;
      for (var i = 0; i < mut.length; i++) {
        var nos = mut[i].addedNodes;
        for (var j = 0; j < nos.length; j++) {
          var n = nos[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === "FORM") preencher(n);
          else if (n.getElementsByTagName) {
            var internos = n.getElementsByTagName("form");
            for (var x = 0; x < internos.length; x++) preencher(internos[x]);
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

})();
