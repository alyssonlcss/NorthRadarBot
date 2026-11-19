class RulesEngine {
  constructor(routingResolver, configStore) {
    this._router = routingResolver;
    this._store = configStore;
  }

  evaluateIncidence(inc, teamsInfoMap = {}, baseMetrics = {}) {
    const isDT = String(inc.ordem || '').toUpperCase().startsWith('DT');
    const matchedRules = [];

    // Parse duração em horas decimais (suporta HH:mm e formatos numéricos)
    const duracaoH = this._parseHours(inc.duracao);
    const clientes = Number(inc.clientes || 0);
    const chi = Number(inc.chi) > 0 ? Math.round(Number(inc.chi)) : Math.round(clientes * duracaoH);

    // Regra 1: Duração >= 18h
    if (!isDT && duracaoH >= 18) {
      matchedRules.push({
        key: 'duracao18h',
        label: 'Duração >= 18h',
        detail: `Duração acumulada de ${inc.duracao || duracaoH.toFixed(1) + 'h'} (limite: 18h)`
      });
    }

    // Regra 2: CHI >= 1000
    if (!isDT && chi >= 1000) {
      matchedRules.push({
        key: 'chi1000',
        label: 'Impacto CHI >= 1.000',
        detail: `CHI acumulado: ${chi.toLocaleString('pt-BR')} (limite: 1.000)`
      });
    }

    // Regra 3: Clientes >= 100
    if (!isDT && clientes >= 100) {
      matchedRules.push({
        key: 'clientes100',
        label: 'Clientes Afetados >= 100',
        detail: `${clientes} clientes sem energia (limite: 100)`
      });
    }

    // Regra 4: Previsão de Atendimento Expirada (Programada)
    if (this._isPrevisaoExpirada(inc)) {
      matchedRules.push({
        key: 'previsaoExpirada',
        label: 'Previsão de Atendimento Expirada',
        detail: `Previsão era para ${inc.previsao || inc.dataPrevisaoAtendimento || 'horário anterior'}`
      });
    }

    // Regra 5: SLA de 2º Recurso (> 5h ou >= 4h)
    const slaStatus = this._checkSla2Recurso(inc);
    if (slaStatus) {
      matchedRules.push({
        key: 'sla2Recurso',
        label: slaStatus.label,
        detail: slaStatus.detail
      });
    }

    // Regra 6: Inércia de Despacho (> 2h sem equipe)
    if (this._checkFaltaDespacho(inc, baseMetrics)) {
      matchedRules.push({
        key: 'faltaDespacho',
        label: 'Inércia de Despacho (> 2h sem equipe)',
        detail: `Mais de 2 horas sem equipe atribuída com alto impacto`
      });
    }

    // Regra 7: Estagnação de Equipe (> 2h no mesmo status)
    const teamStagnation = this._checkTeamStagnation(inc, teamsInfoMap);
    if (teamStagnation) {
      matchedRules.push({
        key: 'estagnacaoEquipe',
        label: 'Estagnação de Status da Equipe (> 2h)',
        teamName: teamStagnation.team,
        detail: `Equipe ${teamStagnation.team} parada em [${teamStagnation.status}] há ${teamStagnation.tempo}`
      });
    }

    return matchedRules;
  }

  buildConsolidatedDeslocamentos(inc, deslocamentosM300 = [], teamsInfoMap = {}) {
    const normInc = String(inc.ordem || inc.numero || '').replace(/^0+/, '');
    const teams = new Set();

    // 1. Equipe principal do Operview
    const mainTeam = inc.equipe || inc.equipeAtribuida || inc.equipeDeslocada || inc.recurso;
    if (mainTeam && mainTeam !== '-' && mainTeam !== '—') teams.add(mainTeam.trim().toUpperCase());

    // 2. Equipes do Spotfire M300
    for (const m of deslocamentosM300) {
      const mOrd = String(m.ordem || m.incidencia || '').replace(/^0+/, '');
      if (mOrd === normInc && m.equipe) teams.add(m.equipe.trim().toUpperCase());
    }

    // 3. Equipes do EquipesBrasilCE (cadastradas ou vinculadas à ordem)
    for (const [tName, info] of Object.entries(teamsInfoMap)) {
      if (!info) continue;
      const orders = Array.isArray(info.incidents) ? info.incidents : (info.all_active_orders || []);
      for (const ord of orders) {
        const ordNum = String(typeof ord === 'object' ? ord.ordem || ord.ORDEM || ord.order_number : ord).replace(/^0+/, '');
        if (ordNum === normInc) teams.add(tName.trim().toUpperCase());
      }
    }

    const rows = [];
    for (const teamId of teams) {
      const mRow = deslocamentosM300.find(m => {
        const mOrd = String(m.ordem || m.incidencia || '').replace(/^0+/, '');
        return mOrd === normInc && String(m.equipe || '').trim().toUpperCase() === teamId;
      }) || {};

      const tInfo = teamsInfoMap[teamId] || {};
      const orders = Array.isArray(tInfo.incidents) ? tInfo.incidents : (tInfo.all_active_orders || []);
      const bOrder = orders.find(ord => {
        const ordNum = String(typeof ord === 'object' ? ord.ordem || ord.ORDEM || ord.order_number : ord).replace(/^0+/, '');
        return ordNum === normInc;
      }) || {};

      const isSameResource = Boolean(mainTeam && mainTeam.toUpperCase() === teamId);

      const fmtTime = (isoStr) => {
        if (!isoStr || isoStr === '-' || isoStr === '—') return null;
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return String(isoStr).replace(/:\d{2}$/, '');
        return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      };

      // Fusão dos 4 estágios operacionais (M300 + EquipesBrasilCE + Operview)
      const acionada = bOrder.assigned_raw || bOrder.assigned || mRow.acionada || mRow.despachado ||
        (isSameResource && (inc.dataDesignacao || inc.dataAtribuicao)) || '-';

      let emDeslocamento = bOrder.dispatched_raw || bOrder.dispatched || bOrder.en_route_raw || mRow.em_deslocamento || mRow.emDeslocamento || mRow.aCaminho ||
        (isSameResource && inc.dataInicioDeslocamento) || '-';
      if ((emDeslocamento === '-' || emDeslocamento === '—') && (tInfo.status === 'desplazandose' || inc.statusEquipe === 'desplazandose') && tInfo.statusDesde) {
        emDeslocamento = fmtTime(tInfo.statusDesde) || '-';
      }

      let noLocal = bOrder.arrival_raw || bOrder.arrival || bOrder.on_site_raw || mRow.no_local || mRow.noLocal ||
        (isSameResource && inc.dataChegada) || '-';
      if ((noLocal === '-' || noLocal === '—') && (tInfo.status === 'en_lugar' || inc.statusEquipe === 'en_lugar') && tInfo.statusDesde) {
        noLocal = fmtTime(tInfo.statusDesde) || '-';
      }

      const liberada = bOrder.released_raw || bOrder.released || bOrder.field_complete_raw || mRow.liberada || '-';

      // Status descritivo consolidado
      let eqStatus = 'Sem Despacho';
      if (liberada !== '-' && liberada !== '—') {
        eqStatus = '✅ Concluída';
      } else if ((noLocal !== '-' && noLocal !== '—') || tInfo.status === 'en_lugar' || inc.statusEquipe === 'en_lugar') {
        eqStatus = '🛠️ No Local';
      } else if ((emDeslocamento !== '-' && emDeslocamento !== '—') || tInfo.status === 'desplazandose' || inc.statusEquipe === 'desplazandose') {
        eqStatus = '🚚 A Caminho';
      } else if ((acionada !== '-' && acionada !== '—') || tInfo.status === 'con_ordenes' || inc.statusEquipe === 'con_ordenes') {
        eqStatus = '📲 Atribuída';
      } else if (tInfo.status && tInfo.status !== 'Indefinido') {
        eqStatus = tInfo.status;
      }

      rows.push({
        equipe: teamId,
        filial: tInfo.filial || inc.filial || null,
        acionada,
        emDeslocamento,
        noLocal,
        liberada,
        eqStatus
      });
    }

    return rows;
  }

  formatWhatsAppMessage(inc, matchedRules = [], routeTarget = {}, deslocamentosM300 = [], teamsInfoMap = {}, clientesCriticos = []) {
    const RULE_HEADER_MAP = {
      clientes100: '*👥 AFETAÇÃO ELEVADA >= 100 🚨*',
      duracao18h: '*⏳ DURAÇÃO CRÍTICA >= 18H 🚨*',
      chi1000: '*⚡ IMPACTO CHI ELEVADO >= 1.000 🚨*',
      previsaoExpirada: '*⏰ PREVISÃO DE ATENDIMENTO EXPIRADA (PROGRAMADA) 🚨*',
      sla2Recurso: '*🚚 SLA DE 2º RECURSO EXPIRADO (> 5H) 🚨*',
      faltaDespacho: '*🚫 INÉRCIA DE DESPACHO (> 2H SEM EQUIPE) 🚨*',
      estagnacaoEquipe: '*🚧 ESTAGNAÇÃO DE STATUS DA EQUIPE (> 2H) ⚠️*'
    };

    // 1. Cabeçalhos das Regras Acionadas
    const headerLines = [];
    if (matchedRules.length > 0) {
      for (const r of matchedRules) {
        if (r.key === 'sla2Recurso') {
          headerLines.push(r.label && r.label.includes('Expirado') ? '*🚚 SLA DE 2º RECURSO EXPIRADO (> 5H) 🚨*' : '*🚚 ALERTA PREVENTIVO DE 2º RECURSO (>= 4H) ⚠️*');
        } else {
          headerLines.push(RULE_HEADER_MAP[r.key] || `*🚨 ${(r.label || 'ALERTA OPERACIONAL').toUpperCase()} 🚨*`);
        }
      }
      const estRule = matchedRules.find(r => r.key === 'estagnacaoEquipe');
      if (estRule && estRule.detail) {
        const cleanDesc = String(estRule.detail).replace(/^Equipe sem evolução de etapa há mais de 2h:\s*/i, '').replace(/\.$/, '');
        headerLines.push(`Equipe sem evolução: ${cleanDesc}`);
      }
    } else {
      headerLines.push('*📋 DIAGNÓSTICO OPERACIONAL 📋*');
    }

    // 2. Fusão Consolidada de Deslocamentos (M300 + EquipesBrasilCE)
    const desl = this.buildConsolidatedDeslocamentos(inc, deslocamentosM300, teamsInfoMap);

    const mainTeam = inc.equipe && inc.equipe !== '-' && inc.equipe !== '—' ? inc.equipe : 'Sem Despacho';
    const mainSt = inc.statusEquipe || 'Sem Despacho';

    const equipesSummary = desl.length > 0
      ? desl.map(r => `${r.equipe} (${r.eqStatus})`).join(', ')
      : (mainTeam !== 'Sem Despacho' ? `${mainTeam} (${mainSt})` : 'Sem equipe vinculada');

    const incNum = inc.ordem || inc.numero || '-';
    const nivelTensao = String(inc.tensao || inc.nivelTensao || '-').toUpperCase();
    const duracaoStr = inc.duracao || '-';
    const dataInicioFull = String(inc.dataInicio || inc.inicio || '-');
    const dataInicioShort = dataInicioFull.replace(/\/20\d{2}/, '').trim();
    const baseStr = String(inc.base || inc.sucursal || '-');
    const conjuntoStr = String(inc.conjunto || inc.base || '-');
    const clientesVal = inc.clientes != null ? inc.clientes : 0;
    const chiVal = inc.chi != null ? Math.round(Number(inc.chi)) : 0;

    // Bloco 1 (Resumo Imediato)
    const block1 = [
      headerLines.join('\n'),
      `Clientes: ${clientesVal} | CHI: ${chiVal}`,
      `INCIDÊNCIA: ${incNum} | ${nivelTensao}`,
      `DURAÇÃO: ${duracaoStr} | DATA DE INÍCIO: ${dataInicioShort}`,
      `BASE / CONJUNTO: ${baseStr} / ${conjuntoStr}`,
      `EQUIPES: ${equipesSummary}`
    ].join('\n');

    // Separador "Ler mais..." oficial do WhatsApp (Left-to-Right Mark repetido 3000x)
    const readMoreSeparator = '\n' + '\u200E'.repeat(3000) + '\n\n';

    // Bloco 2 (Dados Completos da Incidência)
    const block2Lines = [
      '📋 DADOS DA INCIDÊNCIA:',
      `DATA DE INÍCIO: ${dataInicioFull}`,
      `STATUS: ${inc.estado || inc.status || '-'}`,
      `PREVISÃO DE ATENDIMENTO: ${inc.previsao || inc.dataPrevisaoAtendimento || '-'}`,
      `POLO: ${inc.polo || '-'}`,
      `BASE / CONJUNTO: ${baseStr} / ${conjuntoStr}`,
      `ALIMENTADOR: ${inc.alimentador || '-'}`,
      `MUNICÍPIO: ${inc.local || inc.municipio || '-'}`,
      `NÍVEL TENSÃO: ${nivelTensao}`,
      `ATRIBUIÇÃO PRINCIPAL: ${mainTeam} (${mainSt})`,
      `TIPO DE RECLAMAÇÃO: ${inc.tipo || inc.tipoReclamacao || '-'}`,
      `CAUSA: ${inc.causa || '-'}`,
      `OBSERVAÇÃO: ${inc.observacao || inc.observacoes || '-'}`
    ];

    if (inc.notas) {
      block2Lines.push(`Notas: ${inc.notas}`);
    }

    if (Array.isArray(clientesCriticos) && clientesCriticos.length > 0) {
      block2Lines.push('');
      block2Lines.push('⚠️ CLIENTES CRÍTICOS COM AVISO:');
      for (const cli of clientesCriticos) {
        block2Lines.push(`- UC ${cli.uc || cli.numeroCliente || '-'}: ${cli.nome || cli.nomeCliente || 'Sem Nome'}${cli.aviso ? ` | Aviso: ${cli.aviso}` : ''}`);
      }
    }

    // Tabela Consolidada de Deslocamentos (M300 + EquipesBrasilCE)
    block2Lines.push('');
    block2Lines.push('🚚 DESLOCAMENTOS (M300 + EQUIPESBRASILCE):');
    if (desl.length > 0) {
      for (const row of desl) {
        block2Lines.push(`* ${row.equipe} (${row.eqStatus}): Acionada: ${row.acionada} | Desloc.: ${row.emDeslocamento} | No Local: ${row.noLocal} | Liberada: ${row.liberada}`);
      }
    } else {
      block2Lines.push('* Nenhuma equipe vinculada no M300 / EquipesBrasilCE.');
    }

    // Menções no rodapé (@contatos)
    const rawMentions = routeTarget.mentions || '';
    if (rawMentions) {
      const parts = rawMentions.split(/[,;\s]+/).map(p => p.trim().replace(/^@+/, '')).filter(Boolean);
      if (parts.length > 0) {
        block2Lines.push('');
        block2Lines.push(`*Cc:* ${parts.map(m => '@' + m).join(' ')}`);
      }
    }

    return block1 + readMoreSeparator + block2Lines.join('\n');
  }

  _parseHours(duracaoStr) {
    if (!duracaoStr || duracaoStr === '-' || duracaoStr === '—') return 0;
    const str = String(duracaoStr).trim();
    if (str.includes(':')) {
      const parts = str.split(':');
      const h = parseInt(parts[0], 10) || 0;
      const m = parseInt(parts[1], 10) || 0;
      return h + (m / 60);
    }
    const match = str.match(/([\d.]+)\s*h?/i);
    return match ? parseFloat(match[1]) : 0;
  }

  _isPrevisaoExpirada(inc) {
    const isProg = Boolean(inc.isProgramada) ||
      /PROGRAMAD/i.test(String(inc.tipo || inc.causa || inc.observacao || '')) ||
      /TRABALHO EM TENS/i.test(String(inc.tipo || ''));

    const prevStr = inc.previsao || inc.dataPrevisaoAtendimento;
    if (!isProg || !prevStr || prevStr === '-' || prevStr === '—') return false;

    const parts = String(prevStr).split(/[\s/:]+/);
    if (parts.length >= 5) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      let year = parseInt(parts[2], 10);
      if (year < 100) year += 2000;
      const hour = parseInt(parts[3], 10);
      const min = parseInt(parts[4], 10);
      const sec = parts.length > 5 ? parseInt(parts[5], 10) : 0;
      const dt = new Date(year, month, day, hour, min, sec);
      return !isNaN(dt.getTime()) && dt.getTime() < Date.now();
    }
    return false;
  }

  _checkSla2Recurso(inc) {
    if (!inc.segundoRecursoSolicitadoEm) return null;
    const elapsedMinutes = (Date.now() - new Date(inc.segundoRecursoSolicitadoEm).getTime()) / 60000;
    if (elapsedMinutes >= 300) {
      return { label: 'SLA de 2º Recurso Expirado (> 5h)', detail: `${Math.round(elapsedMinutes / 60)}h desde a solicitação sem atendimento` };
    }
    if (elapsedMinutes >= 240) {
      return { label: 'SLA de 2º Recurso em Alerta (>= 4h)', detail: `Atingiu 4h de espera sem confirmação` };
    }
    return null;
  }

  _checkFaltaDespacho(inc, baseMetrics = {}) {
    const duracaoH = this._parseHours(inc.duracao);
    const eq = inc.equipe && inc.equipe !== '-' && inc.equipe !== '—' ? inc.equipe.trim() : '';
    if (duracaoH < 2 || eq) return false;

    const clientes = Number(inc.clientes || 0);
    const isMT = String(inc.tensao || '').toUpperCase().includes('MT');
    if (clientes >= 100) return true;
    if (isMT && duracaoH >= 2) return true;
    if (clientes >= 50 && (baseMetrics.indicePorEquipe || 0) <= 5.5) return true;
    return false;
  }

  _checkTeamStagnation(inc, teamsInfoMap = {}) {
    if (!inc.equipe || inc.equipe === '-' || inc.equipe === '—') return null;
    const tInfo = teamsInfoMap[inc.equipe] || {};
    const tempoStr = inc.tempoNoStatus || tInfo.tempoNoStatus;
    const status = inc.statusEquipe || tInfo.status || 'Em atendimento';

    // Se o status da equipe for >= 2h (ex: '2h 15m' ou '3h')
    if (tempoStr && (tempoStr.includes('2h') || tempoStr.includes('3h') || tempoStr.includes('4h') || tempoStr.includes('5h') || tempoStr.includes('6h'))) {
      return {
        team: inc.equipe,
        status,
        tempo: tempoStr
      };
    }
    return null;
  }
}

module.exports = RulesEngine;

