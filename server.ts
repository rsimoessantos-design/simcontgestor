import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { db } from './server/db.ts';
import { apurarSimplesNacionalPeriodo } from './src/utils/simplesNacionalCalculator.ts';
import {
  calcularResumoFaturamentoMei,
  gerarGradeGuiasAnoMei,
  calcularDasnSimei,
} from './src/utils/meiCalculator.ts';
import {
  SERVICOS_CONTABEIS_PADRAO,
  CONTRATOS_HONORARIOS_PADRAO,
  MENSALIDADES_HONORARIOS_PADRAO,
  RECIBOS_HONORARIOS_PADRAO,
  valorPorExtenso,
} from './src/data/demoCobrancas.ts';
import {
  BENS_PATRIMONIAIS_DEMO,
  CENTROS_CUSTO_DEMO,
  PLANO_CONTAS_DEMO,
  TABELA_PARAMETROS_ATIVO,
  calcularDepreciacaoBem,
  gerarBalancoPatrimonial,
  gerarDre,
  gerarDfc,
  calcularIndicadoresContabeis,
} from './src/data/demoPatrimonioContabil.ts';

// In-Memory Cobranças Store
let servicosContabeisDb = [...SERVICOS_CONTABEIS_PADRAO];
let contratosHonorariosDb = [...CONTRATOS_HONORARIOS_PADRAO];
let mensalidadesHonorariosDb = [...MENSALIDADES_HONORARIOS_PADRAO];
let recibosHonorariosDb = [...RECIBOS_HONORARIOS_PADRAO];

// In-Memory Patrimônio & Contabilidade Store
let bensPatrimoniaisDb = [...BENS_PATRIMONIAIS_DEMO];
let centrosCustoDb = [...CENTROS_CUSTO_DEMO];
let planoContasDb = [...PLANO_CONTAS_DEMO];

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
  const LOGIN_WINDOW_MS = 60 * 1000;
  const LOGIN_MAX_ATTEMPTS = 10;
  const issueSession = (userId: string) => {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  };
  const getSessionUser = (req: express.Request) => {
    const header = req.header('authorization') || '';
    if (!header.startsWith('Bearer ')) return undefined;
    const token = header.slice(7).trim();
    const session = sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) { sessions.delete(token); return undefined; }
    const user = db.findUserByEmail(db.getUsers().find(u => u.id === session.userId)?.email || '');
    return user;
  };
  const requireAuth: express.RequestHandler = (req, res, next) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    (req as any).authUser = user;
    next();
  };


  // --- API Endpoints ---
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'ContabGest SaaS Core API',
      version: '2.1.0',
      environment: 'production',
      readyForDeploy: false,
      note: 'Ambiente base com dados de demonstração. Configure credenciais e banco antes de produção.',
      timestamp: new Date().toISOString(),
      isDemoDatabase: true,
    });
  });

  // Auth: Login
  app.post('/api/auth/login', (req, res) => {
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(clientKey);
    if (!attempt || attempt.resetAt <= now) {
      loginAttempts.set(clientKey, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
      attempt.count += 1;
      if (attempt.count > LOGIN_MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde um minuto e tente novamente.' });
      }
    }

    const { email, password } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email é obrigatório.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = db.findUserByEmail(normalizedEmail);
    if (!user || !db.verifyPassword(user, String(password || ''))) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique e-mail e senha.' });
    }
    db.ensurePasswordHash(user);
    loginAttempts.delete(clientKey);
    const token = issueSession(user.id);
    const { passwordHash, ...safeUser } = user;
    res.json({ success: true, token, user: safeUser, expiresIn: SESSION_TTL_MS, message: 'Autenticação realizada com sucesso no ContabGest.' });
  });

  // Current User
  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = (req as any).authUser;
    const { passwordHash, ...safeUser } = user;
    res.json({ user: safeUser });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    const header = req.header('authorization') || '';
    const token = header.slice(7).trim();
    sessions.delete(token);
    res.json({ success: true });
  });

  app.use('/api', requireAuth);

  // Dashboard Aggregated Metrics (with multi-empresa filter support)
  app.get('/api/dashboard', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const metrics = db.getDashboardMetrics(empresaId);
    res.json(metrics);
  });

  // Empresas (Multi-tenant companies list)
  app.get('/api/empresas', (req, res) => {
    const empresas = db.getEmpresas();
    res.json(empresas);
  });

  app.get('/api/empresas/:id', (req, res) => {
    const empresa = db.getEmpresaById(req.params.id);
    if (!empresa) {
      return res.status(404).json({ error: 'Empresa não encontrada' });
    }
    res.json(empresa);
  });

  app.post('/api/empresas', (req, res) => {
    try {
      const nova = db.createEmpresa(req.body);
      res.status(201).json(nova);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao cadastrar empresa' });
    }
  });

  // Clientes
  app.get('/api/clientes', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const clientes = db.getClientes(empresaId);
    res.json(clientes);
  });

  // Sócios
  app.get('/api/socios', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const socios = db.getSocios(empresaId);
    res.json(socios);
  });

  // Obrigações
  app.get('/api/obrigacoes', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const obrigacoes = db.getObrigacoes(empresaId);
    res.json(obrigacoes);
  });

  app.patch('/api/obrigacoes/:id/status', (req, res) => {
    const { status } = req.body;
    const updated = db.updateObrigacaoStatus(req.params.id, status);
    if (!updated) {
      return res.status(404).json({ error: 'Obrigação não encontrada' });
    }
    res.json(updated);
  });

  // Documentos
  app.get('/api/documentos', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const docs = db.getDocumentos(empresaId);
    res.json(docs);
  });

  app.post('/api/documentos', (req, res) => {
    const doc = db.addDocumento(req.body);
    res.status(201).json(doc);
  });

  // Certidões Negativas
  app.get('/api/certidoes', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const certs = db.getCertidoes(empresaId);
    res.json(certs);
  });

  // Tarefas
  app.get('/api/tarefas', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const tarefas = db.getTarefas(empresaId);
    res.json(tarefas);
  });

  app.patch('/api/tarefas/:id/status', (req, res) => {
    const { status } = req.body;
    const updated = db.updateTarefaStatus(req.params.id, status);
    if (!updated) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }
    res.json(updated);
  });

  // Financeiro
  app.get('/api/financeiro/contas-pagar', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const cp = db.getContasPagar(empresaId);
    res.json(cp);
  });

  app.get('/api/financeiro/contas-receber', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const cr = db.getContasReceber(empresaId);
    res.json(cr);
  });

  app.get('/api/financeiro/categorias', (req, res) => {
    const cats = db.getCategoriasFinanceiras();
    res.json(cats);
  });

  // =========================================================================
  // --- NOTAS FISCAIS ELETRÔNICAS (NF-e, NFS-e, NFC-e) ---
  // =========================================================================
  app.get('/api/notas-fiscais', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const notas = db.getNotasFiscais(empresaId);
    res.json(notas);
  });

  app.post('/api/notas-fiscais', (req, res) => {
    try {
      const nota = db.createNotaFiscal(req.body);
      res.status(201).json(nota);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao emitir nota fiscal' });
    }
  });

  app.post('/api/notas-fiscais/:id/cancelar', (req, res) => {
    try {
      const { motivo } = req.body;
      if (!motivo || motivo.trim().length < 15) {
        return res.status(400).json({ error: 'A justificativa de cancelamento deve ter no mínimo 15 caracteres (Regra SEFAZ).' });
      }
      const nota = db.cancelarNotaFiscal(req.params.id, motivo);
      res.json(nota);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao cancelar nota fiscal' });
    }
  });

  app.post('/api/notas-fiscais/importar-xml-saida', (req, res) => {
    try {
      const { empresaId, xmlContent } = req.body;
      if (!empresaId || !xmlContent) {
        return res.status(400).json({ error: 'Empresa emitente e conteúdo XML de saída modelo 55 são obrigatórios.' });
      }
      const nota = db.importarXmlSaida(empresaId, xmlContent);
      res.status(201).json(nota);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao processar e importar XML de saída modelo 55.' });
    }
  });

  app.post('/api/notas-fiscais/importar-lote-xml-saida', (req, res) => {
    try {
      const { empresaId, xmlContents } = req.body;
      if (!empresaId || !Array.isArray(xmlContents) || xmlContents.length === 0) {
        return res.status(400).json({ error: 'Empresa e lista de arquivos XML são obrigatórios.' });
      }
      const resultado = db.importarLoteXmlSaida(empresaId, xmlContents);
      res.status(201).json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao importar lote de XMLs de saída.' });
    }
  });

  // =========================================================================
  // --- SEFAZ DF-e: CAPTURA & GESTÃO DE NOTAS EMITIDAS CONTRA O CNPJ (FSIST / QUIVE STYLE) ---
  // =========================================================================
  app.get('/api/notas-fiscais-entrada', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const notas = db.getNotasFiscaisEntrada(empresaId);
    res.json(notas);
  });

  app.get('/api/notas-fiscais-entrada/:id', (req, res) => {
    const nota = db.getNotaEntradaById(req.params.id);
    if (!nota) {
      return res.status(404).json({ error: 'Nota fiscal de entrada não encontrada' });
    }
    res.json(nota);
  });

  app.post('/api/notas-fiscais-entrada/capturar-chave', (req, res) => {
    try {
      const { empresaId, chaveAcesso, efetuarCiencia } = req.body;
      if (!empresaId || !chaveAcesso) {
        return res.status(400).json({ error: 'Empresa destinatária e chave de acesso de 44 dígitos são obrigatórios.' });
      }
      const nota = db.capturarNotaPorChave(empresaId, chaveAcesso, efetuarCiencia ?? true);
      res.status(201).json(nota);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao capturar nota fiscal no Web Service SEFAZ' });
    }
  });

  app.post('/api/notas-fiscais-entrada/sincronizar-sefaz', (req, res) => {
    try {
      const { empresaId } = req.body;
      if (!empresaId) {
        return res.status(400).json({ error: 'Empresa destinatária é obrigatória para consulta ao Web Service DF-e SEFAZ.' });
      }
      const resultado = db.sincronizarEntradasSefaz(empresaId);
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao sincronizar lote DF-e com a SEFAZ' });
    }
  });

  app.post('/api/notas-fiscais-entrada/importar-xml', (req, res) => {
    try {
      const { empresaId, xmlContent } = req.body;
      if (!empresaId || !xmlContent) {
        return res.status(400).json({ error: 'Empresa destinatária e conteúdo do arquivo XML são obrigatórios.' });
      }
      const nota = db.importarXmlEntrada(empresaId, xmlContent);
      res.status(201).json(nota);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao processar e importar XML da NF-e' });
    }
  });

  app.post('/api/notas-fiscais-entrada/:id/manifestar', (req, res) => {
    try {
      const { manifestacao, justificativa } = req.body;
      if (!manifestacao) {
        return res.status(400).json({ error: 'Tipo de manifestação do destinatário é obrigatório.' });
      }
      if (manifestacao === 'nao_realizada' && (!justificativa || justificativa.trim().length < 15)) {
        return res.status(400).json({ error: 'A justificativa de operação não realizada deve ter no mínimo 15 caracteres (Exigência SEFAZ).' });
      }
      const nota = db.manifestarNotaEntrada(req.params.id, manifestacao, justificativa);
      res.json(nota);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao registrar evento de manifestação na SEFAZ' });
    }
  });

  app.put('/api/notas-fiscais-entrada/:id/status-escrituracao', (req, res) => {
    try {
      const { statusEscrituracao } = req.body;
      if (!statusEscrituracao) {
        return res.status(400).json({ error: 'Status de escrituração é obrigatório.' });
      }
      const nota = db.updateStatusEscrituracaoEntrada(req.params.id, statusEscrituracao);
      res.json(nota);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao atualizar escrituração contábil' });
    }
  });

  app.get('/api/sefaz/sincronizacoes', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const logs = db.getSincronizacoesSefaz(empresaId);
    res.json(logs);
  });

  // =========================================================================
  // --- SIMPLES NACIONAL & APURAÇÃO AUTOMÁTICA PGDAS-D ---
  // =========================================================================
  app.get('/api/simples-nacional/apuracoes', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const competencia = req.query.competencia as string | undefined;
    const apuracoes = db.getApuracoesSimples(empresaId, competencia);
    res.json(apuracoes);
  });

  app.get('/api/simples-nacional/apuracoes/:id', (req, res) => {
    const apuracao = db.getApuracaoSimplesById(req.params.id);
    if (!apuracao) {
      return res.status(404).json({ error: 'Apuração do Simples Nacional não encontrada.' });
    }
    res.json(apuracao);
  });

  app.post('/api/simples-nacional/calcular', (req, res) => {
    try {
      const { empresaId, competencia, rbt12Custom, folha12Custom } = req.body;
      if (!empresaId || !competencia) {
        return res.status(400).json({ error: 'Empresa e competência (formato MM/AAAA) são obrigatórios.' });
      }

      const empresa = db.getEmpresas().find((e) => e.id === empresaId);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa selecionada não foi encontrada.' });
      }

      // Busca todas as notas fiscais de saída e cupons fiscais da empresa
      const todasNotas = db.getNotasFiscais(empresaId);

      const rbt12 = rbt12Custom !== undefined && !isNaN(Number(rbt12Custom))
        ? Number(rbt12Custom)
        : (empresa.rbt12 || 1250000);
      const folha12Meses = folha12Custom !== undefined && !isNaN(Number(folha12Custom))
        ? Number(folha12Custom)
        : (empresa.folhaPagamento12Meses || 340000);

      // Executa motor de apuração oficial do Simples Nacional
      const apuracao = apurarSimplesNacionalPeriodo({
        empresaId,
        competencia,
        notasFiscais: todasNotas,
        rbt12,
        folha12Meses,
      });

      res.json(apuracao);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao calcular apuração do Simples Nacional' });
    }
  });

  app.post('/api/simples-nacional/salvar', (req, res) => {
    try {
      const apuracao = req.body;
      if (!apuracao || !apuracao.empresaId || !apuracao.competencia) {
        return res.status(400).json({ error: 'Dados da apuração incompletos para salvar.' });
      }
      const salva = db.salvarApuracaoSimples(apuracao);
      res.status(201).json(salva);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao salvar apuração do Simples Nacional' });
    }
  });

  app.post('/api/simples-nacional/transmitir/:id', (req, res) => {
    try {
      const { usuarioNome } = req.body;
      const resultado = db.transmitirApuracaoSimples(req.params.id, usuarioNome);
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao transmitir declaração PGDAS-D' });
    }
  });

  app.delete('/api/simples-nacional/apuracoes/:id', (req, res) => {
    try {
      db.excluirApuracaoSimples(req.params.id);
      res.json({ success: true, message: 'Apuração removida com sucesso.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao excluir apuração' });
    }
  });

  // =========================================================================
  // --- MÓDULO MEI: FECHAMENTO, FATURAMENTO, LIMITES, PGMEI E DECLARAÇÃO ANUAL (DASN-SIMEI) ---
  // =========================================================================

  // Lista empresas cadastradas com regime MEI
  app.get('/api/mei/empresas', (req, res) => {
    const empresas = db.getEmpresas().filter((e) => e.regimeTributario === 'MEI');
    res.json(empresas);
  });

  // Resumo anual de faturamento, limites e despesas/compras do MEI
  app.get('/api/mei/resumo/:empresaId/:ano', (req, res) => {
    try {
      const { empresaId, ano } = req.params;
      const anoNum = parseInt(ano, 10) || new Date().getFullYear();

      const empresa = db.getEmpresaById(empresaId);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const todasNotasEmitidas = db.getNotasFiscais(empresaId);
      const notasEntrada = db.getNotasFiscaisEntrada(empresaId);
      const comprasEntradaValorTotal = notasEntrada.reduce((acc, n) => {
        const anoNota = new Date(n.dataEmissao).getFullYear();
        return anoNota === anoNum ? acc + (n.valorTotal || n.valorProdutos || 0) : acc;
      }, 0);

      const resumo = calcularResumoFaturamentoMei({
        empresa,
        ano: anoNum,
        notasFiscais: todasNotasEmitidas,
        comprasEntradaValorTotal,
      });
      res.json(resumo);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao calcular resumo do MEI' });
    }
  });

  // Lista geral de guias DAS-MEI (com suporte a filtros por empresaId e ano)
  app.get('/api/mei/guias', (req, res) => {
    try {
      const empresaId = req.query.empresaId as string | undefined;
      const ano = req.query.ano ? parseInt(req.query.ano as string, 10) : undefined;
      const guias = db.getGuiasMei(empresaId, ano);
      res.json(guias);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao carregar guias DAS-MEI' });
    }
  });

  // Grade de guias DAS-MEI de uma empresa para determinado ano (PGMEI)
  app.get('/api/mei/guias/:empresaId/:ano', (req, res) => {
    try {
      const { empresaId, ano } = req.params;
      const anoNum = parseInt(ano, 10) || new Date().getFullYear();

      const empresa = db.getEmpresaById(empresaId);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      let guias = db.getGuiasMei(empresaId, anoNum);

      // Se não houver guias registradas para este ano, gera a grade padrão automaticamente
      if (!guias || guias.length === 0) {
        const gradeGerada = gerarGradeGuiasAnoMei(empresa, anoNum);
        for (const guia of gradeGerada) {
          db.salvarGuiaMei(guia);
        }
        guias = db.getGuiasMei(empresaId, anoNum);
      }

      res.json(guias);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao carregar guias DAS-MEI' });
    }
  });

  // Força a recriação ou complementação da grade de guias do ano
  app.post('/api/mei/guias/gerar-ano', (req, res) => {
    try {
      const { empresaId, ano } = req.body;
      const anoNum = parseInt(ano, 10) || new Date().getFullYear();

      const empresa = db.getEmpresaById(empresaId);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const grade = gerarGradeGuiasAnoMei(empresa, anoNum);
      for (const g of grade) {
        db.salvarGuiaMei(g);
      }
      const guiasAtualizadas = db.getGuiasMei(empresaId, anoNum);
      res.json({ success: true, guias: guiasAtualizadas });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao gerar guias do ano' });
    }
  });

  // Atualiza status de pagamento da guia (marcar paga / desmarcar)
  app.patch('/api/mei/guias/:guiaId/status', (req, res) => {
    try {
      const { guiaId } = req.params;
      const { pago, dataPagamento } = req.body;

      let guiaAtualizada;
      if (pago) {
        guiaAtualizada = db.marcarGuiaMeiPaga(guiaId, dataPagamento);
      } else {
        guiaAtualizada = db.desmarcarGuiaMeiPaga(guiaId);
      }

      res.json(guiaAtualizada);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao alterar status da guia DAS-MEI' });
    }
  });

  // Lista declarações anuais (DASN-SIMEI)
  app.get('/api/mei/declaracoes', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const declaracoes = db.getDeclaracoesMei(empresaId);
    res.json(declaracoes);
  });

  // Busca declaração anual por ID
  app.get('/api/mei/declaracoes/:id', (req, res) => {
    const declaracao = db.getDeclaracaoMeiById(req.params.id);
    if (!declaracao) {
      return res.status(404).json({ error: 'Declaração DASN-SIMEI não encontrada.' });
    }
    res.json(declaracao);
  });

  // Prepara e simula a Declaração Anual (DASN-SIMEI) com base nas notas emitidas
  app.post('/api/mei/declaracoes/preparar', (req, res) => {
    try {
      const { empresaId, anoCalendario, possuiuEmpregado, tipoDeclaracao } = req.body;
      const anoNum = parseInt(anoCalendario, 10) || new Date().getFullYear() - 1;

      const empresa = db.getEmpresaById(empresaId);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const notasFiscais = db.getNotasFiscais(empresaId);
      const declaracaoCalculada = calcularDasnSimei(
        empresa,
        anoNum,
        notasFiscais,
        Boolean(possuiuEmpregado),
        tipoDeclaracao || 'original'
      );

      res.json(declaracaoCalculada);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao preparar DASN-SIMEI' });
    }
  });

  // Salva rascunho de Declaração Anual (DASN-SIMEI)
  app.post('/api/mei/declaracoes/salvar', (req, res) => {
    try {
      const declaracao = req.body;
      if (!declaracao || !declaracao.empresaId || !declaracao.anoCalendario) {
        return res.status(400).json({ error: 'Dados da declaração incompletos.' });
      }

      const salva = db.salvarDeclaracaoMei(declaracao);
      res.json(salva);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao salvar DASN-SIMEI' });
    }
  });

  // Transmite Declaração Anual (DASN-SIMEI) gerando recibo, protocolo e autenticação
  app.post('/api/mei/declaracoes/transmitir/:id', (req, res) => {
    try {
      const { usuarioNome } = req.body;
      const resultado = db.transmitirDeclaracaoMei(req.params.id, usuarioNome);
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao transmitir declaração DASN-SIMEI' });
    }
  });

  // Exclui declaração anual
  app.delete('/api/mei/declaracoes/:id', (req, res) => {
    try {
      const ok = db.excluirDeclaracaoMei(req.params.id);
      res.json({ success: ok });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao excluir declaração' });
    }
  });

  // =========================================================================
  // --- CERTIFICADOS DIGITAIS A1 / A3 ---
  // =========================================================================
  app.get('/api/certificados', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const certs = db.getCertificados(empresaId);
    res.json(certs);
  });

  app.post('/api/certificados', (req, res) => {
    try {
      const cert = db.createCertificado(req.body);
      res.status(201).json(cert);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao cadastrar certificado digital' });
    }
  });

  app.post('/api/certificados/:id/instalar', (req, res) => {
    try {
      const { senhaSalva } = req.body;
      const cert = db.instalarCertificado(req.params.id, senhaSalva ?? true);
      res.json(cert);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao instalar certificado digital' });
    }
  });

  // =========================================================================
  // --- RECEITA FEDERAL & PENDÊNCIAS DO E-CAC ---
  // =========================================================================
  app.get('/api/ecac/pendencias', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const pendencias = db.getPendenciasEcac(empresaId);
    res.json(pendencias);
  });

  app.post('/api/ecac/pendencias/:id/resolver', (req, res) => {
    try {
      const { protocolo } = req.body;
      const pendencia = db.resolverPendenciaEcac(req.params.id, protocolo || `REC-RFB-${Date.now()}`);
      res.json(pendencia);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao regularizar pendência no e-CAC' });
    }
  });

  app.post('/api/ecac/sincronizar', (req, res) => {
    const empresaId = req.body?.empresaId as string | undefined;
    const result = db.sincronizarReceitaFederal(empresaId);
    res.json(result);
  });

  // =========================================================================
  // --- DASHBOARD DE CONFORMIDADE FISCAL CONSOLIDADA (ESCRITÓRIO) ---
  // =========================================================================
  app.get('/api/conformidade-fiscal/consolidado', (req, res) => {
    try {
      const ano = req.query.ano ? parseInt(req.query.ano as string, 10) : new Date().getFullYear();
      const empresas = db.getEmpresas();
      const apuracoes = db.getApuracoesSimples();
      const guiasMei = db.getGuiasMei();
      const declaracoesMei = db.getDeclaracoesMei();
      const pendenciasEcac = db.getPendenciasEcac();
      const obrigacoes = db.getObrigacoes();

      res.json({
        ano,
        empresas,
        apuracoes,
        guiasMei,
        declaracoesMei,
        pendenciasEcac,
        obrigacoes,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao consolidar conformidade fiscal' });
    }
  });

  // =========================================================================
  // --- ALVARÁS E LICENÇAS (SANITÁRIO, BOMBEIROS/AVCB, FUNCIONAMENTO, AMBIENTAL) ---
  // =========================================================================
  app.get('/api/alvaras', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const alvaras = db.getAlvaras(empresaId);
    res.json(alvaras);
  });

  app.post('/api/alvaras', (req, res) => {
    try {
      const alvara = db.createAlvara(req.body);
      res.status(201).json(alvara);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao cadastrar alvará/licença' });
    }
  });

  app.put('/api/alvaras/:id', (req, res) => {
    try {
      const updated = db.updateAlvara(req.params.id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao atualizar alvará/licença' });
    }
  });

  app.delete('/api/alvaras/:id', (req, res) => {
    try {
      const deleted = db.deleteAlvara(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Alvará/licença não encontrado' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao excluir alvará/licença' });
    }
  });

  app.post('/api/alvaras/:id/renovar', (req, res) => {
    try {
      const { protocolo, dataSolicitacao } = req.body;
      if (!protocolo || protocolo.trim().length < 3) {
        return res.status(400).json({ error: 'O número de protocolo do processo de renovação é obrigatório.' });
      }
      const alvara = db.registrarRenovacaoAlvara(req.params.id, protocolo, dataSolicitacao);
      res.json(alvara);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao registrar renovação do alvará' });
    }
  });

  // =========================================================================
  // --- RECURSOS HUMANOS E DEPARTAMENTO PESSOAL (RH & DP) ---
  // =========================================================================

  // Funções / Cargos
  app.get('/api/funcoes', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const funcoes = db.getFuncoes(empresaId);
    res.json(funcoes);
  });

  app.post('/api/funcoes', (req, res) => {
    try {
      const { titulo, cbo, departamento, salarioBase } = req.body;
      if (!titulo || !cbo || !departamento) {
        return res.status(400).json({ error: 'Título do cargo, CBO e departamento são obrigatórios.' });
      }
      const funcao = db.createFuncao(req.body);
      res.status(201).json(funcao);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao cadastrar função/cargo' });
    }
  });

  app.put('/api/funcoes/:id', (req, res) => {
    try {
      const updated = db.updateFuncao(req.params.id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao atualizar função/cargo' });
    }
  });

  app.delete('/api/funcoes/:id', (req, res) => {
    try {
      const deleted = db.deleteFuncao(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Função/cargo não encontrado' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao excluir função/cargo' });
    }
  });

  // Funcionários / Colaboradores
  app.get('/api/funcionarios', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const funcionarios = db.getFuncionarios(empresaId);
    res.json(funcionarios);
  });

  app.get('/api/funcionarios/:id', (req, res) => {
    const func = db.getFuncionarioById(req.params.id);
    if (!func) {
      return res.status(404).json({ error: 'Funcionário não encontrado' });
    }
    res.json(func);
  });

  app.post('/api/funcionarios', (req, res) => {
    try {
      const { nomeCompleto, cpf, empresaId, cargoNome, salarioBase, dataAdmissao } = req.body;
      if (!nomeCompleto || !cpf || !empresaId || !cargoNome || !salarioBase || !dataAdmissao) {
        return res.status(400).json({
          error: 'Nome completo, CPF, empresa, cargo, salário base e data de admissão são obrigatórios.',
        });
      }
      const novoFunc = db.createFuncionario(req.body);
      res.status(201).json(novoFunc);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao cadastrar funcionário' });
    }
  });

  app.put('/api/funcionarios/:id', (req, res) => {
    try {
      const updated = db.updateFuncionario(req.params.id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao atualizar funcionário' });
    }
  });

  app.delete('/api/funcionarios/:id', (req, res) => {
    try {
      const deleted = db.deleteFuncionario(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Funcionário não encontrado' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao excluir funcionário' });
    }
  });

  // Ações de RH: Férias
  app.post('/api/funcionarios/:id/ferias', (req, res) => {
    try {
      const {
        dias,
        dataInicio,
        dataFim,
        periodoAquisitivoInicio,
        periodoAquisitivoFim,
        limiteConcessivo,
        fracionamentoNumero,
        abonoPecuniario,
        diasAbono,
        adiantamentoDecimoTerceiro,
        dataAvisoFerias,
        dataLimitePagamento,
        observacoes,
      } = req.body;

      if (!dias || !dataInicio || !dataFim) {
        return res.status(400).json({ error: 'Quantidade de dias, data de início e término são obrigatórios.' });
      }

      // Se informou dados detalhados de período, utiliza o motor avançado de gozo de férias
      const func = db.getFuncionarioById(req.params.id);
      if (!func) {
        return res.status(404).json({ error: 'Funcionário não encontrado' });
      }

      const paInicio = periodoAquisitivoInicio || func.periodoAquisitivoInicio || '2024-01-01';
      const paFim = periodoAquisitivoFim || func.periodoAquisitivoFim || '2024-12-31';
      const limConc = limiteConcessivo || func.limiteConcessivoFerias || '2025-11-30';

      const resultado = db.registrarPeriodoGozo({
        funcionarioId: req.params.id,
        periodoAquisitivoInicio: paInicio,
        periodoAquisitivoFim: paFim,
        limiteConcessivo: limConc,
        fracionamentoNumero: fracionamentoNumero || 1,
        dataInicio,
        dataFim,
        diasGozo: Number(dias),
        abonoPecuniario: Boolean(abonoPecuniario),
        diasAbono: Number(diasAbono || 0),
        adiantamentoDecimoTerceiro: Boolean(adiantamentoDecimoTerceiro),
        dataAvisoFerias,
        dataLimitePagamento,
        observacoes,
      });

      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao registrar férias' });
    }
  });

  // Ações de RH: Afastamento
  app.post('/api/funcionarios/:id/afastamento', (req, res) => {
    try {
      const { motivo } = req.body;
      if (!motivo) {
        return res.status(400).json({ error: 'O motivo do afastamento é obrigatório.' });
      }
      const updated = db.registrarAfastamento(req.params.id, motivo);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao registrar afastamento' });
    }
  });

  // Holerite Individual Calculado
  app.get('/api/funcionarios/:id/holerite', (req, res) => {
    try {
      const func = db.getFuncionarioById(req.params.id);
      if (!func) {
        return res.status(404).json({ error: 'Funcionário não encontrado' });
      }
      const competencia = (req.query.competencia as string) || '09/2026';
      const holerite = db.calcularHolerite(func, competencia);
      res.json({ funcionario: func, holerite });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao calcular holerite' });
    }
  });

  // Simulação de Folha de Pagamento Consolidada
  app.get('/api/folha-pagamento/simulacao', (req, res) => {
    try {
      const empresaId = req.query.empresaId as string | undefined;
      const competencia = (req.query.competencia as string) || '09/2026';
      const simulacao = db.getFolhaSimulada(empresaId, competencia);
      res.json(simulacao);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao simular folha de pagamento' });
    }
  });

  // Fechamento e Integração da Folha com Contas a Pagar
  app.post('/api/folha-pagamento/fechar', (req, res) => {
    try {
      const { empresaId, competencia, totalLiquido, totalInss, totalFgts } = req.body;
      const criadas = db.fecharFolhaContasPagar(empresaId || 'todas', competencia || '09/2026', {
        totalLiquido: Number(totalLiquido) || 0,
        totalInss: Number(totalInss) || 0,
        totalFgts: Number(totalFgts) || 0,
      });
      res.json({
        success: true,
        message: `Folha da competência ${competencia} fechada com sucesso. Contas a pagar geradas.`,
        contasCriadas: criadas,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao fechar folha de pagamento' });
    }
  });

  // =========================================================================
  // --- ROTAS DE CONTROLE DE PONTO ELETRÔNICO & AUDITORIA DE JORNADA (REP-P) ---
  // =========================================================================

  // Listagem de Registros de Ponto com Filtros
  app.get('/api/pontos', (req, res) => {
    try {
      const {
        empresaId,
        funcionarioId,
        dataInicio,
        dataFim,
        competencia,
        status,
        inconsistenciasApenas,
      } = req.query;

      const registros = db.getPontos({
        empresaId: empresaId as string,
        funcionarioId: funcionarioId as string,
        dataInicio: dataInicio as string,
        dataFim: dataFim as string,
        competencia: competencia as string,
        status: status as string,
        inconsistenciasApenas: inconsistenciasApenas === 'true',
      });
      res.json(registros);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao carregar registros de ponto' });
    }
  });

  // Monitor em Tempo Real de Hoje
  app.get('/api/pontos/hoje', (req, res) => {
    try {
      const empresaId = req.query.empresaId as string | undefined;
      const painel = db.getPontosHoje(empresaId);
      res.json(painel);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao carregar status do ponto de hoje' });
    }
  });

  // Registro de Marcação de Ponto (Trabalhador ou Relógio REP-P)
  app.post('/api/pontos/bater', (req, res) => {
    try {
      const { funcionarioId, tipo, dataHora, geolocalizacao, fotoComprovante, observacao, origem } = req.body;
      if (!funcionarioId || !tipo) {
        return res.status(400).json({ error: 'Colaborador e tipo de batida são obrigatórios.' });
      }

      const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '189.120.45.12';

      const resultado = db.registrarBatidaPonto({
        funcionarioId,
        tipo,
        dataHora,
        geolocalizacao,
        ip: clientIp,
        fotoComprovante,
        observacao,
        origem: origem || 'rep_p',
      });

      res.status(201).json({
        success: true,
        message: 'Marcação de ponto registrada e certificada com sucesso!',
        ...resultado,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Falha ao registrar ponto eletrônico' });
    }
  });

  // Ajuste / Retificação de Marcação pelo RH
  app.put('/api/pontos/:id/ajuste', (req, res) => {
    try {
      const { entrada1, saidaIntervalo, retornoIntervalo, saida2, motivoAjuste, observacaoRH, auditadoPor, statusAuditoria } = req.body;
      if (!motivoAjuste) {
        return res.status(400).json({ error: 'A justificativa legal do ajuste é obrigatória conforme Portaria 671 MTE.' });
      }

      const atualizado = db.ajustarPontoDia(req.params.id, {
        entrada1,
        saidaIntervalo,
        retornoIntervalo,
        saida2,
        motivoAjuste,
        observacaoRH,
        auditadoPor: auditadoPor || 'RH Central / Auditor',
        statusAuditoria,
      });

      res.json({
        success: true,
        message: 'Registro de jornada retificado com sucesso.',
        ponto: atualizado,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao ajustar ponto' });
    }
  });

  // Auditoria e Homologação de Dia Individual
  app.put('/api/pontos/:id/auditar', (req, res) => {
    try {
      const { status, observacaoRH, auditadoPor } = req.body;
      if (!status) {
        return res.status(400).json({ error: 'Status de auditoria é obrigatório.' });
      }

      const atualizado = db.auditarPontoDia(req.params.id, {
        status,
        observacaoRH,
        auditadoPor: auditadoPor || 'RH Central / Auditor',
      });

      res.json({
        success: true,
        message: 'Status de auditoria do ponto atualizado com sucesso.',
        ponto: atualizado,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao auditar ponto' });
    }
  });

  // Homologação em Lote de Registros
  app.post('/api/pontos/homologar-lote', (req, res) => {
    try {
      const { empresaId, competencia, apenasSemInconsistencia, auditadoPor } = req.body;
      const resultado = db.homologarPontosLote(
        {
          empresaId,
          competencia,
          apenasSemInconsistencia: apenasSemInconsistencia !== false,
        },
        auditadoPor || 'RH Central / Auditor'
      );

      res.json({
        success: true,
        message: `${resultado.totalHomologados} registros homologados com sucesso.`,
        ...resultado,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao homologar pontos em lote' });
    }
  });

  // Espelho de Ponto Consolidado Mensal
  app.get('/api/pontos/espelho', (req, res) => {
    try {
      const { funcionarioId, competencia } = req.query;
      if (!funcionarioId) {
        return res.status(400).json({ error: 'ID do funcionário é obrigatório.' });
      }

      const espelho = db.getEspelhoPontoMensal(
        funcionarioId as string,
        (competencia as string) || '09/2026'
      );
      res.json(espelho);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao gerar espelho de ponto' });
    }
  });

  // =========================================================================
  // --- ROTAS DE GESTÃO DE FÉRIAS, AVISOS CLT & PERÍODOS AQUISITIVOS ---
  // =========================================================================

  // Listagem de Períodos de Férias com Filtros
  app.get('/api/ferias', (req, res) => {
    try {
      const { empresaId, funcionarioId, status, ano } = req.query;
      const periodos = db.getPeriodosFerias({
        empresaId: empresaId as string,
        funcionarioId: funcionarioId as string,
        status: status as string,
        ano: ano ? Number(ano) : undefined,
      });
      res.json(periodos);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao buscar períodos de férias' });
    }
  });

  // Painel de Avisos e Notificações de Vencimento de Férias (Art. 135/137/145 CLT)
  app.get('/api/ferias/painel-avisos', (req, res) => {
    try {
      const { empresaId } = req.query;
      const painel = db.getPainelAvisosFerias(empresaId as string);
      res.json(painel);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao carregar painel de avisos de férias' });
    }
  });

  // Histórico de Períodos Aquisitivos e Saldos de um Colaborador
  app.get('/api/ferias/funcionario/:id', (req, res) => {
    try {
      const calculo = db.calcularSaldosEPeriodosFuncionario(req.params.id);
      res.json(calculo);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao calcular períodos do funcionário' });
    }
  });

  // Simulação de Cálculos de Férias (Bruto, 1/3, Abono, 13º, INSS, IRRF, Líquido)
  app.post('/api/ferias/calcular-simulacao', (req, res) => {
    try {
      const {
        salarioBase,
        diasGozo,
        abonoPecuniario,
        diasAbono,
        adiantamentoDecimoTerceiro,
        dependentesIrrf,
      } = req.body;

      if (!salarioBase || !diasGozo) {
        return res.status(400).json({ error: 'Salário base e dias de gozo são obrigatórios.' });
      }

      const calculo = db.calcularValoresFerias({
        salarioBase: Number(salarioBase),
        diasGozo: Number(diasGozo),
        abonoPecuniario: Boolean(abonoPecuniario),
        diasAbono: Number(diasAbono || 0),
        adiantamentoDecimoTerceiro: Boolean(adiantamentoDecimoTerceiro),
        dependentesIrrf: Number(dependentesIrrf || 0),
      });

      res.json(calculo);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao simular cálculos de férias' });
    }
  });

  // Registro de Período de Gozo com Fracionamento e Dedução de Saldo
  app.post('/api/ferias/registrar', (req, res) => {
    try {
      const resultado = db.registrarPeriodoGozo(req.body);
      res.status(201).json({
        success: true,
        message: 'Período de férias registrado com sucesso!',
        ...resultado,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao registrar férias' });
    }
  });

  // Cancelamento de Período de Gozo e Restituição do Saldo
  app.post('/api/ferias/:id/cancelar', (req, res) => {
    try {
      const resultado = db.cancelarPeriodoGozo(req.params.id);
      res.json({
        success: true,
        message: 'Período de férias cancelado e saldo restituído ao colaborador.',
        ...resultado,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao cancelar período de férias' });
    }
  });

  // Emissão de Documento Oficial: Aviso Prévio e Recibo de Férias CLT
  app.get('/api/ferias/:id/documento', (req, res) => {
    try {
      const documento = db.gerarDocumentoAvisoRecibo(req.params.id);
      res.json(documento);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao gerar documento de férias' });
    }
  });

  // =========================================================================
  // --- ROTAS DE CÁLCULO DE RESCISÃO CONTRATUAL, VERBAS & TRCT (CLT) ---
  // =========================================================================

  // Listagem de Rescisões Contratuais Geradas
  app.get('/api/rh/rescisoes', (req, res) => {
    try {
      const { empresaId, funcionarioId } = req.query;
      const rescisoes = db.getRescisoes(empresaId as string, funcionarioId as string);
      res.json(rescisoes);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao buscar rescisões contratuais' });
    }
  });

  // Busca de Rescisão Contratual por ID
  app.get('/api/rh/rescisoes/:id', (req, res) => {
    try {
      const rescisao = db.getRescisaoById(req.params.id);
      if (!rescisao) {
        return res.status(404).json({ error: 'Rescisão não encontrada' });
      }
      res.json(rescisao);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao buscar rescisão' });
    }
  });

  // Simulação / Cálculo em Tempo Real de Verbas Rescisórias e Prévia do TRCT
  app.post('/api/rh/rescisoes/calcular', (req, res) => {
    try {
      const resultado = db.calcularRescisao(req.body);
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao calcular rescisão contratual' });
    }
  });

  // Salvar / Efetivar Rescisão Contratual
  app.post('/api/rh/rescisoes', (req, res) => {
    try {
      const salvo = db.salvarRescisao(req.body);
      res.status(201).json({
        success: true,
        message: 'Rescisão contratual calculada e salva com sucesso!',
        rescisao: salvo,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao salvar rescisão contratual' });
    }
  });

  // Homologação de Rescisão Contratual
  app.post('/api/rh/rescisoes/:id/homologar', (req, res) => {
    try {
      const homologada = db.homologarRescisao(req.params.id);
      res.json({
        success: true,
        message: 'Rescisão contratual homologada com sucesso e colaborador desligado.',
        rescisao: homologada,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao homologar rescisão' });
    }
  });

  // Exclusão de Rescisão
  app.delete('/api/rh/rescisoes/:id', (req, res) => {
    try {
      const excluido = db.deleteRescisao(req.params.id);
      if (!excluido) {
        return res.status(404).json({ error: 'Rescisão não encontrada para exclusão.' });
      }
      res.json({ success: true, message: 'Rescisão excluída com sucesso.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao excluir rescisão' });
    }
  });

  // =========================================================================
  // --- ROTAS DO ESOCIAL & FECHAMENTO DE FOLHA (S-1200, S-1210, S-1299) ---
  // =========================================================================

  // Obter Configuração de Parâmetros do eSocial de uma Empresa
  app.get('/api/esocial/configuracao/:empresaId', (req, res) => {
    try {
      const config = db.getESocialConfiguracao(req.params.empresaId);
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao obter configurações do eSocial' });
    }
  });

  // Salvar / Atualizar Parâmetros do eSocial
  app.put('/api/esocial/configuracao/:empresaId', (req, res) => {
    try {
      const config = db.salvarESocialConfiguracao(req.params.empresaId, req.body);
      res.json({
        success: true,
        message: 'Parâmetros e configurações do eSocial salvos com sucesso!',
        config,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao salvar configurações do eSocial' });
    }
  });

  // Listagem de Eventos eSocial (Histórico e Transmitidos)
  app.get('/api/esocial/eventos', (req, res) => {
    try {
      const { empresaId, competencia } = req.query;
      const eventos = db.getESocialEventos(empresaId as string, competencia as string);
      res.json(eventos);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao buscar eventos do eSocial' });
    }
  });

  // Validar Eventos Periódicos da Competência (S-1200 e S-1210)
  app.post('/api/esocial/validar-periodicos', (req, res) => {
    try {
      const { empresaId, competencia } = req.body;
      if (!empresaId) {
        return res.status(400).json({ error: 'ID da empresa é obrigatório.' });
      }

      const resultado = db.validarEventosPeriodicosESocial(empresaId, competencia || '09/2026');
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao validar eventos periódicos' });
    }
  });

  // Painel Geral de Fechamento de Folha do eSocial (Consolidação S-1200 / S-1210 / S-1299 e DCTFWeb)
  app.get('/api/esocial/fechamento-painel/:empresaId', (req, res) => {
    try {
      const { competencia } = req.query;
      const painel = db.getPainelFechamentoFolhaESocial(req.params.empresaId, (competencia as string) || '09/2026');
      res.json(painel);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao carregar painel de fechamento do eSocial' });
    }
  });

  // Transmissão Oficial de Fechamento dos Eventos Periódicos (S-1299)
  app.post('/api/esocial/fechar-folha-s1299', (req, res) => {
    try {
      const { empresaId, competencia } = req.body;
      if (!empresaId) {
        return res.status(400).json({ error: 'ID da empresa é obrigatório.' });
      }

      const resultado = db.transmitirFechamentoFolhaS1299(empresaId, competencia || '09/2026');
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao transmitir fechamento S-1299' });
    }
  });

  // Reabertura de Folha de Pagamento no eSocial (S-1298)
  app.post('/api/esocial/reabrir-folha-s1298', (req, res) => {
    try {
      const { empresaId, competencia } = req.body;
      if (!empresaId) {
        return res.status(400).json({ error: 'ID da empresa é obrigatório.' });
      }

      const resultado = db.reabrirFolhaESocialS1298(empresaId, competencia || '09/2026');
      res.json(resultado);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao reabrir folha S-1298' });
    }
  });

  // Download do XML do Evento eSocial
  app.get('/api/esocial/eventos/:id/xml', (req, res) => {
    try {
      const { xml, nomeArquivo } = db.gerarXmlDownloadESocial(req.params.id);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
      res.send(xml);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Erro ao exportar XML' });
    }
  });

  // =========================================================================
  // --- ROTAS DE GESTÃO DO BANCO DE DADOS (ADMINISTRADOR) ---
  // =========================================================================

  // Estatísticas e Metadados do Banco de Dados
  app.get('/api/database/stats', (req, res) => {
    try {
      const stats = db.getStats();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao obter estatísticas do banco' });
    }
  });

  // Backup / Dump Completo do Banco de Dados
  app.get('/api/database/dump', (req, res) => {
    try {
      const dump = db.getFullDatabase();
      res.setHeader('Content-Disposition', 'attachment; filename=contabgest_backup.json');
      res.setHeader('Content-Type', 'application/json');
      res.json(dump);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao gerar dump do banco' });
    }
  });

  // Agendamento de Backups Automáticos & Exportação JSON / CSV
  app.get('/api/database/backup/schedules', (req, res) => {
    try {
      const schedules = db.getBackupSchedules();
      res.json(schedules);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao listar agendamentos de backup' });
    }
  });

  app.post('/api/database/backup/schedules', (req, res) => {
    try {
      const saved = db.saveBackupSchedule(req.body);
      res.status(201).json(saved);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao salvar agendamento de backup' });
    }
  });

  app.delete('/api/database/backup/schedules/:id', (req, res) => {
    try {
      const success = db.deleteBackupSchedule(req.params.id);
      res.json({ success });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao remover agendamento de backup' });
    }
  });

  app.get('/api/database/backup/history', (req, res) => {
    try {
      const history = db.getBackupHistory();
      res.json(history);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao listar histórico de backups' });
    }
  });

  app.post('/api/database/backup/executar', (req, res) => {
    try {
      const { formato = 'json', destino = 'cloud_storage_seguro', scheduleId, titulo } = req.body;
      const resultado = db.executarBackup({ formato, destino, scheduleId, titulo, tipoTrigger: 'manual' });
      res.json(resultado);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao executar backup' });
    }
  });

  app.get('/api/database/backup/exportar-csv', (req, res) => {
    try {
      const tabela = req.query.tabela as string | undefined;
      const csvs = db.exportarDadosCsv(tabela);
      res.json(csvs);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao exportar tabelas em CSV' });
    }
  });

  // Obter Registros de uma Tabela Específica
  app.get('/api/database/tables/:table', (req, res) => {
    try {
      const records = db.getTableRecords(req.params.table);
      res.json(records);
    } catch (err: any) {
      res.status(404).json({ error: err.message || 'Tabela não encontrada' });
    }
  });

  // Inserir Novo Registro em Qualquer Tabela
  app.post('/api/database/tables/:table', (req, res) => {
    try {
      const newRecord = db.createTableRecord(req.params.table, req.body);
      res.status(201).json(newRecord);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao criar registro' });
    }
  });

  // Atualizar Registro Existente em Qualquer Tabela
  app.put('/api/database/tables/:table/:id', (req, res) => {
    try {
      const updated = db.updateTableRecord(req.params.table, req.params.id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao atualizar registro' });
    }
  });

  // Excluir Registro de Qualquer Tabela
  app.delete('/api/database/tables/:table/:id', (req, res) => {
    try {
      const success = db.deleteTableRecord(req.params.table, req.params.id);
      if (!success) {
        return res.status(404).json({ error: 'Registro não encontrado para exclusão' });
      }
      res.json({ success: true, message: 'Registro excluído com sucesso do banco de dados.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erro ao excluir registro' });
    }
  });

  // Restaurar Backup de Arquivo JSON
  app.post('/api/database/restore', (req, res) => {
    try {
      const restored = db.restoreFullDatabase(req.body);
      res.json({
        success: true,
        message: 'Banco de dados restaurado com sucesso.',
        version: restored.version,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Falha ao restaurar banco de dados' });
    }
  });

  // Resetar Banco de Dados para os Dados Padrão (Seed DEMO)
  app.post('/api/database/reset', (req, res) => {
    try {
      const resetData = db.resetToDemoDatabase();
      res.json({
        success: true,
        message: 'Banco de dados restaurado para os dados padrão com sucesso.',
        version: resetData.version,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao resetar banco de dados' });
    }
  });

  // Ativar Modo Produção e Limpar Tags DEMO dos Registros
  app.post('/api/database/production-mode', (req, res) => {
    try {
      const { enabled = true, cleanLabels = true } = req.body;
      const result = db.setProductionMode(enabled, cleanLabels);
      res.json({
        success: true,
        message: enabled
          ? 'Ambiente de Produção v2.0.0 ativado! Tags de demonstração removidas com sucesso.'
          : 'Modo de testes configurado.',
        version: result.version,
        isDemoDatabase: result.isDemoDatabase,
        cleanedCount: result.cleanedCount,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao alterar modo de operação' });
    }
  });

  // Status de Deploy do Sistema
  app.get('/api/system/status', (req, res) => {
    res.json({
      environment: 'production',
      version: '2.1.0',
      readyForDeploy: false,
      note: 'Ambiente base com dados de demonstração. Configure credenciais e banco antes de produção.',
      timestamp: new Date().toISOString(),
      modules: {
        fiscal: 'online',
        rh: 'online',
        contabil: 'online',
        ecac: 'conectado',
        database: 'sincronizado',
      },
    });
  });

  // =========================================================================
  // --- MÓDULO DE COBRANÇAS, CONTRATOS, MENSALIDADES E RECIBOS DE HONORÁRIOS ---
  // =========================================================================

  // Listar Serviços Contábeis
  app.get('/api/cobrancas/servicos', (req, res) => {
    res.json(servicosContabeisDb);
  });

  // Criar Novo Serviço Contábil
  app.post('/api/cobrancas/servicos', (req, res) => {
    try {
      const { nome, categoria, descricao, valorSugerido, recorrente, codigo } = req.body;
      if (!nome || !categoria) {
        return res.status(400).json({ error: 'Nome e categoria do serviço são obrigatórios.' });
      }
      const novoServico = {
        id: `srv-${Date.now()}`,
        codigo: codigo || `SRV-${String(servicosContabeisDb.length + 1).padStart(2, '0')}`,
        nome,
        categoria,
        descricao: descricao || '',
        valorSugerido: Number(valorSugerido) || 0,
        recorrente: recorrente !== undefined ? Boolean(recorrente) : true,
        ativo: true,
      };
      servicosContabeisDb.push(novoServico);
      res.status(201).json(novoServico);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao cadastrar serviço contábil.' });
    }
  });

  // Atualizar Serviço Contábil
  app.put('/api/cobrancas/servicos/:id', (req, res) => {
    const idx = servicosContabeisDb.findIndex((s) => s.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }
    servicosContabeisDb[idx] = { ...servicosContabeisDb[idx], ...req.body };
    res.json(servicosContabeisDb[idx]);
  });

  // Listar Contratos de Honorários
  app.get('/api/cobrancas/contratos', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    let lista = contratosHonorariosDb;
    if (empresaId && empresaId !== 'todas') {
      lista = lista.filter((c) => c.empresaId === empresaId);
    }
    res.json(lista);
  });

  // Criar Contrato de Honorários
  app.post('/api/cobrancas/contratos', (req, res) => {
    try {
      const {
        empresaId,
        numeroContrato,
        dataAssinatura,
        dataInicioVigencia,
        dataTerminoVigencia,
        diaVencimento,
        valorMensalidade,
        reajusteAnualIndice,
        servicosIds,
        documentoContratoNome,
        documentoContratoUrl,
        observacoes,
      } = req.body;

      if (!empresaId || !diaVencimento || !valorMensalidade) {
        return res.status(400).json({ error: 'Empresa, dia de vencimento e valor da mensalidade são obrigatórios.' });
      }

      // Preenche nomes dos serviços
      const nomes = (servicosIds || [])
        .map((sid: string) => servicosContabeisDb.find((s) => s.id === sid)?.nome)
        .filter(Boolean);

      const novoContrato = {
        id: `cont-${Date.now()}`,
        empresaId,
        numeroContrato: numeroContrato || `CONT-${new Date().getFullYear()}/${String(contratosHonorariosDb.length + 1).padStart(3, '0')}`,
        dataAssinatura: dataAssinatura || new Date().toISOString().split('T')[0],
        dataInicioVigencia: dataInicioVigencia || new Date().toISOString().split('T')[0],
        dataTerminoVigencia: dataTerminoVigencia || undefined,
        diaVencimento: Number(diaVencimento),
        valorMensalidade: Number(valorMensalidade),
        status: 'ativo' as const,
        reajusteAnualIndice: reajusteAnualIndice || 'IPCA',
        servicosIds: servicosIds || [],
        servicosContratadosNomes: nomes,
        documentoContratoNome: documentoContratoNome || `Contrato_Prestacao_Servicos_${numeroContrato || 'Novo'}.pdf`,
        documentoContratoUrl: documentoContratoUrl || '/documentos/contratos/modelo_padrao.pdf',
        observacoes: observacoes || '',
        isDemo: true,
      };

      contratosHonorariosDb.unshift(novoContrato);

      // Gerar a primeira mensalidade imediatamente para a competência corrente
      const hoje = new Date();
      const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
      const anoAtual = hoje.getFullYear();
      const compAtual = `${mesAtual}/${anoAtual}`;
      const dataVenc = `${anoAtual}-${mesAtual}-${String(novoContrato.diaVencimento).padStart(2, '0')}`;

      const novaMensalidade = {
        id: `mens-${Date.now()}`,
        contratoId: novoContrato.id,
        empresaId: novoContrato.empresaId,
        competencia: compAtual,
        dataVencimento: dataVenc,
        valor: novoContrato.valorMensalidade,
        status: 'pendente' as const,
        codigoBarras: `34191.${Math.floor(10000 + Math.random() * 90000)} ${Math.floor(10000 + Math.random() * 90000)}.${Math.floor(100000 + Math.random() * 900000)} 91020.150008 7 98350000${String(Math.floor(novoContrato.valorMensalidade * 100)).padStart(6, '0')}`,
        pixCopiaECola: `00020126580014br.gov.bcb.pix0136contabgest.financeiro@contabgest.com.br5204000053039865407${novoContrato.valorMensalidade.toFixed(2)}5802BR5920CONTABGEST AUDITORIA6009SAO PAULO62070503***6304${Math.floor(1000 + Math.random() * 9000).toString(16).toUpperCase()}`,
        reciboEmitido: false,
        historicoEnvios: [],
        observacao: 'Primeira mensalidade gerada a partir da assinatura do contrato.',
        isDemo: true,
      };
      mensalidadesHonorariosDb.unshift(novaMensalidade);

      res.status(201).json({ contrato: novoContrato, mensalidade: novaMensalidade });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao criar contrato de honorários.' });
    }
  });

  // Atualizar Contrato de Honorários
  app.put('/api/cobrancas/contratos/:id', (req, res) => {
    const idx = contratosHonorariosDb.findIndex((c) => c.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Contrato não encontrado.' });
    }
    contratosHonorariosDb[idx] = { ...contratosHonorariosDb[idx], ...req.body };
    res.json(contratosHonorariosDb[idx]);
  });

  // Listar Mensalidades de Honorários
  app.get('/api/cobrancas/mensalidades', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const competencia = req.query.competencia as string | undefined;
    const status = req.query.status as string | undefined;

    let lista = mensalidadesHonorariosDb;
    if (empresaId && empresaId !== 'todas') {
      lista = lista.filter((m) => m.empresaId === empresaId);
    }
    if (competencia && competencia !== 'todas') {
      lista = lista.filter((m) => m.competencia === competencia);
    }
    if (status && status !== 'todos') {
      lista = lista.filter((m) => m.status === status);
    }
    res.json(lista);
  });

  // Registrar Baixa (Pagamento) de Mensalidade
  app.patch('/api/cobrancas/mensalidades/:id/baixa', (req, res) => {
    const idx = mensalidadesHonorariosDb.findIndex((m) => m.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Mensalidade não encontrada.' });
    }
    const { dataPagamento, formaPagamento, valorPago, observacao } = req.body;
    const item = mensalidadesHonorariosDb[idx];

    item.status = 'pago';
    item.dataPagamento = dataPagamento || new Date().toISOString().split('T')[0];
    item.formaPagamento = formaPagamento || 'pix';
    item.valorPago = valorPago ? Number(valorPago) : item.valor;
    if (observacao) item.observacao = observacao;

    res.json(item);
  });

  // Registrar Envio de Cobrança por WhatsApp ou E-mail
  app.post('/api/cobrancas/mensalidades/:id/enviar', (req, res) => {
    const idx = mensalidadesHonorariosDb.findIndex((m) => m.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Mensalidade não encontrada.' });
    }
    const { canal, destinatario } = req.body;
    if (!canal || !destinatario) {
      return res.status(400).json({ error: 'Canal (email ou whatsapp) e destinatário são obrigatórios.' });
    }

    const novoEnvio = {
      id: `env-${Date.now()}`,
      canal: canal as 'email' | 'whatsapp',
      dataEnvio: new Date().toISOString(),
      destinatario,
      status: 'entregue' as const,
    };

    if (!mensalidadesHonorariosDb[idx].historicoEnvios) {
      mensalidadesHonorariosDb[idx].historicoEnvios = [];
    }
    mensalidadesHonorariosDb[idx].historicoEnvios.unshift(novoEnvio);

    res.json({ success: true, mensalidade: mensalidadesHonorariosDb[idx], envio: novoEnvio });
  });

  // Listar Recibos de Honorários
  app.get('/api/cobrancas/recibos', (req, res) => {
    const empresaId = req.query.empresaId as string | undefined;
    const mensalidadeId = req.query.mensalidadeId as string | undefined;

    let lista = recibosHonorariosDb;
    if (empresaId && empresaId !== 'todas') {
      lista = lista.filter((r) => r.empresaId === empresaId);
    }
    if (mensalidadeId) {
      lista = lista.filter((r) => r.mensalidadeId === mensalidadeId);
    }
    res.json(lista);
  });

  // Emitir / Gerar Novo Recibo de Honorários
  app.post('/api/cobrancas/recibos', (req, res) => {
    try {
      const { mensalidadeId } = req.body;
      if (!mensalidadeId) {
        return res.status(400).json({ error: 'ID da mensalidade é obrigatório para emitir recibo.' });
      }

      const mensalidade = mensalidadesHonorariosDb.find((m) => m.id === mensalidadeId);
      if (!mensalidade) {
        return res.status(404).json({ error: 'Mensalidade não encontrada.' });
      }

      const contrato = contratosHonorariosDb.find((c) => c.id === mensalidade.contratoId);
      const empresa = db.getEmpresas().find((e) => e.id === mensalidade.empresaId);

      const servicosNomes = contrato?.servicosContratadosNomes || [
        'Assessoria Contábil, Fiscal e Folha de Pagamento Mensal',
      ];

      const novoRecibo = {
        id: `rec-${Date.now()}`,
        numero: `REC-${new Date().getFullYear()}/${String(recibosHonorariosDb.length + 90).padStart(3, '0')}`,
        mensalidadeId: mensalidade.id,
        contratoId: mensalidade.contratoId,
        empresaId: mensalidade.empresaId,
        razaoSocialCliente: empresa?.razaoSocial || 'Cliente Contábil',
        nomeFantasiaCliente: empresa?.nomeFantasia || empresa?.razaoSocial || 'Cliente Contábil',
        cnpjCpfCliente: empresa?.cnpj || '00.000.000/0001-00',
        enderecoCliente: empresa?.cidade && empresa?.uf
          ? `${empresa.cidade}/${empresa.uf}`
          : 'São Paulo/SP',
        valor: mensalidade.valorPago || mensalidade.valor,
        valorPorExtenso: valorPorExtenso(mensalidade.valorPago || mensalidade.valor),
        competencia: mensalidade.competencia,
        dataEmissao: new Date().toISOString().split('T')[0],
        dataPagamento: mensalidade.dataPagamento || new Date().toISOString().split('T')[0],
        formaPagamento: (mensalidade.formaPagamento || 'PIX').toUpperCase(),
        discriminacaoServicos: servicosNomes,
        nomeEscritorio: 'ContabGest Assessoria e Auditoria Contábil S/S',
        cnpjEscritorio: '45.879.123/0001-44',
        enderecoEscritorio: 'Rua Funchal, 418 - Vila Olímpia, São Paulo/SP - CEP: 04551-060',
        contadorResponsavel: 'Roberto Simões Santos',
        crcContador: 'CRC-SP 1SP234567/O-8',
      };

      recibosHonorariosDb.unshift(novoRecibo);

      // Marca na mensalidade que o recibo foi emitido
      mensalidade.reciboEmitido = true;
      mensalidade.reciboId = novoRecibo.id;
      mensalidade.reciboNumero = novoRecibo.numero;

      res.status(201).json(novoRecibo);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao emitir recibo de honorários.' });
    }
  });

  // Gerar Mensalidades em Lote para uma Competência
  app.post('/api/cobrancas/mensalidades/gerar-lote', (req, res) => {
    try {
      const { competencia } = req.body;
      if (!competencia || !competencia.includes('/')) {
        return res.status(400).json({ error: 'Competência no formato MM/AAAA é obrigatória.' });
      }

      const [mesStr, anoStr] = competencia.split('/');
      const contratosAtivos = contratosHonorariosDb.filter((c) => c.status === 'ativo');
      const geradas = [];

      for (const cont of contratosAtivos) {
        // Verifica se já existe mensalidade para esse contrato e competência
        const existe = mensalidadesHonorariosDb.find(
          (m) => m.contratoId === cont.id && m.competencia === competencia
        );
        if (!existe) {
          const dia = String(cont.diaVencimento).padStart(2, '0');
          const dataVenc = `${anoStr}-${mesStr}-${dia}`;

          const nova = {
            id: `mens-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            contratoId: cont.id,
            empresaId: cont.empresaId,
            competencia,
            dataVencimento: dataVenc,
            valor: cont.valorMensalidade,
            status: 'pendente' as const,
            codigoBarras: `34191.${Math.floor(10000 + Math.random() * 90000)} ${Math.floor(10000 + Math.random() * 90000)}.${Math.floor(100000 + Math.random() * 900000)} 91020.150008 7 98350000${String(Math.floor(cont.valorMensalidade * 100)).padStart(6, '0')}`,
            pixCopiaECola: `00020126580014br.gov.bcb.pix0136contabgest.financeiro@contabgest.com.br5204000053039865407${cont.valorMensalidade.toFixed(2)}5802BR5920CONTABGEST AUDITORIA6009SAO PAULO62070503***6304${Math.floor(1000 + Math.random() * 9000).toString(16).toUpperCase()}`,
            reciboEmitido: false,
            historicoEnvios: [],
            observacao: `Gerada em lote para competência ${competencia}`,
            isDemo: true,
          };
          mensalidadesHonorariosDb.unshift(nova);
          geradas.push(nova);
        }
      }

      res.json({
        success: true,
        competencia,
        totalGeradas: geradas.length,
        mensalidades: geradas,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao gerar lote de mensalidades.' });
    }
  });

  // =========================================================================
  // --- ROTAS: CONTROLE PATRIMONIAL, ATIVO IMOBILIZADO & DEPRECIAÇÃO ---
  // =========================================================================

  // Listar bens patrimoniais (com filtros)
  app.get('/api/patrimonio/bens', (req, res) => {
    try {
      const { empresaId, status, classificacao, seguroStatus, search } = req.query;
      let resultado = [...bensPatrimoniaisDb];

      if (empresaId && empresaId !== 'all') {
        resultado = resultado.filter((b) => b.empresaId === String(empresaId));
      }
      if (status && status !== 'all') {
        resultado = resultado.filter((b) => b.status === String(status));
      }
      if (classificacao && classificacao !== 'all') {
        resultado = resultado.filter((b) => b.classificacao === String(classificacao));
      }
      if (seguroStatus && seguroStatus !== 'all') {
        resultado = resultado.filter((b) => b.seguroStatus === String(seguroStatus));
      }
      if (search) {
        const q = String(search).toLowerCase();
        resultado = resultado.filter(
          (b) =>
            b.descricao.toLowerCase().includes(q) ||
            b.numeroPatrimonio.toLowerCase().includes(q) ||
            b.placaIdentificacao.toLowerCase().includes(q) ||
            b.numeroNotaFiscal.toLowerCase().includes(q) ||
            (b.marca && b.marca.toLowerCase().includes(q)) ||
            (b.responsavel && b.responsavel.toLowerCase().includes(q))
        );
      }

      res.json(resultado);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao listar bens patrimoniais.' });
    }
  });

  // Cadastrar novo bem patrimonial
  app.post('/api/patrimonio/bens', (req, res) => {
    try {
      const dados = req.body;
      if (!dados.descricao || !dados.valorAquisicao || !dados.dataAquisicao) {
        return res.status(400).json({ error: 'Descrição, valor de aquisição e data de aquisição são obrigatórios.' });
      }

      const params = TABELA_PARAMETROS_ATIVO[dados.classificacao as keyof typeof TABELA_PARAMETROS_ATIVO] || TABELA_PARAMETROS_ATIVO.outros;
      const taxaAnual = Number(dados.taxaDepreciacaoAnual || params.taxaAnual);
      const vidaUtilAnos = Number(dados.vidaUtilAnos || params.vidaUtilAnos);
      const valorResidualPercentual = Number(dados.valorResidualPercentual ?? params.sugestaoResidualPercentual);

      // Calcular depreciação
      const calc = calcularDepreciacaoBem(
        Number(dados.valorAquisicao),
        valorResidualPercentual,
        taxaAnual,
        dados.dataAquisicao,
        '2026-09-30',
        Number(dados.agio || 0),
        Number(dados.desagio || 0)
      );

      // Gera número de patrimônio e placa se não informados
      const seq = bensPatrimoniaisDb.length + 101;
      const numeroPatrimonio = dados.numeroPatrimonio || `PAT-${String(seq).padStart(5, '0')}`;
      const placaIdentificacao = dados.placaIdentificacao || `PLA-SP-${new Date().getFullYear()}-${String(seq).slice(-3)}`;

      // Status do seguro
      let seguroStatus: any = 'sem_seguro';
      if (dados.temSeguro) {
        seguroStatus = 'vigente';
        if (dados.seguroDataFim) {
          const dtFim = new Date(dados.seguroDataFim).getTime();
          const dtHoje = new Date('2026-09-17').getTime();
          const diasRestantes = Math.ceil((dtFim - dtHoje) / (1000 * 60 * 60 * 24));
          if (diasRestantes < 0) seguroStatus = 'expirado';
          else if (diasRestantes <= 45) seguroStatus = 'vencendo';
        }
      }

      const novoBem = {
        id: `bem-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        empresaId: dados.empresaId || '1',
        numeroPatrimonio,
        placaIdentificacao,
        descricao: dados.descricao,
        classificacao: dados.classificacao || 'maquinas_equipamentos',
        marca: dados.marca || '',
        modelo: dados.modelo || '',
        numeroSerie: dados.numeroSerie || '',
        localizacao: dados.localizacao || 'Matriz - Instalações Gerais',
        centroCustoId: dados.centroCustoId || 'cc-01',
        responsavel: dados.responsavel || '',
        status: dados.status || 'ativo',

        dataAquisicao: dados.dataAquisicao,
        numeroNotaFiscal: dados.numeroNotaFiscal || 'S/N',
        serieNotaFiscal: dados.serieNotaFiscal || '1',
        fornecedorNome: dados.fornecedorNome || 'Fornecedor Homologado',
        fornecedorCnpj: dados.fornecedorCnpj || '',
        chaveAcessoNfe: dados.chaveAcessoNfe || '',
        valorAquisicao: Number(dados.valorAquisicao),
        contratoVinculado: dados.contratoVinculado || '',
        agio: Number(dados.agio || 0),
        desagio: Number(dados.desagio || 0),

        temSeguro: Boolean(dados.temSeguro),
        seguradora: dados.seguradora || '',
        numeroApolice: dados.numeroApolice || '',
        seguroDataInicio: dados.seguroDataInicio || '',
        seguroDataFim: dados.seguroDataFim || '',
        valorSegurado: Number(dados.valorSegurado || dados.valorAquisicao),
        seguroStatus,

        taxaDepreciacaoAnual: taxaAnual,
        vidaUtilAnos,
        valorResidualPercentual,
        valorResidual: calc.valorResidual,
        valorDepreciavel: calc.valorDepreciavel,
        depreciacaoMensal: calc.depreciacaoMensal,
        mesesDepreciados: calc.mesesDepreciados,
        depreciacaoAcumulada: calc.depreciacaoAcumulada,
        valorContabilLiquido: calc.valorContabilLiquido,

        observacoes: dados.observacoes || '',
        qrcodeSimulado: `${numeroPatrimonio}|${placaIdentificacao}|${dados.descricao.slice(0, 20)}`,
        isDemo: true,
      };

      bensPatrimoniaisDb.unshift(novoBem as any);
      res.status(201).json(novoBem);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao cadastrar bem patrimonial.' });
    }
  });

  // Atualizar bem patrimonial
  app.put('/api/patrimonio/bens/:id', (req, res) => {
    try {
      const { id } = req.params;
      const idx = bensPatrimoniaisDb.findIndex((b) => b.id === id);
      if (idx === -1) {
        return res.status(404).json({ error: 'Bem patrimonial não encontrado.' });
      }

      const atual = bensPatrimoniaisDb[idx];
      const dados = req.body;

      // Recalcula depreciação
      const taxaAnual = Number(dados.taxaDepreciacaoAnual ?? atual.taxaDepreciacaoAnual);
      const valorResidualPercentual = Number(dados.valorResidualPercentual ?? atual.valorResidualPercentual);
      const valorAquisicao = Number(dados.valorAquisicao ?? atual.valorAquisicao);
      const dataAquisicao = dados.dataAquisicao ?? atual.dataAquisicao;
      const agio = Number(dados.agio ?? atual.agio);
      const desagio = Number(dados.desagio ?? atual.desagio);

      const calc = calcularDepreciacaoBem(
        valorAquisicao,
        valorResidualPercentual,
        taxaAnual,
        dataAquisicao,
        '2026-09-30',
        agio,
        desagio
      );

      let seguroStatus = atual.seguroStatus;
      if (dados.temSeguro !== undefined) {
        if (!dados.temSeguro) {
          seguroStatus = 'sem_seguro';
        } else {
          seguroStatus = 'vigente';
          const dtFimStr = dados.seguroDataFim || atual.seguroDataFim;
          if (dtFimStr) {
            const dtFim = new Date(dtFimStr).getTime();
            const dtHoje = new Date('2026-09-17').getTime();
            const dias = Math.ceil((dtFim - dtHoje) / (1000 * 60 * 60 * 24));
            if (dias < 0) seguroStatus = 'expirado';
            else if (dias <= 45) seguroStatus = 'vencendo';
          }
        }
      }

      const atualizado = {
        ...atual,
        ...dados,
        valorAquisicao,
        taxaDepreciacaoAnual: taxaAnual,
        valorResidualPercentual,
        agio,
        desagio,
        valorResidual: calc.valorResidual,
        valorDepreciavel: calc.valorDepreciavel,
        depreciacaoMensal: calc.depreciacaoMensal,
        mesesDepreciados: calc.mesesDepreciados,
        depreciacaoAcumulada: calc.depreciacaoAcumulada,
        valorContabilLiquido: calc.valorContabilLiquido,
        seguroStatus,
      };

      bensPatrimoniaisDb[idx] = atualizado;
      res.json(atualizado);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao atualizar bem.' });
    }
  });

  // Baixa / Alienação de bem (venda, sucata, sinistro, doação)
  app.post('/api/patrimonio/bens/:id/baixa', (req, res) => {
    try {
      const { id } = req.params;
      const { dataBaixa, motivoBaixa, valorVenda, notaFiscalBaixa, observacoesBaixa } = req.body;

      const idx = bensPatrimoniaisDb.findIndex((b) => b.id === id);
      if (idx === -1) {
        return res.status(404).json({ error: 'Bem patrimonial não encontrado.' });
      }

      const bem = bensPatrimoniaisDb[idx];
      const vVenda = Number(valorVenda || 0);
      // Ganho ou Perda de Capital = Valor de Venda - Valor Contábil Líquido
      const ganhoPerdaCapital = Number((vVenda - bem.valorContabilLiquido).toFixed(2));

      const bemBaixado = {
        ...bem,
        status: 'baixado' as const,
        dataBaixa: dataBaixa || '2026-09-17',
        motivoBaixa: motivoBaixa || 'venda',
        valorVenda: vVenda,
        ganhoPerdaCapital,
        notaFiscalBaixa: notaFiscalBaixa || '',
        observacoesBaixa: observacoesBaixa || '',
      };

      bensPatrimoniaisDb[idx] = bemBaixado;
      res.json({
        success: true,
        bem: bemBaixado,
        ganhoPerdaCapital,
        mensagem: ganhoPerdaCapital >= 0
          ? `Baixa efetuada com Ganho de Capital de R$ ${ganhoPerdaCapital.toFixed(2)}`
          : `Baixa efetuada com Perda de Capital de R$ ${Math.abs(ganhoPerdaCapital).toFixed(2)}`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao efetuar baixa do bem.' });
    }
  });

  // Excluir bem
  app.delete('/api/patrimonio/bens/:id', (req, res) => {
    try {
      const { id } = req.params;
      bensPatrimoniaisDb = bensPatrimoniaisDb.filter((b) => b.id !== id);
      res.json({ success: true, message: 'Bem excluído com sucesso.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao excluir bem.' });
    }
  });

  // Centros de Custo
  app.get('/api/patrimonio/centros-custo', (req, res) => {
    try {
      const { empresaId } = req.query;
      let resultado = [...centrosCustoDb];
      if (empresaId && empresaId !== 'all') {
        resultado = resultado.filter((c) => c.empresaId === String(empresaId));
      }
      res.json(resultado);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao listar centros de custo.' });
    }
  });

  app.post('/api/patrimonio/centros-custo', (req, res) => {
    try {
      const { codigo, nome, responsavel, orcamentoMensal, empresaId } = req.body;
      if (!nome || !codigo) {
        return res.status(400).json({ error: 'Código e nome são obrigatórios.' });
      }

      const novo = {
        id: `cc-${Date.now()}`,
        empresaId: empresaId || '1',
        codigo,
        nome,
        responsavel: responsavel || '',
        orcamentoMensal: Number(orcamentoMensal || 0),
        totalBensAlocados: 0,
        valorPatrimonioTotal: 0,
      };

      centrosCustoDb.push(novo);
      res.status(201).json(novo);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao cadastrar centro de custo.' });
    }
  });

  // =========================================================================
  // --- ROTAS: CONTABILIDADE, PLANO DE CONTAS, DRE, BALANÇO & ANÁLISES ---
  // =========================================================================

  // Plano de Contas
  app.get('/api/contabilidade/plano-contas', (req, res) => {
    try {
      res.json(planoContasDb);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao listar plano de contas.' });
    }
  });

  app.post('/api/contabilidade/plano-contas', (req, res) => {
    try {
      const { codigo, nome, tipo, natureza, grupo, grau, saldoAtual, vinculoPatrimonio } = req.body;
      if (!codigo || !nome || !grupo) {
        return res.status(400).json({ error: 'Código, nome e grupo são obrigatórios.' });
      }

      const nova = {
        id: `pc-${Date.now()}`,
        codigo,
        nome,
        tipo: tipo || 'analitica',
        natureza: natureza || 'devedora',
        grupo,
        grau: Number(grau || 4),
        saldoAtual: Number(saldoAtual || 0),
        vinculoPatrimonio: vinculoPatrimonio || 'nenhum',
      };

      planoContasDb.push(nova);
      planoContasDb.sort((a, b) => a.codigo.localeCompare(b.codigo));
      res.status(201).json(nova);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao criar conta contábil.' });
    }
  });

  // Balanço Patrimonial Dinâmico
  app.get(['/api/contabilidade/balanco', '/api/contabilidade/balanco/:empresaId'], (req, res) => {
    try {
      const empresaId = req.params.empresaId || (req.query.empresaId as string) || '1';
      const balanco = gerarBalancoPatrimonial(bensPatrimoniaisDb, empresaId);
      res.json(balanco);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao gerar Balanço Patrimonial.' });
    }
  });

  // DRE com EBITDA e Depreciação Integrada
  app.get(['/api/contabilidade/dre', '/api/contabilidade/dre/:empresaId'], (req, res) => {
    try {
      const empresaId = req.params.empresaId || (req.query.empresaId as string) || '1';
      const dre = gerarDre(bensPatrimoniaisDb, empresaId);
      res.json(dre);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao gerar DRE.' });
    }
  });

  // DFC (Demonstração dos Fluxos de Caixa)
  app.get(['/api/contabilidade/dfc', '/api/contabilidade/dfc/:empresaId'], (req, res) => {
    try {
      const empresaId = req.params.empresaId || (req.query.empresaId as string) || '1';
      const dre = gerarDre(bensPatrimoniaisDb, empresaId);
      const dfc = gerarDfc(dre, bensPatrimoniaisDb, empresaId);
      res.json(dfc);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao gerar DFC.' });
    }
  });

  // Indicadores e Análises Contábeis (Endividamento, Rentabilidade, Liquidez)
  app.get(['/api/contabilidade/analises', '/api/contabilidade/analises/:empresaId'], (req, res) => {
    try {
      const empresaId = req.params.empresaId || (req.query.empresaId as string) || '1';
      const bp = gerarBalancoPatrimonial(bensPatrimoniaisDb, empresaId);
      const dre = gerarDre(bensPatrimoniaisDb, empresaId);
      const indicadores = calcularIndicadoresContabeis(bp, dre);
      res.json({
        empresaId,
        indicadores,
        balanco: bp,
        dre,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erro ao calcular análises contábeis.' });
    }
  });

  // Error boundary for API: never expose stack traces or internal details.
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[API ERROR]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  // Vite Middleware Integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ContabGest SaaS Server em execução na porta ${PORT}`);
  });
}

startServer();
