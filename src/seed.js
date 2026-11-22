const db = require('./db');

function seed() {
  try {
    db.exec('BEGIN');

    db.exec(`
      DROP TABLE IF EXISTS contextos_diarios;
      DROP TABLE IF EXISTS interacoes;
      DROP TABLE IF EXISTS pedidos;
      DROP TABLE IF EXISTS enderecos;
      DROP TABLE IF EXISTS produtos;
      DROP TABLE IF EXISTS usuarios;
      DROP TABLE IF EXISTS lojas;

      CREATE TABLE lojas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        status_aberto INTEGER NOT NULL,
        taxa_entrega REAL NOT NULL DEFAULT 0,
        bairros_atendimento TEXT NOT NULL
      );

      CREATE TABLE usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whatsapp_numero TEXT NOT NULL UNIQUE,
        nome TEXT NOT NULL,
        perfil TEXT NOT NULL DEFAULT 'CLIENTE',
        loja_id INTEGER,
        bairro_padrao TEXT NOT NULL,
        metodo_pagamento_salvo TEXT NOT NULL,
        saldo_carteira REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (loja_id) REFERENCES lojas(id)
      );

      CREATE TABLE enderecos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_whatsapp TEXT NOT NULL,
        rotulo TEXT NOT NULL,
        logradouro_numero TEXT NOT NULL,
        bairro TEXT NOT NULL
      );

      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        loja_id INTEGER NOT NULL,
        nome TEXT NOT NULL,
        preco REAL NOT NULL,
        descricao TEXT,
        disponivel INTEGER NOT NULL DEFAULT 1,
        quantidade_estoque INTEGER NOT NULL DEFAULT 10,
        estoque_minimo INTEGER NOT NULL DEFAULT 3,
        FOREIGN KEY (loja_id) REFERENCES lojas(id)
      );

      CREATE TABLE pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_whatsapp TEXT NOT NULL,
        loja_id INTEGER NOT NULL,
        itens_json TEXT NOT NULL,
        modalidade TEXT NOT NULL,
        endereco_entrega TEXT,
        subtotal REAL NOT NULL,
        taxa_entrega REAL NOT NULL,
        taxa_servico REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL,
        metodo_pagamento TEXT NOT NULL,
        parcelas TEXT,
        status TEXT NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (loja_id) REFERENCES lojas(id)
      );

      CREATE TABLE interacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whatsapp_hash TEXT NOT NULL,
        loja_id INTEGER,
        etapa TEXT NOT NULL,
        mensagem_usuario TEXT NOT NULL,
        resposta_sistema TEXT NOT NULL,
        convertido INTEGER NOT NULL DEFAULT 0,
        criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (loja_id) REFERENCES lojas(id)
      );

      CREATE TABLE contextos_diarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        loja_id INTEGER NOT NULL,
        data_referencia TEXT NOT NULL,
        contexto_json TEXT NOT NULL,
        relatorio_texto TEXT NOT NULL,
        alertas_json TEXT NOT NULL,
        criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (loja_id) REFERENCES lojas(id)
      );
    `);

    const insertLoja = db.prepare(`
      INSERT INTO lojas (nome, status_aberto, taxa_entrega, bairros_atendimento)
      VALUES (?, ?, ?, ?)
    `);

    const insertUsuario = db.prepare(`
      INSERT INTO usuarios (whatsapp_numero, nome, perfil, loja_id, bairro_padrao, metodo_pagamento_salvo, saldo_carteira)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEndereco = db.prepare(`
      INSERT INTO enderecos (usuario_whatsapp, rotulo, logradouro_numero, bairro)
      VALUES (?, ?, ?, ?)
    `);

    const insertProduto = db.prepare(`
      INSERT INTO produtos (loja_id, nome, preco, descricao, disponivel, quantidade_estoque, estoque_minimo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const doceVila = insertLoja.run(
      'Doce da Vila',
      1,
      6.0,
      JSON.stringify(['Pinheiros', 'Vila Madalena'])
    );
    const doceVilaId = Number(doceVila.lastInsertRowid);
    insertProduto.run(doceVilaId, 'Brownie', 18.9, 'Brownie de chocolate meio amargo', 1, 4, 3);
    insertProduto.run(doceVilaId, 'Brigadeiro', 6.5, 'Brigadeiro tradicional gourmet', 1, 15, 5);
    insertProduto.run(doceVilaId, 'Cheesecake', 24.0, 'Cheesecake de frutas vermelhas', 1, 6, 2);
    insertProduto.run(doceVilaId, 'Torta de Limão', 19.5, 'Fatia de torta de limão siciliano', 0, 0, 2);

    const amorCacau = insertLoja.run(
      'Confeitaria Amor & Cacau',
      1,
      7.5,
      JSON.stringify(['Pinheiros'])
    );
    const amorCacauId = Number(amorCacau.lastInsertRowid);
    insertProduto.run(amorCacauId, 'Bolo de Cenoura', 16.0, 'Fatia generosa com cobertura de brigadeiro', 1, 10, 3);
    insertProduto.run(amorCacauId, 'Cookie Recheado', 14.5, 'Cookie de baunilha com gotas e recheio de Nutella', 1, 12, 3);
    insertProduto.run(amorCacauId, 'Palha Italiana', 9.0, 'Palha italiana tradicional de chocolate', 1, 18, 4);
    insertProduto.run(amorCacauId, 'Banoffee', 21.0, 'Torta de banana, doce de leite e chantilly', 1, 8, 2);

    const burgerEsquina = insertLoja.run(
      'Burger da Esquina',
      1,
      8.5,
      JSON.stringify(['Pinheiros'])
    );
    const burgerEsquinaId = Number(burgerEsquina.lastInsertRowid);
    insertProduto.run(burgerEsquinaId, 'Smash burger', 32.0, 'Pão brioche, dois smash burgers e queijo cheddar', 1, 14, 4);
    insertProduto.run(burgerEsquinaId, 'Batata Frita', 14.0, 'Porção individual de batata frita crocante', 1, 20, 5);
    insertProduto.run(burgerEsquinaId, 'Milkshake de Baunilha', 18.0, 'Milkshake cremoso 400ml', 1, 10, 3);
    insertProduto.run(burgerEsquinaId, 'Refrigerante Lata', 7.0, 'Coca-Cola ou Guaraná 350ml', 1, 24, 6);

    const brasaPao = insertLoja.run(
      'Brasa & Pão Artesanal',
      1,
      9.0,
      JSON.stringify(['Pinheiros', 'Vila Madalena'])
    );
    const brasaPaoId = Number(brasaPao.lastInsertRowid);
    insertProduto.run(brasaPaoId, 'Burger Costela', 38.0, 'Hambúrguer 180g de costela, queijo prato e maionese da casa', 1, 12, 3);
    insertProduto.run(brasaPaoId, 'Onion Rings', 19.0, 'Anéis de cebola empanados com molho barbecue', 1, 15, 4);
    insertProduto.run(brasaPaoId, 'Combo Duplo', 54.0, 'Burger Costela + Batata Rústica + Refrigerante', 1, 8, 2);

    const bellaNapoli = insertLoja.run(
      'Cantina Bella Napoli',
      1,
      10.0,
      JSON.stringify(['Pinheiros', 'Vila Madalena'])
    );
    const bellaNapoliId = Number(bellaNapoli.lastInsertRowid);
    insertProduto.run(bellaNapoliId, 'Pizza Margherita Grande', 58.0, 'Molho de tomate pelati, mussarela e manjericão fresco', 1, 10, 3);
    insertProduto.run(bellaNapoliId, 'Pizza Calabresa Grande', 62.0, 'Calabresa artesanal fatiada, cebola roxa e azeitonas', 1, 10, 3);
    insertProduto.run(bellaNapoliId, 'Lasanha à Bolonhesa', 42.0, 'Porção individual gratinada com parmesão', 1, 7, 2);
    insertProduto.run(bellaNapoliId, 'Suco de Uva Integral', 12.0, 'Garrafa 300ml sem adição de açúcar', 1, 16, 4);

    const temakiCia = insertLoja.run(
      'Temaki & Cia',
      1,
      11.0,
      JSON.stringify(['Pinheiros'])
    );
    const temakiCiaId = Number(temakiCia.lastInsertRowid);
    insertProduto.run(temakiCiaId, 'Temaki Salmão Completo', 29.9, 'Salmão fresco batido com cream cheese e cebolinha', 1, 12, 3);
    insertProduto.run(temakiCiaId, 'Combinado 20 Peças', 68.0, 'Sashimis, niguiris e uramakis variados de salmão', 1, 8, 2);
    insertProduto.run(temakiCiaId, 'Hot Roll 10 Unidades', 26.0, 'Roll empanado crocante com tarê', 1, 14, 3);
    insertProduto.run(temakiCiaId, 'Sunomono', 13.0, 'Salada agridoce de pepino japonês com gergelim', 1, 10, 3);

    const temperoCasa = insertLoja.run(
      'Tempero de Casa',
      1,
      5.5,
      JSON.stringify(['Pinheiros', 'Vila Madalena'])
    );
    const temperoCasaId = Number(temperoCasa.lastInsertRowid);
    insertProduto.run(temperoCasaId, 'Executivo Parmegiana', 34.0, 'Filé de frango à parmegiana, arroz branco e fritas', 1, 12, 3);
    insertProduto.run(temperoCasaId, 'Prato Feito Picanha', 44.0, 'Picanha grelhada, arroz, feijão carioca, farofa e vinagrete', 1, 9, 3);
    insertProduto.run(temperoCasaId, 'Strogonoff de Carne', 32.0, 'Acompanha arroz branco e batata palha artesanal', 1, 11, 3);
    insertProduto.run(temperoCasaId, 'Suco de Laranja Natural', 10.0, 'Copo 400ml espremido na hora', 1, 18, 4);

    const acaiParque = insertLoja.run(
      'Açaí do Parque',
      1,
      4.5,
      JSON.stringify(['Pinheiros', 'Vila Madalena'])
    );
    const acaiParqueId = Number(acaiParque.lastInsertRowid);
    insertProduto.run(acaiParqueId, 'Açaí 500ml Tradicional', 22.0, 'Acompanha banana, granola e leite em pó', 1, 16, 4);
    insertProduto.run(acaiParqueId, 'Açaí 300ml Zero Açúcar', 18.0, 'Açaí puro batido com morango', 1, 12, 3);
    insertProduto.run(acaiParqueId, 'Vitamina de Abacate', 15.0, 'Copo 500ml cremoso', 1, 10, 3);

    const padariaFechada = insertLoja.run(
      'Padaria Paulista Noturna',
      0,
      5.0,
      JSON.stringify(['Pinheiros'])
    );
    insertProduto.run(Number(padariaFechada.lastInsertRowid), 'Pão na Chapa', 8.0, 'Pão francês com manteiga aviação', 1, 20, 5);

    const sushiOutroBairro = insertLoja.run(
      'Sushi Jardins',
      1,
      12.0,
      JSON.stringify(['Itaim Bibi'])
    );
    insertProduto.run(Number(sushiOutroBairro.lastInsertRowid), 'Combinado Premium', 95.0, 'Seleção do chef 30 peças', 1, 8, 2);

    insertUsuario.run(
      '5511999990001',
      'Gabriel',
      'CLIENTE',
      null,
      'Pinheiros',
      'Mastercard •••• 4821',
      35.0
    );

    insertUsuario.run(
      '5511999990002',
      'Marina',
      'LOJISTA',
      doceVilaId,
      'Pinheiros',
      'N/A',
      0
    );

    insertEndereco.run(
      '5511999990001',
      'Casa',
      'Rua dos Pinheiros, 840 - Apto 42',
      'Pinheiros'
    );

    insertEndereco.run(
      '5511999990001',
      'Trabalho',
      'Av. Pedroso de Morais, 1200',
      'Vila Madalena'
    );

    db.exec('COMMIT');
    console.log('Seed concluído: 10 lojas, 32 produtos, 1 cliente e 1 lojista cadastrados.');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error(rollbackError);
    }
    console.error(error);
    process.exitCode = 1;
  }
}

seed();