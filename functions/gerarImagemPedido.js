// ============================================================================
// DEPENDÊNCIA: adicione ao seu package.json e rode npm install
// "@napi-rs/canvas": "^0.1.53"
// ============================================================================

const { createCanvas } = require('@napi-rs/canvas');

// ----------------------------------------------------------------------------
// Gera um PNG com os itens do pedido e sobe no Firebase Storage.
// Retorna a URL pública (link direto) para usar no header do template.
// ----------------------------------------------------------------------------
async function gerarEFazerUploadImagemPedido(pedido, storage) {
  const itens = [];

  if (pedido.descricao_item && Array.isArray(pedido.descricao_item)) {
    pedido.descricao_item.forEach((descricao, index) => {
      const qtd = pedido.quantidade_item ? pedido.quantidade_item[index] : 1;
      itens.push({ qtd, nome: descricao });
    });
  }

  const buffer = gerarImagemPedido(itens, pedido.order_id);

  // Salva no bucket com nome único por pedido (sobrescreve se reprocessar)
  const nomeArquivo = `pedidos_imagens/pedido_${pedido.order_id}.png`;
  const bucket = storage.bucket();
  const file = bucket.file(nomeArquivo);

  await file.save(buffer, {
    metadata: { contentType: 'image/png' },
    public: true, // ← torna o arquivo público sem precisar de signed URL
  });

  // URL pública permanente (sem expiração, sem assinar)
  const urlPublica = `https://storage.googleapis.com/${bucket.name}/${nomeArquivo}`;
  return urlPublica;
}

// ----------------------------------------------------------------------------
// Monta o PNG em memória. Não depende de Firebase, pode ser testado isolado.
// ----------------------------------------------------------------------------
function gerarImagemPedido(itens, orderId) {
  const PADDING = 30;
  const LINHA_H = 48;
  const HEADER_H = 90;
  const FOOTER_H = 50;
  const W = 660;
  const totalH = HEADER_H + itens.length * LINHA_H + FOOTER_H + PADDING;

  const canvas = createCanvas(W, totalH);
  const ctx = canvas.getContext('2d');

  // ── Fundo branco ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, totalH);

  // ── Header laranja ────────────────────────────────────────────────────────
  ctx.fillStyle = '#FF6B00';
  ctx.fillRect(0, 0, W, HEADER_H);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(`Novo Pedido  #${orderId}`, PADDING, 58);

  // ── Itens ─────────────────────────────────────────────────────────────────
  itens.forEach((item, i) => {
    const y = HEADER_H + PADDING / 2 + i * LINHA_H;

    // Fundo alternado para facilitar leitura
    ctx.fillStyle = i % 2 === 0 ? '#F7F7F7' : '#FFFFFF';
    ctx.fillRect(0, y - 6, W, LINHA_H);

    // Quantidade (destaque laranja)
    ctx.fillStyle = '#FF6B00';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`${item.qtd}x`, PADDING, y + 30);

    // Nome do item
    ctx.fillStyle = '#222222';
    ctx.font = '22px sans-serif';

    // Trunca nomes muito longos para não vazar da imagem
    let nome = String(item.nome).toUpperCase();
    if (nome.length > 38) nome = nome.slice(0, 36) + '…';
    ctx.fillText(nome, PADDING + 65, y + 30);
  });

  // ── Linha divisória antes do rodapé ───────────────────────────────────────
  const rodapeY = HEADER_H + PADDING / 2 + itens.length * LINHA_H;
  ctx.strokeStyle = '#DDDDDD';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, rodapeY);
  ctx.lineTo(W, rodapeY);
  ctx.stroke();

  // ── Rodapé cinza ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#F0F0F0';
  ctx.fillRect(0, totalH - FOOTER_H, W, FOOTER_H);

  ctx.fillStyle = '#999999';
  ctx.font = '15px sans-serif';
  ctx.fillText('Gerado automaticamente  •  Confirme com o cliente', PADDING, totalH - 18);

  return canvas.toBuffer('image/png');
}

module.exports = { gerarEFazerUploadImagemPedido, gerarImagemPedido };
