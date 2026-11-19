const path = require('path');
const fs = require('fs');

class RoutingResolver {
  constructor(configStore, polosFilePath) {
    this._store = configStore;
    this._polosPath = polosFilePath || path.resolve(__dirname, '../../../polos.json');
    this._polosData = null;
    this._loadPolosConfig();
  }

  _loadPolosConfig() {
    try {
      if (fs.existsSync(this._polosPath)) {
        this._polosData = JSON.parse(fs.readFileSync(this._polosPath, 'utf8'));
      }
    } catch (err) {
      console.warn('[RoutingResolver] Não foi possível carregar polos.json:', err.message);
    }
  }

  detectTeamTypeAndEmpresa(teamName, filialStr, keywords = {}) {
    const normTeam = String(teamName || '').trim().toUpperCase();

    // 1. Verificação nos prefixos e bases do polos.json (compatibilidade NorthRadar)
    if (this._polosData && Array.isArray(this._polosData.polos)) {
      for (const polo of this._polosData.polos) {
        for (const base of (polo.bases || [])) {
          for (const parcPref of (base.parceira || [])) {
            const p = String(parcPref || '').trim().toUpperCase();
            if (p && normTeam.startsWith(p)) {
              return { teamType: 'PARCEIRA', empresa: 'PARCEIRA', base: base.name, polo: polo.name };
            }
          }
          for (const propPref of (base.propria || [])) {
            const pr = String(propPref || '').trim().toUpperCase();
            if (pr && normTeam.startsWith(pr)) {
              return { teamType: 'PROPRIA', empresa: 'PROPRIA', base: base.name, polo: polo.name };
            }
          }
        }
      }
    }

    const propriaKeywords = keywords.propria || ['ENEL'];
    const parceirasKeywords = keywords.parceiras || ['BeQ', 'Applus'];
    const filialNorm = String(filialStr || '').trim().toUpperCase();

    // 2. Verificação por palavra-chave na filial
    for (const kw of propriaKeywords) {
      if (filialNorm.includes(kw.toUpperCase())) {
        return { teamType: 'PROPRIA', empresa: 'PROPRIA' };
      }
    }

    for (const kw of parceirasKeywords) {
      if (filialNorm.includes(kw.toUpperCase())) {
        return { teamType: 'PARCEIRA', empresa: kw };
      }
    }

    // 3. Descoberta dinâmica pelo prefixo da filial (ex: "Sirtec - Norte")
    if (filialStr && filialStr.includes('-')) {
      const discovered = filialStr.split('-')[0].trim();
      if (discovered && !propriaKeywords.some((p) => discovered.toUpperCase().includes(p.toUpperCase()))) {
        return { teamType: 'PARCEIRA', empresa: discovered };
      }
    }

    // 4. Fallback pelo padrão de nome da equipe (ex: -RD- vs -SG-)
    if (normTeam.includes('-RD-') || normTeam.includes('_RD_')) {
      return { teamType: 'PARCEIRA', empresa: 'Parceira RD' };
    }
    return { teamType: 'PROPRIA', empresa: 'PROPRIA' };
  }

  resolveBaseByAlimentador(alimentador) {
    if (!alimentador || !this._polosData || !Array.isArray(this._polosData.polos)) return null;
    const norm = String(alimentador).trim().toUpperCase();
    for (const polo of this._polosData.polos) {
      for (const base of (polo.bases || [])) {
        if ((base.alimentadores || []).some((a) => String(a).trim().toUpperCase() === norm)) {
          return { base: base.name, polo: polo.name };
        }
      }
    }
    return null;
  }

  resolveTarget(ruleKey, incData, teamName, teamsInfoMap = {}) {
    const cfg = this._store.getConfig();
    const wa = cfg.whatsapp || {};
    const defaultGroup = wa.groupName || 'Alertas Operacionais COI';

    // Regras 1 a 6: Incidências
    if (ruleKey !== 'estagnacaoEquipe') {
      const specificGroup = wa.ruleGroups && wa.ruleGroups[ruleKey] ? wa.ruleGroups[ruleKey].trim() : '';
      const mentions = wa.mentionsByRule && wa.mentionsByRule[ruleKey] ? wa.mentionsByRule[ruleKey].trim() : '';
      return {
        groupName: specificGroup || defaultGroup,
        mentions: mentions || '',
        ruleType: 'INCIDENCIA'
      };
    }

    // Regra 7: Estagnação de Equipe (Roteamento Hierárquico)
    const teamInfo = teamsInfoMap[teamName] || {};
    const filial = teamInfo.filial || '';
    const detected = this.detectTeamTypeAndEmpresa(teamName, filial, cfg.keywords);

    let base = incData.base || teamInfo.base || detected.base;
    if (!base || base === 'N/D' || base === 'TODAS') {
      const fromAlim = this.resolveBaseByAlimentador(incData.alimentador);
      if (fromAlim) base = fromAlim.base;
    }
    base = base || 'TODAS';

    const polo = incData.polo || teamInfo.polo || detected.polo || 'TODOS';

    const teamRoutes = Array.isArray(wa.teamRouting) ? wa.teamRouting : [];
    let bestMatch = null;
    let highestScore = -1;

    for (const r of teamRoutes) {
      let score = 0;

      // Base
      if (r.base && r.base !== 'TODAS') {
        if (r.base.toUpperCase() === base.toUpperCase()) {
          score += 100;
        } else {
          continue; // Não casa com a base
        }
      }

      // Empresa Parceira específica
      if (r.empresa && r.empresa !== 'TODAS') {
        if (detected.empresa && r.empresa.toUpperCase() === detected.empresa.toUpperCase()) {
          score += 50;
        } else {
          continue; // Não casa com a empresa
        }
      }

      // Tipo de Equipe
      if (r.teamType && r.teamType !== 'TODAS') {
        if (r.teamType.toUpperCase() === detected.teamType.toUpperCase()) {
          score += 20;
        } else {
          continue;
        }
      }

      // Polo
      if (r.polo && r.polo !== 'TODOS') {
        if (r.polo.toUpperCase() === polo.toUpperCase()) {
          score += 10;
        } else {
          continue;
        }
      }

      if (score > highestScore) {
        highestScore = score;
        bestMatch = r;
      }
    }

    if (bestMatch) {
      return {
        groupName: bestMatch.groupName || defaultGroup,
        mentions: bestMatch.mentions || '',
        teamType: detected.teamType,
        empresa: detected.empresa,
        matchedRule: bestMatch,
        ruleType: 'EQUIPE_ROUTED'
      };
    }

    // Fallback da Regra 7
    const fallbackMentions = wa.mentionsByRule && wa.mentionsByRule.estagnacaoEquipe ? wa.mentionsByRule.estagnacaoEquipe.trim() : '';
    const fallbackGroup = wa.ruleGroups && wa.ruleGroups.estagnacaoEquipe ? wa.ruleGroups.estagnacaoEquipe.trim() : '';

    return {
      groupName: fallbackGroup || defaultGroup,
      mentions: fallbackMentions || '',
      teamType: detected.teamType,
      empresa: detected.empresa,
      ruleType: 'EQUIPE_FALLBACK'
    };
  }
}

module.exports = RoutingResolver;

