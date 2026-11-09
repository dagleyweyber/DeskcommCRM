/**
 * Porta neutra para abrir um aviso de canal na Central: quem mora fora de `lib/channels/` (ex.: o
 * despachante de campanhas) não pode importar o caminho de um provider (`lint:channels`).
 */
export { registrarAviso } from "./zernio/avisos";
export type { AvisoDeCanal } from "./zernio/avisos";
