import { PaginaPorAviso } from "../_components/pagina-por-aviso";

export const dynamic = "force-dynamic";

export default function ZanduPage() {
  return (
    <PaginaPorAviso
      provedor="zandu"
      titulo="Zandu"
      descricao="Traga para a Agenda, sozinho, todo agendamento feito no Zandu: data, horário, agenda, serviço e cliente. O Zandu continua sendo onde se marca, remarca e cancela. A cada mudança ele avisa o CRM, e a Agenda atualiza na hora."
    />
  );
}
