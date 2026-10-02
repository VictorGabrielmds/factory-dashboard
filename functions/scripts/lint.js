// Verificação estática mínima, sem depender de credenciais nem de Firebase.
// Ela é executada no predeploy e no CI: valida a sintaxe de todo o backend e
// recusa dois atalhos de segurança que não podem voltar por acidente.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const raiz = path.resolve(__dirname, "..", "src");
const arquivos = [path.resolve(__dirname, "..", "index.js")];

function visitar(diretorio) {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) visitar(caminho);
    else if (entrada.isFile() && entrada.name.endsWith(".js")) arquivos.push(caminho);
  }
}

function falhar(mensagem) {
  console.error(`[backend:lint] ${mensagem}`);
  process.exitCode = 1;
}

visitar(raiz);

for (const arquivo of arquivos) {
  const resultado = spawnSync(process.execPath, ["--check", arquivo], { encoding: "utf8" });
  if (resultado.status !== 0) {
    falhar(`Sintaxe inválida em ${path.relative(path.resolve(__dirname, ".."), arquivo)}.`);
    if (resultado.stderr) console.error(resultado.stderr.trim());
  }
}

for (const arquivo of arquivos) {
  const conteudo = fs.readFileSync(arquivo, "utf8");
  if (/\b(?:VITE_)?PANEL_API_KEY\b/.test(conteudo)) {
    falhar(`Chave compartilhada do painel proibida em ${path.relative(path.resolve(__dirname, ".."), arquivo)}.`);
  }
}

const diretorioApi = path.join(raiz, "api");
for (const nome of fs.readdirSync(diretorioApi)) {
  if (!nome.endsWith(".js")) continue;
  const arquivo = path.join(diretorioApi, nome);
  const conteudo = fs.readFileSync(arquivo, "utf8");
  const possuiAutorizacao =
    conteudo.includes("exigirPainel") || conteudo.includes("exigirEquipeFiscal");
  if (!possuiAutorizacao) {
    falhar(`API sem guarda de autorização declarada: src/api/${nome}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`[backend:lint] ${arquivos.length} arquivos verificados.`);
