# P0 — preparação do acesso restrito à impressão

Estado em 09/09/2026: **pareamento seguro implementado e testado localmente; migração operacional ainda não concluída**. O robô 1.2.3 continua inalterado. Os endpoints estão descritos no código, mas não foram publicados: não há pareamento ativo, trabalhos gerados ou novos acessos em produção. A consulta implementada ainda não autoriza impressão.

## Fronteira de confiança implementada

O computador deixa de precisar de credencial administrativa no desenho novo. O backend valida uma identidade exclusiva de dispositivo, nunca um operador `staff` nem um cliente do cardápio.

`functions/src/impressao/acessoDispositivo.js` exige:

- Firebase ID token Bearer verificado pelo Admin SDK com checagem de revogação. O custom token de pareamento não é aceito diretamente como ID token.
- UID `imp_` seguido de 16–80 caracteres alfanuméricos, `_` ou `-`; claims assinadas `tipo: dispositivo_impressao`, `credencialVersao` inteira positiva e provedor `custom`.
- Cadastro `dispositivos_impressao/{uid}` com UID correspondente, `ativo: true`, `tipo: impressao` e versão de credencial igual ao token.
- Ausência de documento `staff/{uid}` e configuração `configuracoes/impressao_api` explicitamente `{ativa: true, versao: 1}`. Ausência, desativação ou indisponibilidade não concedem acesso.

Não foram criados esses registros em produção. Revogação/rotação do cadastro são rechecadas dentro da transação de cada comando, além da validação inicial. As regras atuais negam acesso direto às três coleções novas para clientes, equipe e dispositivos; a API usa autorização própria no servidor.

## Pareamento seguro preparado

O gestor do painel inicia o pareamento informando somente um nome para o computador, por exemplo “Impressora do caixa”. A API gera um ID de dispositivo e um código aleatório de 256 bits, válido por 15 minutos. O código aparece uma vez na resposta e o servidor guarda apenas seu hash — banco, logs e listagem de dispositivos não recebem a senha em texto.

| Etapa | Quem pode chamar | Resultado |
| --- | --- | --- |
| `impressao` → `iniciarPareamento` | Gestor ou usuário com `impressao.parear` concedido explicitamente | Cria código temporário e auditoria de quem o iniciou. Staff legado não recebe essa permissão por compatibilidade. |
| `resgatarPareamentoImpressao` | Computador com o código | Cria identidade exclusiva `imp_…` e devolve um custom token curto. Código errado, vencido ou de outro computador retorna a mesma resposta. |
| Login Firebase do robô | Computador | Troca o custom token por sessão Firebase. O refresh token será protegido pelo Windows DPAPI quando o desktop for adaptado. |
| `confirmarPareamentoImpressao` | Sessão do próprio dispositivo | Confirma a instalação e apaga o hash do código, impedindo nova emissão. Antes da confirmação, uma repetição do mesmo código é permitida apenas até o vencimento, para sobreviver a uma resposta de rede perdida. |
| `impressao` → `revogarDispositivo` | Gestor ou permissão explícita | Desativa primeiro no banco e aumenta a versão da credencial; depois tenta revogar tokens Firebase. Se a segunda parte falhar, o acesso ao backend já segue bloqueado e a pendência fica registrada. |

O resgate não usa CORS como autenticação: o robô desktop chama a API diretamente; a defesa é o código temporário de alta entropia, validade curta, hash, limite de cinco tentativas e confirmação pela sessão resultante. O endpoint mantém no máximo duas instâncias, sem instâncias sempre ligadas. Isso contém custo, mas não substitui observabilidade e proteção de borda na publicação.

## Contrato mínimo preparado

`functions/src/impressao/consultaRestrita.js` contém um handler sem publicação. Somente POST, corpo de até 2 KB, comandos e campos enumerados, respostas `Cache-Control: no-store` e erros sem detalhes privados.

| Comando | Entrada permitida | Efeito |
| --- | --- | --- |
| `consultarTrabalho` | `action`, `trabalhoId` | Lê um trabalho atribuído ao mesmo dispositivo e versão, pendente e não expirado. Não altera pedido/trabalho. Retorna `autorizacaoDeImpressao: false`. |
| `registrarPresenca` | `action`, `versaoApp` no formato N.N.N | Atualiza presença/versão somente no próprio cadastro. Transações concorrentes respeitam intervalo de 30 segundos entre gravações. Não altera o heartbeat legado. |

Trabalho ausente, de outro dispositivo, expirado ou indisponível retorna o mesmo 404. O recibo é projetado por lista explícita: identificação do pedido, nome, horário agendado, itens/quantidades/observações, pagamento e total em centavos; endereço e contato operacional apenas para delivery. IDs de cobrança, CPF, dados de autenticação e demais campos internos não são repassados. Máximo de 100 itens e 32 KB por recibo, strings limitadas e caracteres de controle removidos. Recibo malformado não é liberado.

O recibo ainda contém dados pessoais necessários à operação: exige TLS, retenção local curta e logs sem payload. Não é dado público nem anonimizado. O limitador de presença controla gravações, **não** substitui proteção contra abuso/rate limiting na futura publicação. Não há busca global de pedidos, escrita de pagamento ou aceitação de recibo fornecido pelo computador.

## Fila segura de impressão preparada

`functions/src/impressao/trabalhos.js` acrescenta o ciclo que faltava entre o produtor confiável e o desktop. Também permanece sem endpoint/exportação: não há novo consumidor ativo em produção.

| Etapa | Invariante | O que ocorre em caso de rede/tempo incerto |
| --- | --- | --- |
| Criação | Só código de servidor pode criar um trabalho determinístico por `pedidoId` + versão do recibo. O recibo é projetado e recebe hash; o pedido original não é alterado. | Repetir a mesma criação devolve o mesmo ID; contrato diferente vira conflito, não outro papel. |
| Reivindicação | Apenas o dispositivo e a versão de credencial atribuídos podem tomar o trabalho. Uma lease aleatória de 128 bits fica apenas como hash e vale dois minutos. | Repetir a mesma lease devolve o mesmo recibo; lease diferente não recebe dados. |
| Envio | O desktop só poderá enviar bytes depois da reivindicação. `aceito_transporte` significará apenas que spooler/TCP aceitou bytes — nunca que o papel saiu. | O servidor não cria outra tentativa nem muda `pedidos.impresso`. |
| Resultado | `aceito_transporte`, `falha_definitiva` e `inconclusivo` são terminais e auditáveis; códigos de falha são enumerados, sem texto livre. | Lease vencida vira `inconclusivo`; timeout, queda ou resposta perdida **não** reimprimem. Repetir exatamente o mesmo resultado é idempotente. |

Uma reimpressão futura será uma ação manual, explícita e auditada que cria um novo trabalho com nova versão. Ela não será uma consequência automática de uma falha, timeout ou reinício do robô.

## Decisão de entrada do App Cliente preparada

`functions/src/impressao/produtorPedidos.js` transforma somente o snapshot confiável de um pedido do **nosso App Cliente** em trabalho candidato. O gatilho ainda não foi exportado/publicado e a configuração padrão mantém a fila desligada.

- PIX só é elegível com `pix_confirmado: true` e `pix_status: RECEIVED`, depois da validação estrita com a API Asaas. QR criado ou webhook incerto não bastam.
- Débito, crédito e uma futura forma dinheiro são elegíveis ao finalizar com `status: 2`. No checkout atual, débito/crédito entram nesse estado; no recibo, `pago` continua `false` até que exista uma confirmação financeira própria.
- Pedidos InstaDelivery, cancelados, sem entrega/retirada explícita ou com itens/endereço inválidos não entram na fila nova.
- A configuração precisará ter **as quatro** condições: `ativa: true`, `versao: 1`, `filaAtiva: true` e `dispositivoPadraoUid` de um dispositivo ativo. `filaAtiva` é uma trava separada do pareamento, para parear sem imprimir.
- O identificador usa a liberação inicial do pedido. Um evento repetido devolve o mesmo trabalho; uma edição posterior não cria automaticamente uma segunda via.

## O que falta antes de substituir a credencial

1. Ligar o cliente .NET ao fluxo operacional: o robô já tem o botão **Vincular computador**, modal para inserir o código, resgate, login/renovação e armazenamento DPAPI; falta usar sua sessão no handler de reivindicação/resultado, com lease persistida localmente. Não misturar consumidores legado e novo para o mesmo pedido.
2. Exportar e validar o gatilho do produtor apenas em homologação: ele já reconhece pedido próprio liberado, valida o recibo e exige destino configurado, mas não está ligado ao runtime. Não usar a consulta de recibo como permissão para enviar bytes, nem ativar esse produtor enquanto o legado puder imprimir o mesmo pedido.
3. Criar a ação manual, auditada e com confirmação para reimpressão de um trabalho `inconclusivo` ou com falha definitiva. Ela terá uma nova versão — nunca uma repetição automática.
4. Definir recursos da API, autorização de publicação, limitação de uso, observabilidade e custos; validar em ambiente isolado. Instalar na loja em janela coordenada e realizar impressão controlada somente com autorização.
5. Comparar credencial instalada e demais consumidores. Depois do teste operacional aprovado, remover a dependência administrativa e revogar a chave antiga de forma coordenada; não apagar conta/papéis compartilhados sem nova análise.

Os itens 1 e a integração de identidade continuam P0 (SEC-04/06/07). Fila e lifecycle completo se conectam a P1/P3; este recorte não os declara concluídos nem comprova confiabilidade física de impressão.

## Evidência automatizada

- `functions/test/acessoDispositivo.test.js`: 12 testes de autenticação, revogação, identidade, comandos, payload mínimo e falha segura.
- `functions/test/pareamentoImpressao.test.js`: seis testes de código aleatório, hash, expiração, repetição segura diante de resposta perdida, confirmação, revogação e falha sanitizada.
- `functions/test/trabalhosImpressao.test.js`: cinco testes do trabalho idempotente, recibo projetado, dono/lease, resultado terminal, expiração conservadora e revogação concorrente.
- `functions/test/produtorImpressaoPedidos.test.js`: quatro testes de elegibilidade PIX/cartão, snapshot mínimo, trava de ativação/destino e repetição/edição sem segunda impressão.
- `functions/test/capacidade.test.js`: verifica o perfil econômico e que consulta/fila continuam sem endpoint publicado.
- `functions/test/regrasAcesso.rules.js`: inclui transações reais no emulador para isolamento do trabalho, revalidação, presença concorrente, negação de acesso direto e lease exclusiva que vira inconclusiva.
- `RoboImpressaoDelivery/SessaoDispositivoStore.cs`, `ClientePareamentoImpressao.cs`, `ClienteTrabalhosImpressao.cs` e `Form1.Pareamento.cs`: armazenamento DPAPI, resgate, confirmação, renovação de token, lease persistida e modal de vinculação. O cliente de trabalho valida IDs/resultado, limpa a sessão revogada e marca o início do envio antes do spooler; ele não foi ligado ao listener legado nem tem endpoint publicado. `dotnet build --configuration Release --no-restore` concluiu sem erros; ainda há avisos preexistentes de nulidade e dependência transitiva vulnerável `SixLabors.ImageSharp 2.1.3`, trazida por `ESCPOS_NET 3.0.0`. Atualização dessa biblioteca exige teste de impressão separado.
- Resultado em 09/09: **160 testes unitários + 16 cenários de emulador aprovados; lint backend: 54 arquivos**. Projeto fictício `demo-factory-dashboard`, sem impressão nem pedidos reais. Isso não substitui testes da autenticação real, IAM publicado ou do cliente .NET.

Auditoria read-only dos papéis e limites da evidência: [inventário desktop](inventario-desktop-p0.md). Não há autorização para revogação implícita neste documento.
