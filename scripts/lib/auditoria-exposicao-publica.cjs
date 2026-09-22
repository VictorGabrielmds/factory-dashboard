// Triagem estática para material que pode acabar no browser ou no repositório.
// O resultado contém apenas código, arquivo e linha: nunca o trecho encontrado.
const CAMINHOS_PADRAO = [
  'src', 'public', 'functions/src', 'docs', '.github',
  'index.html', 'firebase.json', 'firestore.rules', 'storage.rules', 'README.md',
];

const REGRAS = [
  ['CHAVE_PRIVADA_PUBLICA', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|"private_key"\s*:/i],
  ['CREDENCIAL_ADMINISTRATIVA_PUBLICA', /GOOGLE_APPLICATION_CREDENTIALS\s*=|(?:service.?account|firebase-adminsdk)[^\n]{0,80}(?:\.json|private_key)/i],
  ['BEARER_LITERAL_PUBLICO', /authorization\s*[:=][^\n]{0,40}bearer\s+[a-z0-9._-]{12,}/i],
];

function tokenEmUrlLiteral(texto) {
  const padrao = /https?:\/\/[^\s"'<>`]+[?&](?:token|secret|signature|api[_-]?key|key)=([^&\s"'<>`]{8,})/ig;
  return Array.from(texto.matchAll(padrao)).some((encontrado) => !encontrado[1].includes('${'));
}

function chaveGoogleMapsEmbutida(nome, texto) {
  // A identificação Firebase do SDK web é deliberadamente pública. Uma chave
  // literal fora do módulo de Firebase, como a usada pelo Geocoding, deve sair
  // do browser e ficar no serviço que chama a API externa.
  return !/(?:^|[\\/])(?:firebase(?:\.[cm]?[jt]sx?)?|firebase-messaging-sw\.js)$/i.test(nome)
    && /AIza[0-9A-Za-z_-]{12,}/.test(texto);
}

function analisarExposicaoPublica(arquivos) {
  if (!Array.isArray(arquivos) || !arquivos.length) throw new Error('INVENTARIO_INCOMPLETO');
  const achados = [];
  for (const { nome, conteudo } of arquivos) {
    if (typeof nome !== 'string' || typeof conteudo !== 'string') throw new Error('FONTE_INVALIDA');
    const linhas = conteudo.split(/\r?\n/);
    for (const [codigo, padrao] of REGRAS) {
      const linha = linhas.findIndex((texto) => padrao.test(texto));
      if (linha >= 0) achados.push({ codigo, arquivo: nome.replaceAll('\\', '/'), linha: linha + 1 });
    }
    const tokenLiteral = linhas.findIndex(tokenEmUrlLiteral);
    if (tokenLiteral >= 0) achados.push({ codigo: 'TOKEN_EM_URL_PUBLICA', arquivo: nome.replaceAll('\\', '/'), linha: tokenLiteral + 1 });
    const chaveGoogleMaps = linhas.findIndex((texto) => chaveGoogleMapsEmbutida(nome, texto));
    if (chaveGoogleMaps >= 0) achados.push({ codigo: 'CHAVE_GOOGLE_MAPS_EMBUTIDA', arquivo: nome.replaceAll('\\', '/'), linha: chaveGoogleMaps + 1 });
  }
  return {
    bloqueios: achados.length,
    achados,
    limite: 'Triagem por padrões. Não prova ausência de segredo ofuscado, binário, histórico Git ou configuração remota.',
  };
}

module.exports = { CAMINHOS_PADRAO, analisarExposicaoPublica };
