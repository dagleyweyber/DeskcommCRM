/**
 * Endereço de um contato na Cloud API: telefone OU BSUID.
 *
 * O BSUID (business-scoped user id) é o identificador que a Meta dá a cada pessoa por
 * portfólio: `BR.` (país, duas letras) + `.` + até 128 caracteres alfanuméricos
 * (`BR.13491208655302741918`). Chega em TODO webhook (`user_id`, `from_user_id`,
 * `to_user_id`) e é o único identificador que sobra quando a pessoa ativa o nome de
 * usuário e o telefone é omitido.
 *
 * Para ENVIAR a um BSUID o campo é `recipient`, no lugar de `to` (doc da Meta); mandar
 * os dois faz o `to` prevalecer. Por isso a decisão "telefone ou BSUID" mora num lugar
 * só, e os dois pontos de envio (mensagem livre e modelo) a reaproveitam.
 *
 * Puro e síncrono, como o resto de `lib/channels/meta/` que não toca banco nem rede.
 */

/**
 * `XX.` + alfanumérico. Aceita também o BSUID PAI (`US.ENT.<id>`), que tem `ENT` no
 * meio. A Meta avisa que mexer no país, no ponto ou nos caracteres faz a chamada falhar,
 * então o formato é conferido inteiro e o valor nunca é "limpo".
 */
const BSUID = /^[A-Za-z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;

export function ehBsuid(valor: string | null | undefined): valor is string {
  return typeof valor === "string" && BSUID.test(valor);
}

/**
 * Como o destino entra no corpo de um envio: `to` para telefone, `recipient` para BSUID.
 * O telefone continua sendo só dígitos (o chamador já resolveu); o BSUID vai intacto.
 */
export function destinoNoCorpo(
  destino: string,
): { to: string } | { recipient_type: "individual"; recipient: string } {
  return ehBsuid(destino) ? { recipient_type: "individual", recipient: destino } : { to: destino };
}
