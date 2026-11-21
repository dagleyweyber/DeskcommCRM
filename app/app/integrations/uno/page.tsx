import { PaginaPorAviso } from "../_components/pagina-por-aviso";

export const dynamic = "force-dynamic";

export default function UnoPage() {
  return (
    <PaginaPorAviso
      provedor="uno"
      titulo="Uno"
      descricao="Traga para a Agenda, sozinho, todo agendamento feito no Uno: data, horário, sala, serviço e cliente. O Uno continua sendo onde se marca, remarca e cancela. A cada mudança ele avisa o CRM, e a Agenda atualiza na hora."
    />
  );
}
