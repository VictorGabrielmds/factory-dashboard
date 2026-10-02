// Triagem estática: retorna códigos/localização, nunca trechos de código ou segredos.
// Ausência de achados não comprova segurança nem autoriza instalação/revogação.
function analisarDesktop(arquivos, entradasPacote) {
  if (!Array.isArray(arquivos) || !arquivos.length || !Array.isArray(entradasPacote) || !entradasPacote.length) {
    throw new Error('INVENTARIO_INCOMPLETO');
  }
  const achados = [];
  const regras = [
    ['CREDENCIAL_GOOGLE_NO_DESKTOP', /GOOGLE_APPLICATION_CREDENTIALS|GoogleCredential\s*\.\s*From(?:File|Json)/],
    ['SDK_SERVIDOR_FIRESTORE_NO_DESKTOP', /FirestoreDb\s*\.\s*Create|PackageReference\s+Include="Google\.Cloud\.Firestore(?:\.V1)?"/],
    ['CHAVE_COMPARTILHADA_PAINEL', /PANEL_API_KEY|x-panel-key/i],
    ['MATERIAL_PRIVADO_EM_FONTE', /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|"private_key"\s*:/],
    ['LEITURA_DIRETA_PEDIDOS', /\.Collection\s*\(\s*"pedidos"\s*\)/],
  ];
  for (const { nome, conteudo } of arquivos) {
    if (typeof nome !== 'string' || typeof conteudo !== 'string') throw new Error('FONTE_INVALIDA');
    const linhas = conteudo.split(/\r?\n/);
    for (const [codigo, padrao] of regras) {
      const linha = linhas.findIndex((l) => padrao.test(l));
      if (linha >= 0) achados.push({ codigo, arquivo: nome, linha: linha + 1 });
    }
  }
  for (const entrada of entradasPacote) {
    if (typeof entrada !== 'string') throw new Error('PACOTE_INVALIDO');
    const normalizada = entrada.replaceAll('\\', '/');
    const nome = normalizada.split('/').pop();
    if (!nome) continue;
    let codigo;
    if (/^(?:config|pedidos_recentes|pendencias).*\.json$/i.test(nome) || /\.log$|^log\.txt$/i.test(nome)) {
      codigo = 'DADOS_LOCAIS_NO_PACOTE';
    } else if (/\.json$/i.test(nome) && !/^RoboImpressaoDelivery\.(?:deps|runtimeconfig)\.json$/i.test(nome)) {
      codigo = 'JSON_NAO_PREVISTO_NO_PACOTE';
    } else if (/\.(?:pem|p12|pfx|key)$|^\.env(?:\.|$)|firebase-adminsdk|service.?account|credential|credencia|chave/i.test(nome)) {
      codigo = 'POSSIVEL_CREDENCIAL_NO_PACOTE';
    }
    if (codigo) achados.push({ codigo, arquivo: normalizada });
  }
  return { bloqueiosEstaticos: achados.length, achados, aprovacaoAutomatica: false,
    limite: 'Triagem por padrões e nomes. Não examina conteúdo binário/credenciais nem comprova IAM, versão instalada ou impressão física.' };
}

module.exports = { analisarDesktop };
