# Fiscal direto — plano prioritário de entrega

Data: 22/09/2026; primeira implementação local em 23/09/2026. Estado: **núcleo seguro em andamento; emissão ainda desabilitada**.

O usuário pediu antecipar a emissão fiscal. A preparação desta frente passa à frente da migração ampla de pedidos da P1. É possível aproveitar o adaptador fiscal do formato atual e depois adicionar V2; não é necessário converter todo o histórico ou concluir P3/P4 antes de desenvolver o fiscal. Os requisitos mínimos de consistência, autorização, recuperação e publicação do recorte continuam necessários.

O objetivo é entregar o fluxo fiscal completo para o escopo aprovado, com pendências visíveis e recuperação de falhas. Não significa disponibilidade absoluta do sistema, da Eficiência Fiscal ou da SEFAZ.

## 1. O que já existe e foi conferido

- Backend com sessão Firebase revogável e verificação de equipe ativa; token EF referenciado no Secret Manager.
- Vínculos de produtos com código interno da EF, revisão e histórico.
- Conferência do pedido com snapshot, validação de valores e referência externa estável `FDAPP_...`.
- Teste de conexão que apenas consulta contingências.
- Bloqueio explícito das ações `emitir`, `autorizar`, `cancelar` e `retransmitir` no servidor.

Em 23/09, `node --test functions/test/fiscal.test.js` passou: **60 testes, zero falhas**. A suíte completa passou com **175 unitários e 16 cenários do emulador**; lint verificou 56 arquivos. São testes locais do preparo/conferência, acesso, consulta simulada, operação idempotente, contrato sintético e bloqueio de emissão. Não validam emissão real nem o contrato autenticado com o provedor. Não foi consultado o cadastro privado da loja nesta revisão, portanto não se afirma quantos produtos já estão vinculados ou qual é a configuração fiscal efetiva.

Primeiro recorte implementado em 23/09:

- `fiscal_operacoes` tem ID determinístico por pedido, CNPJ e homologação, snapshot imutável, hashes da conferência/pedido, evento de auditoria e bloqueios explícitos.
- Preparação repetida da mesma revisão converge para a mesma operação. Pedido ou vínculo alterado depois da conferência recebe conflito e exige nova revisão.
- Somente homologação pode ser preparada; `envioHabilitado` permanece falso. As ações que transmitiriam ou cancelariam documentos continuam retornando `EMISSAO_BLOQUEADA`.
- Emissão/cancelamento exigem papel fiscal, gestor ou capacidade explícita. A compatibilidade ampla de `operador_legado` não concede essas ações críticas.
- Firestore nega acesso direto de staff, cliente e dispositivo à nova coleção, assim como às demais coleções fiscais.

Este recorte conclui parte de F3. Ainda não protege todos os escritores do pedido durante processamento e não implementa leases, chamada ao provedor ou reconciliação; portanto F3 e F4 continuam abertos.

Segundo recorte local em 23/09:

- O contrato público de criação de pré-venda e autorização foi modelado em `contratoEficiencia.js`, sem `fetch`, token ou ligação com os endpoints ativos.
- Valores permanecem inteiros em centavos e são formatados sem ponto flutuante; item cujo preço unitário não seja exato é bloqueado até o contrato ser confirmado.
- O comando sintético usa somente `codigo_produto[]`; nunca envia `codigo_item[]`, NCM, EAN ou figura tributária inventados para provocar cadastro automático.
- Entrega e taxa de cartão continuam bloqueadas no construtor até a política fiscal ser confirmada. O primeiro contrato sintético aceito é PIX exato, sem essas taxas.
- Pré-venda só é aceita quando a resposta repete CNPJ e `codigo_parceiro` exatos e retorna `codigo_ef` válido. Autorização só pode ser montada depois que esse vínculo estiver persistido.
- XML/DANFE de uma resposta sintética são validados por tipo/tamanho e transformados em metadados/hashes para testes; o módulo não os devolve para log nem define ainda o armazenamento privado definitivo.

Fontes locais: `functions/src/fiscal/{modelo,servico,eficiencia,autenticacao,operacoes,contratoEficiencia}.js`, `functions/src/api/fiscal.js` e [documentação da versão atual](fiscal.md).

## 2. Contrato público consultado e pontos ainda não comprovados

Fonte: [API de Vendas da Eficiência Fiscal](https://documenter.getpostman.com/view/39069917/2sBYAq1Dr8), coleção pública consultada em 22/09/2026. Exemplos publicados são sintéticos; eles não comprovam autorização da nossa conta, configuração tributária ou comportamento em homologação.

Consta na documentação:

- Autenticação Bearer com habilidade `vendas`.
- Criação/atualização de pré-venda em `POST /api/vendas/v1/venda` e autorização por código EF ou código externo (`codigo_parceiro`).
- Código externo somente numérico pode ser interpretado primeiro como código interno EF. A referência própria alfanumérica deverá ser mantida e validada com o provedor.
- `codigo_produto[]` referencia código interno do catálogo. Se o produto não existir, a API pode cadastrá-lo automaticamente; não assumir que enviar um código implica existência/revisão fiscal.
- `codigo_item[]` e `codigo_produto[]` não devem ser enviados juntos. Quantidade, preço e indicação monetária/percentual de descontos e acréscimos precisam de valores explícitos.
- A descrição de `GET /venda/listar` documenta apenas `pre_venda` como filtro de status e datas por criação. Não demonstra consulta exata e completa do resultado de uma autorização por referência externa.
- Há operações de XML, PDF autorizado, cancelamento e contingência. A existência dessas rotas não comprova ambiente de testes, idempotência, semântica de reenvio ou consulta após resposta perdida.

O usuário confirmou nesta conversa que **ainda não obteve confirmação de uso independente do InstaDelivery e homologação**. Esta é uma dependência externa aberta. Não enviar criação, autorização, cancelamento ou contingência à conta real para descobrir a resposta.

## 3. Ordem de execução

| Entrega | Trabalho | Critério para concluir |
| --- | --- | --- |
| F1 — Contrato e habilitação | Confirmar uso direto da conta, modelo fiscal, ambiente de testes, consulta exata, duplicidade e situação após timeout; registrar respostas e versão do contrato | Caminho documentado e testável para criação, autorização, consulta e cancelamento, inclusive quando o ID de resposta não chegou |
| F2 — Dados e política de emissão | Conferir vínculos dos produtos usados, snapshot, destinatário, pagamentos, taxas/descontos e momento de emitir com contabilidade; definir quando o operador pode solicitar | Casos delivery/retirada, PIX/cartão e agendamento possuem resultado esperado; nenhum código/tributação inventado |
| F3 — Registro durável e proteção | Implementar operação fiscal única no escopo inicial por venda/emitente/ambiente, revisão, snapshot imutável, auditoria, estado de envio e permissões específicas | Dois operadores/clique duplo criam uma intenção; alterações concorrentes não mudam os dados em emissão |
| F4 — Integração e reconciliação | Implementar pré-venda, autorização, consulta, XML/PDF, cancelamento e contingência conforme o contrato validado | Resposta perdida mantém referência e estado inconclusivo; consulta recupera o documento sem emissão nova às cegas |
| F5 — Fluxo do operador | Mostrar pendências, revisão antes de emitir, andamento, documento autorizado, motivo de rejeição e ação segura de consulta/cancelamento | Operador identifica se houve autorização ou se ainda há incerteza; HTTP 200 não vira autorização presumida |
| F6 — Homologação e piloto | Rodar contratos reais de teste, concorrência, falhas, regras de acesso e piloto limitado autorizado | FIS-01 a FIS-04 e testes aplicáveis de JOB/SEC aprovados; documentos conferidos; rastreabilidade e reversão verificadas |

F1 começa imediatamente como confirmação externa. Enquanto isso, podemos preparar os modelos, simuladores e testes de F2/F3 que não dependem de respostas ainda desconhecidas. Não implementar um payload tributário presumido ou tratar o simulador como prova do contrato real.

## 4. Desenho mínimo de implementação

O primeiro escopo de ativação será emissão solicitada pelo operador para pedidos próprios elegíveis. Automação por evento vem após o piloto, quando o momento de emitir estiver confirmado. Instadelivery/avulsos/histórico ficam fora da emissão automática inicial; notas já emitidas devem manter referências e consulta apropriadas.

O fluxo distingue intenção local, pré-venda criada, autorização solicitada, autorização confirmada, rejeição, resultado inconclusivo, cancelamento pendente e cancelamento confirmado. Contingência possui estado e procedimento próprios quando suportados e confirmados. Salvar pré-venda não equivale a autorizar nota.

- Persistir a intenção e sua referência antes de chamar o provedor; guardar o código EF assim que conhecido. Separar revisão dos dados e ID da tentativa sem gerar outra venda fiscal a cada revisão/clique.
- Chamadas externas ocorrem fora da transação Firestore. Reivindicação com prazo e identificador de execução protege o trabalho local; não prova idempotência externa.
- Registrar que uma tentativa pode ter saído antes da chamada. Se houver timeout, queda, resposta ilegível ou processo encerrado, consultar pelo vínculo exato antes de decidir nova tentativa. Se o contrato não permitir eliminar a incerteza, manter pendência para conferência.
- Permissões explícitas para emitir e cancelar, verificadas no servidor. Equipe ativa genérica não recebe autorização fiscal sensível apenas porque pode abrir o painel.
- Bloquear edição fiscalmente relevante e cancelamento operacional incompatível enquanto a emissão estiver em andamento. A proteção precisa alcançar API, regras e todos os escritores do pedido atual; apenas desabilitar um botão não resolve.
- Preservar eventos financeiros reais: um webhook de estorno não é descartado para manter o snapshot fiscal. A mudança gera reconciliação/pendência, com tratamento definido pela política da loja e da contabilidade.
- Usar os produtos revisados da EF. Validar como impedir cadastro automático/restauração de produto sem conferência, incluindo o caso de código removido ou incorreto. Não enviar NCM ou figura tributária de fallback para fazer a operação passar.
- Revalidar a revisão do pedido, os vínculos e o tratamento de pagamento imediatamente antes da solicitação, conforme política aprovada. PIX pago não define sozinho o momento fiscal da emissão.
- Guardar identificação, chave/protocolo, XML e documento de impressão com acesso privado e auditoria. Gerar acesso temporário quando necessário; retenção e exportação serão definidas com a contabilidade.
- Manter recuperação por consulta com limites, próxima tentativa e alerta de pendência antiga. Consultas podem ser repetidas de forma limitada; autorizações/cancelamentos dependem da semântica confirmada do provedor.
- Uma fila indisponível não perde o registro do trabalho. O dispatcher deve recuperar intenção não enfileirada, quando o processamento assíncrono for integrado.

O uso do contrato fiscal atual permite antecipar esta frente. Antes da ativação, os escritores dos pedidos elegíveis precisam respeitar a proteção fiscal, mesmo que a migração geral para V2 ainda não esteja concluída.

## 5. Testes que precisam passar

1. Usuário sem capacidade fiscal, cliente e sessão revogada não emitem nem cancelam, inclusive por chamada direta.
2. Clique duplo e dois operadores concorrentes preservam uma operação e um vínculo de venda fiscal.
3. EF cria a pré-venda, mas a resposta se perde: recuperar por referência exata ou manter inconclusivo; não criar outra venda automaticamente.
4. EF autoriza e a resposta se perde: consultar e registrar a mesma nota; ausência em lista incompleta não comprova inexistência.
5. Produto sem vínculo, código removido/incorreto ou vínculo alterado bloqueia o fluxo sem cadastro tributário automático não conferido.
6. Pedido editado/cancelado ou pagamento estornado durante processamento não gera emissão silenciosa sobre dados divergentes.
7. Rejeição, contingência e cancelamento seguem as transições reais do contrato. Cancelamento de pedido não é tratado como cancelamento fiscal confirmado.
8. Documento XML/PDF só é acessível a identidades autorizadas; logs e artefatos de CI não expõem credenciais ou dados pessoais.
9. Pedido antigo já emitido pelo InstaDelivery e repetição/importação de histórico não geram outra nota.
10. Reinício, fila repetida/ausente e perda de conexão mantêm rastreabilidade e recuperam o trabalho sem reenvio cego.

Usar testes puros, transações/regras no Emulator Suite e provedor simulado para falhas. Depois executar contrato real no ambiente confirmado de homologação. Vincular evidências a FIS-01/02/03/04 do [plano de testes](plano-testes-arquitetura.md); os 60 testes fiscais atuais são base, não cobertura desses dez resultados completos.

## 6. Mensagem pronta para o suporte EF

> Somos a Fábrica dos Salgados, CNPJ 11.560.207/0001-37. Já usamos a Eficiência Fiscal integrada ao InstaDelivery e estamos finalizando nosso sistema próprio. Temos um token de API com permissão Vendas e precisamos confirmar:
>
> 1. Nossa conta/contrato permite criar, autorizar, consultar e cancelar documentos diretamente pela API, sem depender do InstaDelivery? Existe habilitação ou cobrança adicional?
> 2. Qual ambiente e procedimento de homologação devemos usar sem gerar documento fiscal válido? Quais credenciais, cadastro, certificado e modelo fiscal são necessários nesse ambiente?
> 3. Qual é a garantia de unicidade de `codigo_parceiro` por emitente/ambiente? O que acontece ao repetir criação ou autorização com a mesma referência e com dados diferentes? Há chave de idempotência?
> 4. Se a resposta de criação/autorização se perder e não recebermos `codigo_ef`, como consultar exatamente a venda/nota pela nossa referência? A consulta inclui autorizadas, rejeitadas, canceladas e contingência? Há paginação, atraso de visibilidade ou callback assinado?
> 5. Como impedir que `codigo_produto` inexistente crie um produto automaticamente ou restaure um produto inativo? Existe consulta/validação do catálogo ou opção para falhar sem cadastrar?
> 6. Quais limites de requisição e procedimentos de timeout, cancelamento e contingência devemos seguir? Como coordenar série/numeração e as duas integrações durante a transição?

Não incluir token, certificado ou senha nessa mensagem. O envio ao suporte será feito pelo usuário; nenhuma mensagem foi enviada nesta tarefa.

## 7. Condições para dizer que está pronto

O fluxo está pronto para o escopo liberado quando uma venda própria percorre conferência, emissão comandada, consulta, acesso ao documento e tratamento de falha/cancelamento, com testes aprovados, configuração tributária validada, contrato independente confirmado, publicação conferida e piloto operacional aceito.

O piloto pode iniciar com um produto já vinculado e um cenário aprovado em homologação; a liberação da operação cotidiana exige todos os produtos e situações oferecidos naquele escopo. Não emitir notas reais de teste, autorizar histórico ou ativar emissão automática apenas para completar uma demonstração.

Até essas evidências, manter o bloqueio do servidor. Para reverter a nova versão, suspender apenas novas solicitações e conservar consulta/reconciliação dos documentos já solicitados; não apagar operações, referências ou XML. A impressão física na loja pode ser uma validação separada, mas não será declarada pronta com base apenas num PDF aberto no navegador.
