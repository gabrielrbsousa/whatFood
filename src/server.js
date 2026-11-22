const express = require('express');
const crypto = require('crypto');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const db = require('./db');

require('dotenv').config();

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

const TAXA_SERVICO_IFOOD = 0.99;

const TAXAS_PARCELAMENTO_IFOOD = [
  { parcelas: 1, taxa: 0 },
  { parcelas: 2, taxa: 0.0353 },
  { parcelas: 3, taxa: 0.0472 },
  { parcelas: 4, taxa: 0.0593 },
  { parcelas: 5, taxa: 0.0714 },
  { parcelas: 6, taxa: 0.0836 }
];

const findUsuario = db.prepare(`
  SELECT id, whatsapp_numero, nome, perfil, loja_id, bairro_padrao, metodo_pagamento_salvo, saldo_carteira
  FROM usuarios
  WHERE whatsapp_numero = ?
`);

const updateSaldoUsuario = db.prepare(`
  UPDATE usuarios
  SET saldo_carteira = ?
  WHERE whatsapp_numero = ?
`);

const findEnderecosUsuario = db.prepare(`
  SELECT id, usuario_whatsapp, rotulo, logradouro_numero, bairro
  FROM enderecos
  WHERE usuario_whatsapp = ?
  ORDER BY id ASC
`);

const insertEnderecoUsuario = db.prepare(`
  INSERT INTO enderecos (usuario_whatsapp, rotulo, logradouro_numero, bairro)
  VALUES (?, ?, ?, ?)
`);

const findLojasAbertas = db.prepare(`
  SELECT id, nome, status_aberto, taxa_entrega, bairros_atendimento
  FROM lojas
  WHERE status_aberto = 1
    AND EXISTS (
      SELECT 1
      FROM json_each(bairros_atendimento)
      WHERE json_each.value = ?
    )
`);

const findLojaById = db.prepare(`
  SELECT id, nome, status_aberto, taxa_entrega, bairros_atendimento
  FROM lojas
  WHERE id = ?
`);

const findProdutosDisponiveis = db.prepare(`
  SELECT id, loja_id, nome, preco, descricao, disponivel, quantidade_estoque, estoque_minimo
  FROM produtos
  WHERE loja_id = ? AND disponivel = 1 AND quantidade_estoque > 0
`);

const findTodosProdutosLoja = db.prepare(`
  SELECT id, loja_id, nome, preco, descricao, disponivel, quantidade_estoque, estoque_minimo
  FROM produtos
  WHERE loja_id = ?
  ORDER BY id ASC
`);

const findProdutoDisponivelById = db.prepare(`
  SELECT p.id, p.loja_id, p.nome, p.preco, p.descricao, p.disponivel, p.quantidade_estoque, p.estoque_minimo, l.nome AS loja_nome, l.taxa_entrega
  FROM produtos p
  JOIN lojas l ON l.id = p.loja_id
  WHERE p.id = ? AND p.disponivel = 1 AND p.quantidade_estoque > 0 AND l.status_aberto = 1
`);

const findProdutoByIdRaw = db.prepare(`
  SELECT id, loja_id, nome, disponivel, quantidade_estoque, estoque_minimo
  FROM produtos
  WHERE id = ?
`);

const decrementarEstoqueProduto = db.prepare(`
  UPDATE produtos
  SET quantidade_estoque = CASE WHEN quantidade_estoque - ? < 0 THEN 0 ELSE quantidade_estoque - ? END,
      disponivel = CASE WHEN quantidade_estoque - ? <= 0 THEN 0 ELSE disponivel END
  WHERE id = ?
`);

const restaurarEstoqueProduto = db.prepare(`
  UPDATE produtos
  SET quantidade_estoque = quantidade_estoque + ?,
      disponivel = 1
  WHERE id = ?
`);

const insertPedido = db.prepare(`
  INSERT INTO pedidos (
    usuario_whatsapp, loja_id, itens_json, modalidade, endereco_entrega,
    subtotal, taxa_entrega, taxa_servico, total, metodo_pagamento, parcelas, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const findPedidoById = db.prepare(`
  SELECT p.*, l.nome AS loja_nome
  FROM pedidos p
  JOIN lojas l ON l.id = p.loja_id
  WHERE p.id = ?
`);

const findPedidosAtivosUsuario = db.prepare(`
  SELECT p.id, l.nome AS loja_nome, p.total, p.status, p.modalidade, p.criado_em
  FROM pedidos p
  JOIN lojas l ON l.id = p.loja_id
  WHERE p.usuario_whatsapp = ?
    AND p.status NOT IN ('ENTREGUE', 'CANCELADO')
  ORDER BY p.id DESC
`);

const findTodosPedidosUsuario = db.prepare(`
  SELECT p.id, l.nome AS loja_nome, p.itens_json, p.modalidade, p.endereco_entrega, p.subtotal, p.taxa_entrega, p.taxa_servico, p.total, p.metodo_pagamento, p.parcelas, p.status, p.criado_em
  FROM pedidos p
  JOIN lojas l ON l.id = p.loja_id
  WHERE p.usuario_whatsapp = ?
  ORDER BY p.id DESC
`);

const findPedidosLojaPorData = db.prepare(`
  SELECT id, loja_id, itens_json, modalidade, subtotal, taxa_entrega, taxa_servico, total, metodo_pagamento, parcelas, status, criado_em
  FROM pedidos
  WHERE loja_id = ? AND substr(criado_em, 1, 10) = ?
  ORDER BY id ASC
`);

const updateStatusPedido = db.prepare(`
  UPDATE pedidos
  SET status = ?
  WHERE id = ?
`);

const insertInteracao = db.prepare(`
  INSERT INTO interacoes (whatsapp_hash, loja_id, etapa, mensagem_usuario, resposta_sistema, convertido)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const findInteracoesLojaPorData = db.prepare(`
  SELECT id, whatsapp_hash, loja_id, etapa, mensagem_usuario, convertido, criado_em
  FROM interacoes
  WHERE (loja_id = ? OR loja_id IS NULL) AND substr(criado_em, 1, 10) = ?
  ORDER BY id ASC
`);

const insertContextoDiario = db.prepare(`
  INSERT INTO contextos_diarios (loja_id, data_referencia, contexto_json, relatorio_texto, alertas_json)
  VALUES (?, ?, ?, ?, ?)
`);

const findContextosRecentesLoja = db.prepare(`
  SELECT id, loja_id, data_referencia, contexto_json, relatorio_texto, alertas_json, criado_em
  FROM contextos_diarios
  WHERE loja_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

const MAX_HISTORY_MESSAGES = 12;
const MAX_SMS_ATTEMPTS = 3;
const sessions = new Map();

function getTodayLocalDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function hashWhatsapp(numero) {
  const salt = process.env.HASH_SALT || 'whatfood-mvp-salt';
  return crypto
    .createHash('sha256')
    .update(`${String(numero)}:${salt}`)
    .digest('hex')
    .slice(0, 16);
}

function sanitizePII(text) {
  return String(text || '')
    .replace(/\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}-?\d{4}\b/g, '[TELEFONE]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
}

function checkInternalApiKey(req, res, next) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    next();
    return;
  }
  const received = req.headers['x-api-key'];
  if (received !== expected) {
    res.status(401).json({ ok: false, erro: 'Chave interna inválida.' });
    return;
  }
  next();
}

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      step: 'DESCOBERTA',
      greeted: false,
      history: [],
      ultimaLojaId: null,
      carrinho: {
        loja_id: null,
        loja_nome: null,
        itens: []
      },
      pendenteTrocaLoja: null,
      modalidade: null,
      enderecoSelecionado: null,
      novoEnderecoPendente: null,
      subtotal: 0,
      taxa_entrega: 0,
      taxa_servico: 0,
      total: 0,
      smsCodigo: null,
      smsTentativas: 0,
      identidadeVerificada: false
    });
  }
  return sessions.get(from);
}

function resetCheckoutState(session) {
  session.step = 'DESCOBERTA';
  session.history = [];
  session.ultimaLojaId = null;
  session.carrinho = { loja_id: null, loja_nome: null, itens: [] };
  session.pendenteTrocaLoja = null;
  session.modalidade = null;
  session.enderecoSelecionado = null;
  session.novoEnderecoPendente = null;
  session.subtotal = 0;
  session.taxa_entrega = 0;
  session.taxa_servico = 0;
  session.total = 0;
  session.smsCodigo = null;
  session.smsTentativas = 0;
  session.identidadeVerificada = false;
}

function pushHistory(session, userText, modelText) {
  session.history = [
    ...session.history,
    { role: 'user', parts: [{ text: userText }] },
    { role: 'model', parts: [{ text: modelText }] }
  ].slice(-MAX_HISTORY_MESSAGES);

  while (session.history.length > 0 && session.history[0].role !== 'user') {
    session.history.shift();
  }
}

function extractMessage(body) {
  const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (message?.from) {
    return {
      from: String(message.from),
      text: message.text?.body ?? ''
    };
  }

  if (body?.from) {
    const text = typeof body.text === 'string' ? body.text : body.text?.body ?? '';
    return {
      from: String(body.from),
      text
    };
  }

  return null;
}

function resolveUsuario(from) {
  const usuario = findUsuario.get(from);
  if (usuario) return usuario;

  return {
    whatsapp_numero: from,
    nome: 'Cliente',
    perfil: 'CLIENTE',
    loja_id: null,
    bairro_padrao: 'Pinheiros',
    metodo_pagamento_salvo: 'Mastercard •••• 0000',
    saldo_carteira: 0
  };
}

function loadCatalogo(bairro) {
  return findLojasAbertas.all(bairro).map((loja) => ({
    id: loja.id,
    nome: loja.nome,
    status_aberto: loja.status_aberto,
    taxa_entrega: Number(loja.taxa_entrega),
    bairros_atendimento: JSON.parse(loja.bairros_atendimento),
    produtos: findProdutosDisponiveis.all(loja.id)
  }));
}

function sanitizeCustomerText(text) {
  return String(text || '')
    .replace(/\s*\[ID:\s*\d+\]/gi, '')
    .replace(/\s*\(ID:\s*\d+\)/gi, '')
    .trim();
}

function formatCatalogoForPrompt(catalogo) {
  if (!catalogo || catalogo.length === 0) {
    return 'Nenhuma loja aberta no momento para este bairro.';
  }

  return catalogo
    .map((loja) => {
      const itens = (loja.produtos || [])
        .map(
          (p) =>
            `- [ID: ${p.id}] ${p.nome}: R$ ${Number(p.preco).toFixed(2)}${
              p.descricao ? ` (${p.descricao})` : ''
            }`
        )
        .join('\n');
      return `Loja [ID: ${loja.id}]: ${loja.nome} (Taxa de entrega: R$ ${Number(loja.taxa_entrega).toFixed(2)})\nCardápio disponível:\n${itens || '- Sem itens disponíveis'}`;
    })
    .join('\n\n');
}

function formatCarrinhoForPrompt(carrinho) {
  if (!carrinho.itens || carrinho.itens.length === 0) {
    return 'Carrinho vazio.';
  }
  const lista = carrinho.itens
    .map((item) => {
      const obs = item.observacao ? ` | Obs: ${item.observacao}` : '';
      return `- [ID: ${item.produto_id}] ${item.quantidade}x ${item.nome} (R$ ${Number(item.preco).toFixed(2)} cada)${obs}`;
    })
    .join('\n');
  return `Loja atual do carrinho: ${carrinho.loja_nome} (ID: ${carrinho.loja_id})\n${lista}`;
}

function formatPedidosAtivosForPrompt(pedidosAtivos) {
  if (!pedidosAtivos || pedidosAtivos.length === 0) {
    return 'Nenhum pedido em andamento no momento.';
  }
  return pedidosAtivos
    .map((p) => `- Pedido #${p.id} | Loja: ${p.loja_nome} | Total: R$ ${Number(p.total).toFixed(2)} | Status: ${p.status}`)
    .join('\n');
}

function formatBRL(valor) {
  return `R$ ${Number(valor).toFixed(2).replace('.', ',')}`;
}

function calcularOpcoesParcelamento(totalBase) {
  const totalCentavos = Math.round(Number(totalBase) * 100);
  return TAXAS_PARCELAMENTO_IFOOD.map(({ parcelas, taxa }) => {
    const totalComJurosCentavos = Math.round(totalCentavos * (1 + taxa));
    const valorParcelaCentavos = Math.round(totalComJurosCentavos / parcelas);
    const totalFinal = Number((totalComJurosCentavos / 100).toFixed(2));
    const valorParcela = Number((valorParcelaCentavos / 100).toFixed(2));
    const rotuloJuros = taxa === 0 ? 'sem juros' : 'com juros';
    return {
      parcelas,
      valorParcela,
      totalFinal,
      descricao: `${parcelas}x de ${formatBRL(valorParcela)} (${rotuloJuros}) — Total: ${formatBRL(totalFinal)}`,
      resumoCurto: `${parcelas}x de ${formatBRL(valorParcela)} (${rotuloJuros})`
    };
  });
}

function gerarTelaEnderecos(enderecos) {
  const linhas = enderecos.map((end, idx) => `${idx + 1} - ${end.rotulo}`);
  linhas.push(`${enderecos.length + 1} - Cadastrar novo endereço`);

  return [
    'Onde você deseja receber o seu pedido?',
    '',
    ...linhas
  ].join('\n');
}

function gerarNotaFiscalPadrao(session) {
  const linhasItens = session.carrinho.itens
    .map((item) => {
      const totalItem = Number((item.preco * item.quantidade).toFixed(2));
      const obsLinha = item.observacao ? `\n  Obs: ${item.observacao}` : '';
      return `• ${item.quantidade}x ${item.nome} — ${formatBRL(totalItem)}${obsLinha}`;
    })
    .join('\n');

  const detalheLogistica =
    session.modalidade === 'ENTREGA'
      ? `Entrega (${session.enderecoSelecionado.rotulo}: ${session.enderecoSelecionado.logradouro_numero}, ${session.enderecoSelecionado.bairro})`
      : 'Retirada no balcão da loja';

  return [
    '==============================',
    '      RESUMO DO PEDIDO',
    '==============================',
    `Loja: ${session.carrinho.loja_nome}`,
    `Modalidade: ${detalheLogistica}`,
    '------------------------------',
    linhasItens,
    '------------------------------',
    `Subtotal: ${formatBRL(session.subtotal)}`,
    `Taxa de entrega: ${formatBRL(session.taxa_entrega)}`,
    `Taxa de serviço: ${formatBRL(session.taxa_servico)}`,
    `TOTAL A PAGAR: ${formatBRL(session.total)}`,
    '==============================',
    '',
    'Está tudo certo com o seu pedido?'
  ].join('\n');
}

function gerarTelaPagamentoInicial() {
  return [
    'Como você prefere pagar?',
    '',
    '1 - Pix (aprovação instantânea)',
    '2 - Meus métodos de pagamento do iFood',
    '3 - Pagamento na entrega / retirada'
  ].join('\n');
}

function gerarTelaMetodosIfood(usuario) {
  return [
    'Identidade confirmada! Escolha um dos seus métodos salvos no iFood:',
    '',
    `1 - ${usuario.metodo_pagamento_salvo}`,
    `2 - Saldo da Carteira iFood (Disponível: ${formatBRL(usuario.saldo_carteira)})`
  ].join('\n');
}

function gerarTelaParcelas(usuario, totalBase) {
  const opcoes = calcularOpcoesParcelamento(totalBase);
  const linhas = opcoes.map((op) => `${op.parcelas} - ${op.descricao}`);
  return [
    `Em quantas vezes deseja parcelar no *${usuario.metodo_pagamento_salvo}*?`,
    '',
    ...linhas
  ].join('\n');
}

function bairroAtendidoPelaLoja(lojaDb, bairroInformado) {
  const bairros = JSON.parse(lojaDb.bairros_atendimento || '[]');
  const alvo = String(bairroInformado || '').trim().toLowerCase();
  return bairros.some((b) => String(b).trim().toLowerCase() === alvo);
}

function notificarWebhookN8n(url, payload) {
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  }).catch((err) => {
    console.warn(`[n8n] Falha ao notificar webhook (${url}): ${err.message}`);
  });
}

function validarEstoqueCarrinho(itens) {
  const disponiveis = [];
  const problemas = [];

  for (const item of itens) {
    const prod = findProdutoDisponivelById.get(item.produto_id);
    if (!prod) {
      problemas.push(`${item.nome} (esgotado)`);
    } else if (prod.quantidade_estoque < item.quantidade) {
      problemas.push(`${item.nome} (apenas ${prod.quantidade_estoque} em estoque)`);
      disponiveis.push({ ...item, preco: Number(prod.preco), quantidade: prod.quantidade_estoque });
    } else {
      disponiveis.push({ ...item, preco: Number(prod.preco) });
    }
  }

  return { disponiveis, problemas };
}

function baixarEstoqueEAlertar(lojaId, lojaNome, itens, pedidoId) {
  const itensCriticos = [];

  for (const item of itens) {
    const qtd = Number(item.quantidade) || 1;
    decrementarEstoqueProduto.run(qtd, qtd, qtd, item.produto_id);
    const atualizado = findProdutoByIdRaw.get(item.produto_id);

    if (atualizado && atualizado.quantidade_estoque <= atualizado.estoque_minimo) {
      itensCriticos.push({
        produto_id: atualizado.id,
        nome: atualizado.nome,
        quantidade_atual: atualizado.quantidade_estoque,
        estoque_minimo: atualizado.estoque_minimo,
        nivel: atualizado.quantidade_estoque === 0 ? 'ZERADO' : 'BAIXO'
      });
    }
  }

  if (itensCriticos.length > 0) {
    const payload = {
      evento: 'ESTOQUE_CRITICO',
      loja_id: lojaId,
      loja_nome: lojaNome,
      pedido_id: pedidoId,
      itens_criticos: itensCriticos,
      gerado_em: new Date().toISOString()
    };

    console.log(`\n[ALERTA ESTOQUE -> n8n | ${lojaNome}]: ${JSON.stringify(itensCriticos)}\n`);
    notificarWebhookN8n(process.env.N8N_WEBHOOK_ESTOQUE_URL, payload);
  }
}

function registrarInteracao({ from, lojaId, etapa, mensagemUsuario, respostaSistema, convertido }) {
  try {
    insertInteracao.run(
      hashWhatsapp(from),
      lojaId || null,
      etapa,
      sanitizePII(mensagemUsuario),
      sanitizePII(respostaSistema),
      convertido ? 1 : 0
    );
  } catch (err) {
    console.warn(`[Interacoes] Falha ao persistir log: ${err.message}`);
  }
}

function calcularMetricasLoja(lojaId, dataRef) {
  const pedidos = findPedidosLojaPorData.all(lojaId, dataRef);
  const interacoes = findInteracoesLojaPorData.all(lojaId, dataRef);
  const produtos = findTodosProdutosLoja.all(lojaId);

  let faturamentoCentavos = 0;
  let pedidosConfirmadosOuEntregues = 0;
  let pedidosCancelados = 0;
  let pedidosAguardandoPagamento = 0;
  const porModalidade = {};
  const porMetodoPagamento = {};
  const vendasPorProduto = {};

  for (const p of pedidos) {
    if (p.status === 'CANCELADO') {
      pedidosCancelados += 1;
    } else if (p.status === 'AGUARDANDO_PAGAMENTO') {
      pedidosAguardandoPagamento += 1;
    } else {
      pedidosConfirmadosOuEntregues += 1;
      faturamentoCentavos += Math.round(Number(p.total) * 100);
    }

    porModalidade[p.modalidade] = (porModalidade[p.modalidade] || 0) + 1;
    porMetodoPagamento[p.metodo_pagamento] = (porMetodoPagamento[p.metodo_pagamento] || 0) + 1;

    if (p.status !== 'CANCELADO' && p.status !== 'AGUARDANDO_PAGAMENTO') {
      try {
        const itens = JSON.parse(p.itens_json || '[]');
        for (const item of itens) {
          vendasPorProduto[item.nome] = (vendasPorProduto[item.nome] || 0) + (Number(item.quantidade) || 1);
        }
      } catch {
      }
    }
  }

  const faturamentoTotal = Number((faturamentoCentavos / 100).toFixed(2));
  const ticketMedio =
    pedidosConfirmadosOuEntregues > 0
      ? Number((faturamentoCentavos / pedidosConfirmadosOuEntregues / 100).toFixed(2))
      : 0;

  const produtosMaisVendidos = Object.entries(vendasPorProduto)
    .map(([nome, quantidade]) => ({ nome, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);

  const etapasContagem = {};
  let interacoesConvertidas = 0;
  for (const inter of interacoes) {
    etapasContagem[inter.etapa] = (etapasContagem[inter.etapa] || 0) + 1;
    if (inter.convertido) interacoesConvertidas += 1;
  }

  const estoqueCritico = produtos
    .filter((p) => p.quantidade_estoque <= p.estoque_minimo || p.disponivel === 0)
    .map((p) => ({
      produto_id: p.id,
      nome: p.nome,
      quantidade_estoque: p.quantidade_estoque,
      estoque_minimo: p.estoque_minimo,
      disponivel: Boolean(p.disponivel)
    }));

  return {
    metricas_sql: {
      total_pedidos: pedidos.length,
      pedidos_confirmados_ou_entregues: pedidosConfirmadosOuEntregues,
      pedidos_aguardando_pagamento: pedidosAguardandoPagamento,
      pedidos_cancelados: pedidosCancelados,
      faturamento_total: faturamentoTotal,
      ticket_medio: ticketMedio,
      por_modalidade: porModalidade,
      por_metodo_pagamento: porMetodoPagamento,
      produtos_mais_vendidos: produtosMaisVendidos,
      total_interacoes: interacoes.length,
      interacoes_convertidas: interacoesConvertidas,
      interacoes_por_etapa: etapasContagem,
      estoque_critico: estoqueCritico
    },
    estoque_completo: produtos.map((p) => ({
      produto_id: p.id,
      nome: p.nome,
      preco: Number(p.preco),
      quantidade_estoque: p.quantidade_estoque,
      estoque_minimo: p.estoque_minimo,
      disponivel: Boolean(p.disponivel)
    })),
    interacoes_anonimizadas: interacoes.map((i) => ({
      id: i.id,
      whatsapp_hash: i.whatsapp_hash,
      etapa: i.etapa,
      mensagem_usuario: i.mensagem_usuario,
      convertido: Boolean(i.convertido),
      criado_em: i.criado_em
    }))
  };
}

const FALLBACK_MODELS = [
  ...new Set(
    [
      process.env.GEMINI_MODEL,
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview'
    ].filter(Boolean)
  )
];

const DISCOVERY_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    resposta_whatsapp: {
      type: SchemaType.STRING,
      description: 'Mensagem amigável, direta e no estilo WhatsApp para enviar ao cliente, sem nunca exibir códigos ou IDs internos.'
    },
    intencao: {
      type: SchemaType.STRING,
      enum: ['CONVERSA_OU_DESCOBERTA', 'PEDIDO_EM_ANDAMENTO', 'FECHAR_PEDIDO', 'TROCAR_LOJA'],
      description:
        'CONVERSA_OU_DESCOBERTA: saudação, dúvida ou escolha de loja; PEDIDO_EM_ANDAMENTO: cliente adicionou/alterou itens no carrinho; FECHAR_PEDIDO: cliente confirmou que não quer mais itens e deseja fechar; TROCAR_LOJA: cliente pediu item de uma loja diferente da atual do carrinho.'
    },
    loja_id_contexto: {
      type: SchemaType.INTEGER,
      description: 'ID interno da loja sobre a qual o cliente está falando ou visualizando cardápio, se aplicável. Use 0 se não houver loja definida.'
    },
    itens: {
      type: SchemaType.ARRAY,
      description:
        'Lista completa e atualizada de todos os itens desejados no carrinho atual usando exclusivamente os IDs internos do catálogo. Se o cliente adicionar um item novo, mantenha os anteriores do carrinho e adicione o novo.',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          produto_id: { type: SchemaType.INTEGER },
          quantidade: { type: SchemaType.INTEGER },
          observacao: {
            type: SchemaType.STRING,
            description: 'Observação opcional mencionada pelo cliente para este item (ex.: sem cebola, mandar guardanapo). Deixe vazio se não houver.'
          }
        },
        required: ['produto_id', 'quantidade']
      }
    }
  },
  required: ['resposta_whatsapp', 'intencao', 'itens']
};

const ESCAPE_CLASSIFIER_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    acao: {
      type: SchemaType.STRING,
      enum: ['ALTERAR_PEDIDO', 'CANCELAR_PEDIDO', 'CONSULTAR_STATUS', 'ENTRADA_INVALIDA'],
      description:
        'ALTERAR_PEDIDO: quer voltar ao cardápio, adicionar/remover/trocar itens ou mudar de loja; CANCELAR_PEDIDO: desistiu da compra; CONSULTAR_STATUS: perguntou sobre o andamento de pedidos anteriores; ENTRADA_INVALIDA: resposta ambígua ou código incorreto.'
    }
  },
  required: ['acao']
};

const ADDRESS_PARSER_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    valido: {
      type: SchemaType.BOOLEAN,
      description: 'true se o texto contiver pelo menos nome de rua/avenida e bairro.'
    },
    logradouro_numero: {
      type: SchemaType.STRING,
      description: 'Rua, avenida, número e complemento, sem o bairro.'
    },
    bairro: {
      type: SchemaType.STRING,
      description: 'Nome do bairro extraído.'
    }
  },
  required: ['valido', 'logradouro_numero', 'bairro']
};

const LOJISTA_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    resposta_whatsapp: {
      type: SchemaType.STRING,
      description: 'Resposta objetiva, analítica e natural em estilo WhatsApp para o dono da loja.'
    }
  },
  required: ['resposta_whatsapp']
};

function buildDiscoverySystemPrompt(catalogo, session, pedidosAtivos, usuario) {
  const instrucaoNome = !session.greeted
    ? `Este é o primeiro contato da sessão com o cliente. Cumprimente-o pelo primeiro nome (${usuario.nome}) de forma natural.`
    : `Você já cumprimentou ${usuario.nome} nesta conversa; não repita o nome dele mecanicamente.`;

  return [
    'Você é o Assistente Virtual de Descoberta e Vendas do iFood no WhatsApp.',
    'Sua função é ajudar clientes a descobrirem lojas, escolherem produtos e montarem o carrinho usando EXCLUSIVAMENTE os dados reais abaixo.',
    instrucaoNome,
    '',
    'FUNIL DE ATENDIMENTO EM 2 ETAPAS (SIGA RIGOROSAMENTE):',
    'ETAPA 1 — Escolha da loja:',
    '- Quando o cliente disser o que quer comer ou iniciar a conversa sem ter escolhido uma loja específica ainda, apresente APENAS as lojas abertas relevantes com uma visão geral rápida do que cada uma oferece.',
    '- REGRA DE LOJA ÚNICA: Se houver APENAS 1 loja aberta compatível com o pedido do cliente, apresente essa loja e pergunte diretamente se ele gostaria de ver o cardápio dela (NÃO pergunte "qual loja você prefere?"). Se houver 2 ou mais lojas compatíveis, pergunte qual ele prefere.',
    '- NÃO liste os produtos individuais nem os preços na Etapa 1.',
    '',
    'ETAPA 2 — Cardápio da loja escolhida e Montagem de Carrinho:',
    '- SOMENTE quando o cliente escolher ou pedir para ver uma loja específica, liste os produtos disponíveis daquela loja com seus preços em R$.',
    '- Quando o cliente escolher itens (ex.: "quero 2 brownies"), atualize a lista "itens" no JSON com os IDs internos exatos, quantidades e eventuais observações espontâneas, defina intencao="PEDIDO_EM_ANDAMENTO" e pergunte se ele deseja adicionar mais algum item.',
    '- Quando o cliente responder que não quer mais itens ou que pode fechar o pedido (ex.: "não", "só isso", "pode fechar"), mantenha os itens no JSON e defina intencao="FECHAR_PEDIDO".',
    '- Se já houver itens de uma loja no carrinho e o cliente pedir um item de OUTRA loja, retorne o novo item desejado e defina intencao="TROCAR_LOJA".',
    '- Se o cliente perguntar sobre pedidos já feitos anteriormente, consulte a seção PEDIDOS EM ANDAMENTO abaixo e informe o status atual.',
    '',
    'REGRAS OBRIGATÓRIAS:',
    '1. NUNCA exiba "[ID: X]" ou números de ID internos na resposta ao cliente. Os IDs servem exclusivamente para você preencher o JSON estruturado.',
    '2. NUNCA invente lojas, produtos, preços ou receitas.',
    '3. Mantenha respostas curtas, naturais e amigáveis.',
    '',
    '--- CARRINHO ATUAL DO CLIENTE ---',
    formatCarrinhoForPrompt(session.carrinho),
    '',
    '--- PEDIDOS EM ANDAMENTO DESTE CLIENTE ---',
    formatPedidosAtivosForPrompt(pedidosAtivos),
    '',
    '--- LOJAS ABERTAS E CARDÁPIOS DISPONÍVEIS ---',
    formatCatalogoForPrompt(catalogo),
    '--------------------------------------------'
  ].join('\n');
}

async function callGeminiStructured({ systemPrompt, history = [], userText, schema }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY ausente');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of FALLBACK_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      });

      const chat = model.startChat({
        history: history.map((entry) => ({
          role: entry.role,
          parts: entry.parts.map((part) => ({ ...part }))
        }))
      });

      const result = await chat.sendMessage(userText);
      const rawText = result.response.text();
      return JSON.parse(rawText);
    } catch (err) {
      console.warn(`[Gemini] Falha com modelo '${modelName}': ${err.message}. Tentando próximo...`);
      lastError = err;
    }
  }

  throw lastError || new Error('Nenhum modelo Gemini respondeu');
}

async function classificarDesvioCheckout(step, userText) {
  const prompt = [
    `O cliente está na etapa de checkout "${step}" de um pedido no WhatsApp, mas enviou uma mensagem que não corresponde às opções numéricas esperadas.`,
    'Classifique a intenção do cliente:',
    '- ALTERAR_PEDIDO: quer voltar ao cardápio, adicionar/remover/trocar itens ou mudar de loja.',
    '- CANCELAR_PEDIDO: quer desistir ou cancelar o pedido inteiro.',
    '- CONSULTAR_STATUS: está perguntando como está um pedido anterior já realizado.',
    '- ENTRADA_INVALIDA: digitou algo sem sentido, código errado ou resposta ambígua.'
  ].join('\n');

  try {
    const res = await callGeminiStructured({
      systemPrompt: prompt,
      userText,
      schema: ESCAPE_CLASSIFIER_SCHEMA
    });
    return res.acao;
  } catch {
    return 'ENTRADA_INVALIDA';
  }
}

async function extrairEnderecoEstruturado(userText) {
  const prompt = [
    'Extraia o logradouro com número/complemento e o bairro de um endereço brasileiro informado pelo usuário no WhatsApp.',
    'Se não houver informação suficiente para identificar rua e bairro, retorne valido=false.'
  ].join('\n');

  try {
    return await callGeminiStructured({
      systemPrompt: prompt,
      userText,
      schema: ADDRESS_PARSER_SCHEMA
    });
  } catch {
    return { valido: false, logradouro_numero: '', bairro: '' };
  }
}

async function handleLojistaTurn(session, usuario, text) {
  const loja = findLojaById.get(usuario.loja_id);
  if (!loja) {
    return 'Sua conta de lojista não está vinculada a nenhuma loja cadastrada.';
  }

  const hoje = getTodayLocalDate();
  const resumoHoje = calcularMetricasLoja(loja.id, hoje);
  const contextosSalvos = findContextosRecentesLoja.all(loja.id, 7).map((c) => ({
    data_referencia: c.data_referencia,
    contexto: c.contexto_json,
    relatorio: c.relatorio_texto,
    alertas: c.alertas_json
  }));

  const instrucaoNome = !session.greeted
    ? `Cumprimente ${usuario.nome} de forma natural no primeiro contato.`
    : `Você já cumprimentou ${usuario.nome}; vá direto ao ponto.`;

  const systemPrompt = [
    `Você é o Agente de Conhecimento e Gestão da loja "${loja.nome}" no WhatsApp.`,
    'Sua missão é responder perguntas do dono da loja com base EXCLUSIVAMENTE nos dados reais abaixo (métricas SQL em tempo real, estoque atual, contextos destilados pelo n8n e interações anonimizadas do dia).',
    instrucaoNome,
    '',
    'REGRAS OBRIGATÓRIAS:',
    '1. NUNCA invente vendas, contagens, motivos de abandono ou itens procurados que não estejam explícitos nos dados abaixo.',
    '2. Para valores financeiros, estoque e quantidades vendidas, confie prioritariamente nas métricas SQL e estoque atual.',
    '3. Para perguntas qualitativas ou de demanda não atendida (ex.: pedidos de itens fora do cardápio, observações recorrentes), use os contextos destilados pelo n8n e, se o fechamento de hoje ainda não tiver sido processado, consulte diretamente as interações anonimizadas do dia.',
    '4. Se não houver registros para responder à pergunta, informe isso com transparência.',
    '5. Mantenha respostas curtas, claras e acionáveis para leitura no WhatsApp.',
    '',
    `--- MÉTRICAS SQL DE HOJE (${hoje}) ---`,
    JSON.stringify(resumoHoje.metricas_sql),
    '',
    '--- ESTOQUE ATUAL DA LOJA ---',
    JSON.stringify(resumoHoje.estoque_completo),
    '',
    '--- CONTEXTOS DIÁRIOS DESTILADOS PELO N8N (ÚLTIMOS 7 DIAS) ---',
    JSON.stringify(contextosSalvos),
    '',
    `--- INTERAÇÕES ANONIMIZADAS DE HOJE (${hoje}) ---`,
    JSON.stringify(resumoHoje.interacoes_anonimizadas.slice(-50))
  ].join('\n');

  const aiResponse = await callGeminiStructured({
    systemPrompt,
    history: session.history,
    userText: text,
    schema: LOJISTA_RESPONSE_SCHEMA
  });

  session.greeted = true;
  const resposta = sanitizeCustomerText(aiResponse.resposta_whatsapp);
  pushHistory(session, text, resposta);
  return resposta;
}

async function handleDiscoveryTurn(session, usuario, text) {
  const catalogo = loadCatalogo(usuario.bairro_padrao);
  const pedidosAtivos = findPedidosAtivosUsuario.all(usuario.whatsapp_numero);
  const systemPrompt = buildDiscoverySystemPrompt(catalogo, session, pedidosAtivos, usuario);

  const aiResponse = await callGeminiStructured({
    systemPrompt,
    history: session.history,
    userText: text,
    schema: DISCOVERY_RESPONSE_SCHEMA
  });

  session.greeted = true;
  const respostaLimpa = sanitizeCustomerText(aiResponse.resposta_whatsapp);

  if (aiResponse.loja_id_contexto && Number(aiResponse.loja_id_contexto) > 0) {
    const lojaCheck = findLojaById.get(Number(aiResponse.loja_id_contexto));
    if (lojaCheck) {
      session.ultimaLojaId = lojaCheck.id;
    }
  }

  const itensValidados = [];
  const lojasDetectadas = new Map();

  for (const item of aiResponse.itens || []) {
    const qtd = Math.max(1, Math.floor(Number(item.quantidade) || 1));
    const produtoDb = findProdutoDisponivelById.get(item.produto_id);
    if (produtoDb) {
      const qtdAjustada = Math.min(qtd, produtoDb.quantidade_estoque);
      itensValidados.push({
        produto_id: produtoDb.id,
        loja_id: produtoDb.loja_id,
        loja_nome: produtoDb.loja_nome,
        nome: produtoDb.nome,
        preco: Number(produtoDb.preco),
        quantidade: qtdAjustada,
        observacao: String(item.observacao || '').trim()
      });
      lojasDetectadas.set(produtoDb.loja_id, produtoDb.loja_nome);
    }
  }

  if (aiResponse.intencao !== 'CONVERSA_OU_DESCOBERTA' && itensValidados.length > 0) {
    const lojaAlvoId = itensValidados[itensValidados.length - 1].loja_id;
    const lojaAlvoNome = itensValidados[itensValidados.length - 1].loja_nome;
    session.ultimaLojaId = lojaAlvoId;

    const houveConflitoLoja =
      (session.carrinho.loja_id && session.carrinho.loja_id !== lojaAlvoId) ||
      lojasDetectadas.size > 1 ||
      aiResponse.intencao === 'TROCAR_LOJA';

    if (houveConflitoLoja && session.carrinho.itens.length > 0) {
      const novosItensDaNovaLoja = itensValidados.filter((i) => i.loja_id === lojaAlvoId);
      session.pendenteTrocaLoja = {
        loja_id: lojaAlvoId,
        loja_nome: lojaAlvoNome,
        itens: novosItensDaNovaLoja
      };
      session.step = 'CONFIRMACAO_TROCA_LOJA';

      const msgTroca = `Você já tem itens de *${session.carrinho.loja_nome}* no seu carrinho. Deseja esvaziar o carrinho atual e iniciar um novo pedido em *${lojaAlvoNome}*?\n\n1 - Sim, trocar de loja\n2 - Não, manter carrinho atual`;
      pushHistory(session, text, msgTroca);
      return { resposta: msgTroca, lojaId: lojaAlvoId, etapa: 'CONFIRMACAO_TROCA_LOJA', convertido: false };
    }

    session.carrinho = {
      loja_id: lojaAlvoId,
      loja_nome: lojaAlvoNome,
      itens: itensValidados.filter((i) => i.loja_id === lojaAlvoId)
    };
  } else if (aiResponse.intencao === 'PEDIDO_EM_ANDAMENTO' && (aiResponse.itens || []).length === 0) {
    session.carrinho = { loja_id: null, loja_nome: null, itens: [] };
  }

  if (aiResponse.intencao === 'FECHAR_PEDIDO') {
    if (session.carrinho.itens.length === 0) {
      const msgVazio = 'Seu carrinho ainda está vazio! Me diga qual loja ou item você gostaria de pedir primeiro.';
      pushHistory(session, text, msgVazio);
      return { resposta: msgVazio, lojaId: session.ultimaLojaId, etapa: 'DESCOBERTA', convertido: false };
    }

    const { disponiveis, problemas } = validarEstoqueCarrinho(session.carrinho.itens);

    if (problemas.length > 0) {
      session.carrinho.itens = disponiveis;
      const msgIndisponivel = `Puxa, tivemos uma atualização de estoque na loja: *${problemas.join(', ')}*. Atualizei seu carrinho — deseja substituir por outro item ou fechar com o que restou?`;
      pushHistory(session, text, msgIndisponivel);
      return { resposta: msgIndisponivel, lojaId: session.carrinho.loja_id, etapa: 'DESCOBERTA', convertido: false };
    }

    session.carrinho.itens = disponiveis;
    session.step = 'MODALIDADE_ENTREGA';
    const msgModalidade = [
      `Perfeito! Vamos fechar seu pedido na *${session.carrinho.loja_nome}*.`,
      '',
      'Como você prefere receber?',
      '1 - Entrega',
      '2 - Retirada na loja (sem taxa de entrega)'
    ].join('\n');

    pushHistory(session, text, msgModalidade);
    return { resposta: msgModalidade, lojaId: session.carrinho.loja_id, etapa: 'MODALIDADE_ENTREGA', convertido: false };
  }

  pushHistory(session, text, respostaLimpa);
  return {
    resposta: respostaLimpa,
    lojaId: session.carrinho.loja_id || session.ultimaLojaId,
    etapa: 'DESCOBERTA',
    convertido: false
  };
}

function reapresentarEtapaAtual(session, usuario) {
  if (session.step === 'MODALIDADE_ENTREGA') {
    return 'Como você prefere receber?\n1 - Entrega\n2 - Retirada na loja (sem taxa de entrega)';
  }
  if (session.step === 'ESCOLHA_ENDERECO') {
    const enderecos = findEnderecosUsuario.all(usuario.whatsapp_numero);
    return gerarTelaEnderecos(enderecos);
  }
  if (session.step === 'NOVO_ENDERECO_TEXTO') {
    return 'Digite o novo endereço completo com rua, número e bairro (ex.: Rua Augusta, 500 - Consolação):';
  }
  if (session.step === 'NOVO_ENDERECO_ROTULO') {
    return 'Como você deseja salvar este endereço? (ex.: Casa, Trabalho, Outro)';
  }
  if (session.step === 'CONFIRMACAO_NOTA') {
    return gerarNotaFiscalPadrao(session);
  }
  if (session.step === 'ESCOLHA_PAGAMENTO') {
    return gerarTelaPagamentoInicial();
  }
  if (session.step === 'VALIDACAO_SMS') {
    return 'Digite o código de 6 dígitos enviado por SMS para continuar:';
  }
  if (session.step === 'METODOS_IFOOD') {
    return gerarTelaMetodosIfood(usuario);
  }
  if (session.step === 'ESCOLHA_PARCELAS') {
    return gerarTelaParcelas(usuario, session.total);
  }
  return 'Como posso ajudar?';
}

function atualizarTotaisPedido(session, taxaEntrega) {
  const subtotalCentavos = session.carrinho.itens.reduce(
    (acc, item) => acc + Math.round(Number(item.preco) * 100) * (Number(item.quantidade) || 1),
    0
  );
  const taxaEntregaCentavos = Math.round(Number(taxaEntrega || 0) * 100);
  const taxaServicoCentavos = Math.round(TAXA_SERVICO_IFOOD * 100);
  session.subtotal = Number((subtotalCentavos / 100).toFixed(2));
  session.taxa_entrega = Number((taxaEntregaCentavos / 100).toFixed(2));
  session.taxa_servico = Number((taxaServicoCentavos / 100).toFixed(2));
  session.total = Number(((subtotalCentavos + taxaEntregaCentavos + taxaServicoCentavos) / 100).toFixed(2));
}

function concluirPedidoNoBanco({ from, session, metodoPagamento, parcelas, statusInicial, totalFinal }) {
  const { disponiveis, problemas } = validarEstoqueCarrinho(session.carrinho.itens);
  if (problemas.length > 0) {
    session.carrinho.itens = disponiveis;
    session.step = 'DESCOBERTA';
    return {
      ok: false,
      erroEstoque: `Puxa, antes de concluir houve atualização de estoque: *${problemas.join(', ')}*. Atualizei seu carrinho — deseja ajustar ou continuar com os itens disponíveis?`
    };
  }

  const lojaId = session.carrinho.loja_id;
  const lojaNome = session.carrinho.loja_nome;
  const itensSnapshot = disponiveis;
  const modalidadeAtual = session.modalidade;
  const enderecoTexto = session.enderecoSelecionado
    ? `${session.enderecoSelecionado.rotulo}: ${session.enderecoSelecionado.logradouro_numero}, ${session.enderecoSelecionado.bairro}`
    : null;

  const result = insertPedido.run(
    from,
    lojaId,
    JSON.stringify(itensSnapshot),
    modalidadeAtual,
    enderecoTexto,
    session.subtotal,
    session.taxa_entrega,
    session.taxa_servico,
    totalFinal,
    metodoPagamento,
    parcelas,
    statusInicial
  );

  const pedidoId = Number(result.lastInsertRowid);
  baixarEstoqueEAlertar(lojaId, lojaNome, itensSnapshot, pedidoId);
  resetCheckoutState(session);

  return {
    ok: true,
    pedidoId,
    lojaId,
    lojaNome,
    modalidadeAtual
  };
}

async function handleClienteTurn(from, text, normalized, usuario, session) {
  const lojaAtual = session.carrinho.loja_id || session.ultimaLojaId;

  if (session.step === 'DESCOBERTA') {
    return handleDiscoveryTurn(session, usuario, text);
  }

  if (session.step === 'CONFIRMACAO_TROCA_LOJA') {
    if (['1', 'sim', 's', 'trocar', 'pode', 'ok'].includes(normalized)) {
      session.carrinho = session.pendenteTrocaLoja;
      session.ultimaLojaId = session.carrinho.loja_id;
      session.pendenteTrocaLoja = null;
      session.step = 'DESCOBERTA';
      const msg = `Carrinho atualizado para *${session.carrinho.loja_nome}*! Deseja adicionar mais algum item ou podemos fechar o pedido?`;
      pushHistory(session, text, msg);
      return { resposta: msg, lojaId: session.carrinho.loja_id, etapa: 'CONFIRMACAO_TROCA_LOJA', convertido: false };
    }

    if (['2', 'nao', 'não', 'n', 'manter'].includes(normalized)) {
      session.pendenteTrocaLoja = null;
      session.step = 'DESCOBERTA';
      const msg = `Sem problemas! Mantive os itens de *${session.carrinho.loja_nome}*. Deseja adicionar algo mais ou fechar o pedido?`;
      pushHistory(session, text, msg);
      return { resposta: msg, lojaId: session.carrinho.loja_id, etapa: 'CONFIRMACAO_TROCA_LOJA', convertido: false };
    }

    return {
      resposta: 'Por favor, responda *1* (Sim, trocar de loja) ou *2* (Não, manter carrinho atual).',
      lojaId: lojaAtual,
      etapa: 'CONFIRMACAO_TROCA_LOJA',
      convertido: false
    };
  }

  if (session.step === 'MODALIDADE_ENTREGA') {
    const isEntrega = ['1', 'entrega', 'entregar', 'delivery'].includes(normalized);
    const isRetirada = ['2', 'retirada', 'retirar', 'buscar', 'loja'].includes(normalized);

    if (isEntrega) {
      session.modalidade = 'ENTREGA';
      session.step = 'ESCOLHA_ENDERECO';
      const enderecos = findEnderecosUsuario.all(from);
      const telaEnderecos = gerarTelaEnderecos(enderecos);
      pushHistory(session, text, telaEnderecos);
      return { resposta: telaEnderecos, lojaId: lojaAtual, etapa: 'MODALIDADE_ENTREGA', convertido: false };
    }

    if (isRetirada) {
      session.modalidade = 'RETIRADA';
      session.enderecoSelecionado = null;
      atualizarTotaisPedido(session, 0);
      session.step = 'CONFIRMACAO_NOTA';

      const nota = gerarNotaFiscalPadrao(session);
      pushHistory(session, text, nota);
      return { resposta: nota, lojaId: lojaAtual, etapa: 'MODALIDADE_ENTREGA', convertido: false };
    }
  }

  if (session.step === 'ESCOLHA_ENDERECO') {
    const enderecos = findEnderecosUsuario.all(from);
    const opcaoNumerica = Number(normalized);
    const opcaoCadastrar = enderecos.length + 1;

    if (
      opcaoNumerica === opcaoCadastrar ||
      ['novo', 'cadastrar', 'outro', 'outro endereco', 'outro endereço', 'novo endereco', 'novo endereço'].includes(normalized)
    ) {
      session.step = 'NOVO_ENDERECO_TEXTO';
      const msgNovo = 'Certo! Digite o novo endereço completo com rua, número e bairro (ex.: Rua Augusta, 500 - Consolação):';
      pushHistory(session, text, msgNovo);
      return { resposta: msgNovo, lojaId: lojaAtual, etapa: 'ESCOLHA_ENDERECO', convertido: false };
    }

    let escolhido = null;
    if (!Number.isNaN(opcaoNumerica) && opcaoNumerica >= 1 && opcaoNumerica <= enderecos.length) {
      escolhido = enderecos[opcaoNumerica - 1];
    } else {
      escolhido = enderecos.find((e) => e.rotulo.toLowerCase() === normalized) || null;
    }

    if (escolhido) {
      const lojaDb = findLojaById.get(session.carrinho.loja_id);
      if (!bairroAtendidoPelaLoja(lojaDb, escolhido.bairro)) {
        const msgForaArea = [
          `A loja *${session.carrinho.loja_nome}* não realiza entregas no bairro *${escolhido.bairro}* (${escolhido.rotulo}).`,
          '',
          'Escolha outro endereço salvo, cadastre um novo endereço na área de atendimento ou avise se prefere mudar para retirada na loja:',
          '',
          gerarTelaEnderecos(enderecos)
        ].join('\n');
        return { resposta: msgForaArea, lojaId: lojaAtual, etapa: 'BLOQUEIO_BAIRRO', convertido: false };
      }

      session.enderecoSelecionado = escolhido;
      atualizarTotaisPedido(session, lojaDb?.taxa_entrega);
      session.step = 'CONFIRMACAO_NOTA';

      const nota = gerarNotaFiscalPadrao(session);
      pushHistory(session, text, nota);
      return { resposta: nota, lojaId: lojaAtual, etapa: 'ESCOLHA_ENDERECO', convertido: false };
    }
  }

  if (session.step === 'NOVO_ENDERECO_TEXTO') {
    const parsed = await extrairEnderecoEstruturado(text);
    if (!parsed.valido || !parsed.logradouro_numero || !parsed.bairro) {
      return {
        resposta: 'Não consegui identificar a rua e o bairro. Por favor, informe no formato: Rua/Avenida, número - Bairro:',
        lojaId: lojaAtual,
        etapa: 'NOVO_ENDERECO_TEXTO',
        convertido: false
      };
    }

    const lojaDb = findLojaById.get(session.carrinho.loja_id);
    if (!bairroAtendidoPelaLoja(lojaDb, parsed.bairro)) {
      const enderecos = findEnderecosUsuario.all(from);
      session.step = 'ESCOLHA_ENDERECO';
      const msgFora = [
        `Puxa, a loja *${session.carrinho.loja_nome}* não entrega no bairro *${parsed.bairro}*.`,
        '',
        'Você pode escolher um dos seus endereços abaixo, tentar outro endereço ou pedir retirada na loja:',
        '',
        gerarTelaEnderecos(enderecos)
      ].join('\n');
      return { resposta: msgFora, lojaId: lojaAtual, etapa: 'BLOQUEIO_BAIRRO', convertido: false };
    }

    session.novoEnderecoPendente = {
      logradouro_numero: parsed.logradouro_numero.trim(),
      bairro: parsed.bairro.trim()
    };
    session.step = 'NOVO_ENDERECO_ROTULO';
    return {
      resposta: 'Endereço dentro da área de entrega! Como você deseja salvá-lo na sua conta? (ex.: Casa, Trabalho, Casa da Mãe)',
      lojaId: lojaAtual,
      etapa: 'NOVO_ENDERECO_TEXTO',
      convertido: false
    };
  }

  if (session.step === 'NOVO_ENDERECO_ROTULO') {
    const rotuloLimpo = text.replace(/[^\p{L}\p{N}\s-]/gu, '').trim() || 'Outro';
    const inserido = insertEnderecoUsuario.run(
      from,
      rotuloLimpo,
      session.novoEnderecoPendente.logradouro_numero,
      session.novoEnderecoPendente.bairro
    );

    const lojaDb = findLojaById.get(session.carrinho.loja_id);
    session.enderecoSelecionado = {
      id: Number(inserido.lastInsertRowid),
      rotulo: rotuloLimpo,
      logradouro_numero: session.novoEnderecoPendente.logradouro_numero,
      bairro: session.novoEnderecoPendente.bairro
    };
    session.novoEnderecoPendente = null;
    atualizarTotaisPedido(session, lojaDb?.taxa_entrega);
    session.step = 'CONFIRMACAO_NOTA';

    const nota = `Endereço salvo como *${rotuloLimpo}*!\n\n${gerarNotaFiscalPadrao(session)}`;
    pushHistory(session, text, nota);
    return { resposta: nota, lojaId: lojaAtual, etapa: 'NOVO_ENDERECO_ROTULO', convertido: false };
  }

  if (session.step === 'CONFIRMACAO_NOTA') {
    if (
      [
        '1',
        'sim',
        's',
        'ok',
        'tudo ok',
        'tudo certo',
        'certo',
        'confirmar',
        'confirmo',
        'pode seguir',
        'fechado',
        'beleza'
      ].includes(normalized)
    ) {
      session.step = 'ESCOLHA_PAGAMENTO';
      const telaPagamento = gerarTelaPagamentoInicial();
      pushHistory(session, text, telaPagamento);
      return { resposta: telaPagamento, lojaId: lojaAtual, etapa: 'CONFIRMACAO_NOTA', convertido: false };
    }
  }

  if (session.step === 'ESCOLHA_PAGAMENTO') {
    if (['1', 'pix'].includes(normalized)) {
      const totalBase = session.total;
      const conclusao = concluirPedidoNoBanco({
        from,
        session,
        metodoPagamento: 'PIX',
        parcelas: 'À vista',
        statusInicial: 'AGUARDANDO_PAGAMENTO',
        totalFinal: totalBase
      });

      if (!conclusao.ok) {
        pushHistory(session, text, conclusao.erroEstoque);
        return { resposta: conclusao.erroEstoque, lojaId: lojaAtual, etapa: 'ESTOQUE_INSUFICIENTE', convertido: false };
      }

      const pixCopiaECola = `00020126580014br.gov.bcb.pix0136whatfood-pedido-${conclusao.pedidoId}-tx5204000053039865802BR5913WHATFOOD_MVP6009SAO_PAULO62070503***6304A1B2`;
      const msgPix = [
        `Pedido #${conclusao.pedidoId} registrado, ${usuario.nome}! Aqui está o seu código Pix Copia e Cola no valor de ${formatBRL(totalBase)}:`,
        '',
        pixCopiaECola,
        '',
        'Não se preocupe, assim que recebermos seu pagamento te aviso por aqui!'
      ].join('\n');

      pushHistory(session, text, msgPix);
      return { resposta: msgPix, lojaId: conclusao.lojaId, etapa: 'PEDIDO_CONCLUIDO', convertido: true };
    }

    if (['2', 'ifood', 'meus metodos', 'meus métodos', 'cartao', 'cartão', 'saldo'].includes(normalized)) {
      if (session.identidadeVerificada) {
        session.step = 'METODOS_IFOOD';
        return { resposta: gerarTelaMetodosIfood(usuario), lojaId: lojaAtual, etapa: 'ESCOLHA_PAGAMENTO', convertido: false };
      }

      const codigo = String(crypto.randomInt(100000, 1000000));
      session.smsCodigo = codigo;
      session.smsTentativas = 0;
      session.step = 'VALIDACAO_SMS';

      console.log(`\n[SMS GATEWAY SIMULADO -> ${from}] Seu código de verificação iFood é: ${codigo}\n`);

      const msgSms = [
        `Para proteger sua conta, enviamos um código de 6 dígitos por SMS para o número ${from}.`,
        '',
        'Digite o código recebido para visualizar seus métodos de pagamento salvos no iFood:'
      ].join('\n');

      pushHistory(session, text, msgSms);
      return { resposta: msgSms, lojaId: lojaAtual, etapa: 'VALIDACAO_SMS', convertido: false };
    }

    if (['3', 'entrega', 'retirada', 'dinheiro', 'maquininha'].includes(normalized)) {
      const totalBase = session.total;
      const conclusao = concluirPedidoNoBanco({
        from,
        session,
        metodoPagamento: 'PAGAMENTO_NA_ENTREGA',
        parcelas: 'Na entrega',
        statusInicial: 'CONFIRMADO',
        totalFinal: totalBase
      });

      if (!conclusao.ok) {
        pushHistory(session, text, conclusao.erroEstoque);
        return { resposta: conclusao.erroEstoque, lojaId: lojaAtual, etapa: 'ESTOQUE_INSUFICIENTE', convertido: false };
      }

      const msgEntrega = `Pedido #${conclusao.pedidoId} confirmado, ${usuario.nome}! A loja *${conclusao.lojaNome}* já recebeu seu pedido com pagamento na ${conclusao.modalidadeAtual === 'RETIRADA' ? 'retirada' : 'entrega'}.`;
      pushHistory(session, text, msgEntrega);
      return { resposta: msgEntrega, lojaId: conclusao.lojaId, etapa: 'PEDIDO_CONCLUIDO', convertido: true };
    }
  }

  if (session.step === 'VALIDACAO_SMS') {
    if (/^\d{6}$/.test(normalized)) {
      if (normalized === session.smsCodigo) {
        session.identidadeVerificada = true;
        session.step = 'METODOS_IFOOD';
        const telaIfood = gerarTelaMetodosIfood(usuario);
        pushHistory(session, text, telaIfood);
        return { resposta: telaIfood, lojaId: lojaAtual, etapa: 'VALIDACAO_SMS', convertido: false };
      }

      session.smsTentativas += 1;
      if (session.smsTentativas >= MAX_SMS_ATTEMPTS) {
        session.smsCodigo = null;
        session.smsTentativas = 0;
        session.step = 'ESCOLHA_PAGAMENTO';
        return {
          resposta: `Número máximo de ${MAX_SMS_ATTEMPTS} tentativas excedido. Escolha outra forma de pagamento:\n\n${gerarTelaPagamentoInicial()}`,
          lojaId: lojaAtual,
          etapa: 'FALHA_SMS',
          convertido: false
        };
      }

      return {
        resposta: `Código SMS incorreto. Você ainda tem ${MAX_SMS_ATTEMPTS - session.smsTentativas} tentativa(s). Digite o código de 6 dígitos:`,
        lojaId: lojaAtual,
        etapa: 'VALIDACAO_SMS',
        convertido: false
      };
    }
  }

  if (session.step === 'METODOS_IFOOD') {
    if (['1', 'cartao', 'cartão', 'mastercard', 'credito', 'crédito'].includes(normalized)) {
      session.step = 'ESCOLHA_PARCELAS';
      const telaParcelas = gerarTelaParcelas(usuario, session.total);
      pushHistory(session, text, telaParcelas);
      return { resposta: telaParcelas, lojaId: lojaAtual, etapa: 'METODOS_IFOOD', convertido: false };
    }

    if (['2', 'saldo', 'carteira'].includes(normalized)) {
      const saldoAtual = Number(usuario.saldo_carteira);
      if (saldoAtual < session.total) {
        return {
          resposta: `Seu saldo disponível (${formatBRL(saldoAtual)}) é insuficiente para o total de ${formatBRL(session.total)}. Digite *1* para pagar com ${usuario.metodo_pagamento_salvo} ou peça para alterar o pedido.`,
          lojaId: lojaAtual,
          etapa: 'SALDO_INSUFICIENTE',
          convertido: false
        };
      }

      const totalBase = session.total;
      const conclusao = concluirPedidoNoBanco({
        from,
        session,
        metodoPagamento: 'SALDO_IFOOD',
        parcelas: 'À vista',
        statusInicial: 'CONFIRMADO',
        totalFinal: totalBase
      });

      if (!conclusao.ok) {
        pushHistory(session, text, conclusao.erroEstoque);
        return { resposta: conclusao.erroEstoque, lojaId: lojaAtual, etapa: 'ESTOQUE_INSUFICIENTE', convertido: false };
      }

      const novoSaldo = Number((saldoAtual - totalBase).toFixed(2));
      updateSaldoUsuario.run(novoSaldo, from);

      const msgSaldo = `Pagamento de ${formatBRL(totalBase)} aprovado com seu Saldo iFood, ${usuario.nome}! Seu Pedido #${conclusao.pedidoId} foi confirmado e enviado para *${conclusao.lojaNome}*.`;
      pushHistory(session, text, msgSaldo);
      return { resposta: msgSaldo, lojaId: conclusao.lojaId, etapa: 'PEDIDO_CONCLUIDO', convertido: true };
    }
  }

  if (session.step === 'ESCOLHA_PARCELAS') {
    const numParcelas = Number(normalized.replace('x', ''));
    const opcoes = calcularOpcoesParcelamento(session.total);
    const escolhida = opcoes.find((op) => op.parcelas === numParcelas);

    if (escolhida) {
      const conclusao = concluirPedidoNoBanco({
        from,
        session,
        metodoPagamento: usuario.metodo_pagamento_salvo,
        parcelas: escolhida.resumoCurto,
        statusInicial: 'CONFIRMADO',
        totalFinal: escolhida.totalFinal
      });

      if (!conclusao.ok) {
        pushHistory(session, text, conclusao.erroEstoque);
        return { resposta: conclusao.erroEstoque, lojaId: lojaAtual, etapa: 'ESTOQUE_INSUFICIENTE', convertido: false };
      }

      const msgAprovado = `Pagamento aprovado no *${usuario.metodo_pagamento_salvo}* em *${escolhida.resumoCurto}* (Total: ${formatBRL(escolhida.totalFinal)}), ${usuario.nome}! Seu Pedido #${conclusao.pedidoId} foi confirmado e enviado para *${conclusao.lojaNome}*.`;
      pushHistory(session, text, msgAprovado);
      return { resposta: msgAprovado, lojaId: conclusao.lojaId, etapa: 'PEDIDO_CONCLUIDO', convertido: true };
    }
  }

  const acaoDesvio = await classificarDesvioCheckout(session.step, text);

  if (acaoDesvio === 'CONSULTAR_STATUS') {
    const pedidosAtivos = findPedidosAtivosUsuario.all(from);
    const resumoAtivos =
      pedidosAtivos.length > 0
        ? pedidosAtivos.map((p) => `• Pedido #${p.id} (${p.loja_nome}): *${p.status}*`).join('\n')
        : 'Você não tem nenhum pedido em andamento no momento.';

    return {
      resposta: `${resumoAtivos}\n\nVoltando ao seu pedido atual:\n${reapresentarEtapaAtual(session, usuario)}`,
      lojaId: lojaAtual,
      etapa: session.step,
      convertido: false
    };
  }

  if (acaoDesvio === 'ALTERAR_PEDIDO') {
    session.step = 'DESCOBERTA';
    return handleDiscoveryTurn(session, usuario, text);
  }

  if (acaoDesvio === 'CANCELAR_PEDIDO') {
    const etapaAbandono = `CANCELADO_EM_${session.step}`;
    resetCheckoutState(session);
    const msgCancelado = 'Tudo bem, cancelei o fechamento deste pedido. Se quiser pedir outra coisa, é só me dizer!';
    pushHistory(session, text, msgCancelado);
    return { resposta: msgCancelado, lojaId: lojaAtual, etapa: etapaAbandono, convertido: false };
  }

  const dicasPorEtapa = {
    MODALIDADE_ENTREGA: 'Opção inválida. Responda *1* para Entrega ou *2* para Retirada na loja.',
    ESCOLHA_ENDERECO: `Opção inválida.\n\n${gerarTelaEnderecos(findEnderecosUsuario.all(from))}`,
    NOVO_ENDERECO_TEXTO: 'Informe o endereço completo com rua, número e bairro.',
    NOVO_ENDERECO_ROTULO: 'Informe um nome curto para salvar este endereço (ex.: Casa, Trabalho).',
    CONFIRMACAO_NOTA: 'Não entendi. Confirme se o pedido está certo ou me diga o que deseja alterar.',
    ESCOLHA_PAGAMENTO: `Opção inválida.\n\n${gerarTelaPagamentoInicial()}`,
    VALIDACAO_SMS: 'Por favor, digite o código numérico de 6 dígitos enviado por SMS.',
    METODOS_IFOOD: `Opção inválida.\n\n${gerarTelaMetodosIfood(usuario)}`,
    ESCOLHA_PARCELAS: `Opção inválida. Escolha de *1* a *6*.\n\n${gerarTelaParcelas(usuario, session.total)}`
  };

  return {
    resposta: dicasPorEtapa[session.step] || 'Não entendi sua resposta. Como posso ajudar?',
    lojaId: lojaAtual,
    etapa: session.step,
    convertido: false
  };
}

async function routeUserMessage(from, rawText) {
  const text = String(rawText || '').trim();
  const normalized = text.toLowerCase();
  const usuario = resolveUsuario(from);
  const session = getSession(from);

  if (usuario.perfil === 'LOJISTA') {
    const resposta = await handleLojistaTurn(session, usuario, text);
    return { resposta, perfil: 'LOJISTA', etapa: 'GESTAO_LOJISTA' };
  }

  const resultado = await handleClienteTurn(from, text, normalized, usuario, session);

  registrarInteracao({
    from,
    lojaId: resultado.lojaId,
    etapa: resultado.etapa,
    mensagemUsuario: text,
    respostaSistema: resultado.resposta,
    convertido: resultado.convertido
  });

  return { resposta: resultado.resposta, perfil: 'CLIENTE', etapa: session.step };
}

app.post('/webhook', async (req, res) => {
  try {
    const message = extractMessage(req.body);

    if (!message?.from) {
      res.status(400).json({ ok: false, erro: 'Payload inválido: campo "from" ausente.' });
      return;
    }

    const { resposta, perfil, etapa } = await routeUserMessage(message.from, message.text);

    console.log(`[${message.from} | perfil=${perfil} | etapa=${etapa}] -> ${resposta}`);
    res.status(200).json({ ok: true, perfil, etapa_atual: etapa, resposta });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, erro: 'Erro interno ao processar mensagem.' });
  }
});

app.post('/webhook/pix', (req, res) => {
  try {
    const pedidoId = Number(req.body?.pedido_id || req.body?.pedidoId);
    if (!pedidoId) {
      res.status(400).json({ ok: false, erro: 'Informe o pedido_id.' });
      return;
    }

    const pedido = findPedidoById.get(pedidoId);
    if (!pedido) {
      res.status(404).json({ ok: false, erro: `Pedido #${pedidoId} não encontrado.` });
      return;
    }

    if (pedido.metodo_pagamento !== 'PIX') {
      res.status(400).json({ ok: false, erro: `Pedido #${pedidoId} não foi criado via Pix.` });
      return;
    }

    if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
      res.status(200).json({
        ok: true,
        idempotente: true,
        mensagem: `O pagamento do Pedido #${pedidoId} já havia sido processado (status atual: ${pedido.status}).`
      });
      return;
    }

    updateStatusPedido.run('CONFIRMADO', pedidoId);

    const notificacaoCliente = `Pagamento Pix confirmado! 🎉 Seu Pedido #${pedidoId} na *${pedido.loja_nome}* foi aprovado e já foi enviado para preparo.`;
    console.log(`\n[NOTIFICAÇÃO WHATSAPP -> ${pedido.usuario_whatsapp}]: ${notificacaoCliente}\n`);

    res.status(200).json({
      ok: true,
      pedido_id: pedidoId,
      novo_status: 'CONFIRMADO',
      notificacao_cliente: notificacaoCliente
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, erro: 'Erro ao processar webhook Pix.' });
  }
});

app.post('/webhook/pedido-status', (req, res) => {
  try {
    const pedidoId = Number(req.body?.pedido_id || req.body?.pedidoId);
    const novoStatus = String(req.body?.status || '').toUpperCase().trim();

    const STATUS_PERMITIDOS = [
      'CONFIRMADO',
      'EM_PREPARO',
      'SAIU_PARA_ENTREGA',
      'PRONTO_PARA_RETIRADA',
      'ENTREGUE',
      'CANCELADO'
    ];

    if (!pedidoId || !STATUS_PERMITIDOS.includes(novoStatus)) {
      res.status(400).json({
        ok: false,
        erro: `Informe pedido_id e um status válido: ${STATUS_PERMITIDOS.join(', ')}`
      });
      return;
    }

    const pedido = findPedidoById.get(pedidoId);
    if (!pedido) {
      res.status(404).json({ ok: false, erro: `Pedido #${pedidoId} não encontrado.` });
      return;
    }

    if (['ENTREGUE', 'CANCELADO'].includes(pedido.status)) {
      res.status(400).json({
        ok: false,
        erro: `Pedido #${pedidoId} já está encerrado com status ${pedido.status}.`
      });
      return;
    }

    updateStatusPedido.run(novoStatus, pedidoId);

    if (novoStatus === 'CANCELADO') {
      try {
        const itens = JSON.parse(pedido.itens_json || '[]');
        for (const item of itens) {
          restaurarEstoqueProduto.run(Number(item.quantidade) || 1, item.produto_id);
        }
      } catch {
      }
    }

    const mensagensStatus = {
      CONFIRMADO: `Seu Pedido #${pedidoId} foi confirmado pela loja *${pedido.loja_nome}*!`,
      EM_PREPARO: `A cozinha da *${pedido.loja_nome}* já começou a preparar o seu Pedido #${pedidoId}! 👨‍🍳`,
      SAIU_PARA_ENTREGA: `Seu Pedido #${pedidoId} saiu para entrega! Fique de olho no interfone. 🛵`,
      PRONTO_PARA_RETIRADA: `Seu Pedido #${pedidoId} está pronto para retirada no balcão da *${pedido.loja_nome}*! 🛍️`,
      ENTREGUE: `Pedido #${pedidoId} entregue! Bom apetite! 😋`,
      CANCELADO: `Seu Pedido #${pedidoId} foi cancelado.`
    };

    const notificacaoCliente = mensagensStatus[novoStatus];
    console.log(`\n[NOTIFICAÇÃO WHATSAPP -> ${pedido.usuario_whatsapp}]: ${notificacaoCliente}\n`);

    res.status(200).json({
      ok: true,
      pedido_id: pedidoId,
      status: novoStatus,
      notificacao_cliente: notificacaoCliente
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, erro: 'Erro ao atualizar status do pedido.' });
  }
});

app.get('/interno/lojas/:lojaId/fechamento', checkInternalApiKey, (req, res) => {
  try {
    const lojaId = Number(req.params.lojaId);
    const loja = findLojaById.get(lojaId);
    if (!loja) {
      res.status(404).json({ ok: false, erro: `Loja #${lojaId} não encontrada.` });
      return;
    }

    const dataRef = String(req.query.data || getTodayLocalDate()).slice(0, 10);
    const dados = calcularMetricasLoja(lojaId, dataRef);

    res.status(200).json({
      ok: true,
      loja: { id: loja.id, nome: loja.nome, status_aberto: Boolean(loja.status_aberto) },
      data_referencia: dataRef,
      tem_interacoes: dados.interacoes_anonimizadas.length > 0,
      ...dados
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, erro: 'Erro ao gerar dados de fechamento.' });
  }
});

app.post('/interno/lojas/:lojaId/contexto', checkInternalApiKey, (req, res) => {
  try {
    const lojaId = Number(req.params.lojaId);
    const loja = findLojaById.get(lojaId);
    if (!loja) {
      res.status(404).json({ ok: false, erro: `Loja #${lojaId} não encontrada.` });
      return;
    }

    const dataRef = String(req.body?.data_referencia || getTodayLocalDate()).slice(0, 10);
    const contextoBruto = req.body?.contexto ?? req.body?.contexto_json ?? {};
    const alertasBrutos = req.body?.alertas ?? req.body?.alertas_json ?? [];
    const relatorioTexto = String(req.body?.relatorio_texto || '').trim();

    const contextoJson = typeof contextoBruto === 'string' ? contextoBruto : JSON.stringify(contextoBruto);
    const alertasJson = typeof alertasBrutos === 'string' ? alertasBrutos : JSON.stringify(alertasBrutos);

    const inserido = insertContextoDiario.run(
      lojaId,
      dataRef,
      contextoJson,
      relatorioTexto,
      alertasJson
    );

    console.log(`\n[CONTEXTO DIÁRIO RECEBIDO DO n8n -> ${loja.nome} (${dataRef})]\n${relatorioTexto}\n`);

    res.status(201).json({
      ok: true,
      contexto_id: Number(inserido.lastInsertRowid),
      loja_id: lojaId,
      data_referencia: dataRef
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, erro: 'Erro ao salvar contexto diário.' });
  }
});

app.get('/interno/lojas/:lojaId/contextos', checkInternalApiKey, (req, res) => {
  const lojaId = Number(req.params.lojaId);
  const limite = Math.min(30, Math.max(1, Number(req.query.limite) || 7));
  const contextos = findContextosRecentesLoja.all(lojaId, limite);
  res.status(200).json({ ok: true, contextos });
});

app.get('/interno/lojas/:lojaId/estoque', checkInternalApiKey, (req, res) => {
  const lojaId = Number(req.params.lojaId);
  const produtos = findTodosProdutosLoja.all(lojaId);
  res.status(200).json({ ok: true, produtos });
});

app.post('/interno/alertas/notificar', checkInternalApiKey, (req, res) => {
  const canal = String(req.body?.canal || 'LOJISTA_WHATSAPP');
  const titulo = String(req.body?.titulo || 'Alerta Operacional');
  const mensagem = String(req.body?.mensagem || '');
  console.log(`\n[ALERTA PROATIVO n8n -> ${canal}] ${titulo}\n${mensagem}\n`);
  res.status(200).json({ ok: true, recebido_em: new Date().toISOString() });
});

app.get('/pedidos/:whatsapp', (req, res) => {
  const pedidos = findTodosPedidosUsuario.all(String(req.params.whatsapp));
  res.status(200).json({ ok: true, pedidos });
});

app.get('/enderecos/:whatsapp', (req, res) => {
  const enderecos = findEnderecosUsuario.all(String(req.params.whatsapp));
  res.status(200).json({ ok: true, enderecos });
});

app.listen(port, () => {
  console.log(`Servidor WhatFood rodando em http://localhost:${port}`);
});