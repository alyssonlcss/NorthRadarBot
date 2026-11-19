const path = require('path');
const fs = require('fs');

let _polosCache = null;
function resolveBaseFromAlim(alim) {
  if (!alim) return '';
  if (!_polosCache) {
    try {
      const p = path.resolve(__dirname, '../../../polos.json');
      if (fs.existsSync(p)) _polosCache = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {}
  }
  if (!_polosCache || !Array.isArray(_polosCache.polos)) return '';
  const norm = String(alim).trim().toUpperCase();
  for (const polo of _polosCache.polos) {
    for (const base of (polo.bases || [])) {
      if ((base.alimentadores || []).some((a) => String(a).trim().toUpperCase() === norm)) {
        return base.name;
      }
    }
  }
  return '';
}

class OperviewApiClient {
  constructor(authClient) {
    this._auth = authClient;
    this._baseUrl = (process.env.OPERVIEW_API_URL || process.env.OPENVIEW_DOMAIN_API || 'https://operview-ce-dapi.enel.com').replace(/\/$/, '');
  }

  async getIncidencias(polo = 'ATLANTICO') {
    const token = await this._auth.getToken();
    const today = new Date();
    // Consulta ocorrências das últimas 24 horas
    const startDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const dateStr = startDate.toISOString().slice(0, 10) + ' 00:00:00';
    const url = `${this._baseUrl}/incidencias/consultar?colNumOrder=0&orderAsc=true&skip=0&take=5000&dataInicio=${encodeURIComponent(dateStr)}&polos=${encodeURIComponent(polo)}&estados=ACTIVO,PROGRAMADO`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'NorthRadarBot-Desktop/1.0'
      }
    });

    if (!res.ok) {
      if (res.status === 401) {
        // Token expirado - limpa e tenta mais uma vez
        await this._auth.authenticate();
        return this.getIncidencias(polo);
      }
      throw new Error(`Erro na API Operview (${res.status}): ${res.statusText}`);
    }

    const json = await res.json();
    const rawList = Array.isArray(json) ? json : (json.itens || json.data || json.items || []);

    return rawList.map((item) => {
      let alim = item.alimentador ? String(item.alimentador).trim() : '';
      if (!alim && item.observacao) {
        const match = String(item.observacao).match(/ALIMENTADOR:\s*([A-Z0-9]+)/i);
        if (match) alim = match[1].trim().toUpperCase();
      }

      let base = (item.sucursal || item.regiao || item.base || '').trim();
      if (!base && alim) {
        base = resolveBaseFromAlim(alim);
      }

      return {
        ...item,
        ordem: item.numero || item.ordem || '',
        base: base || 'N/D',
        polo: item.polo || polo,
        tipo: item.tipo || item.nivelTensaoComTipo || item.nivelTensao || '',
        tensao: item.nivelTensao || '',
        duracao: item.duracao || '',
        chi: Number(item.conh || item.chi || 0),
        clientes: Number(item.clientesAfetadosAtual ?? item.afetacaoMaxima ?? item.clientes ?? 0),
        equipe: item.equipeAtribuida || item.equipeDeslocada || item.equipe || '',
        statusEquipe: item.estado || '',
        previsao: item.dataPrevisaoAtendimento || '',
        isProgramada: String(item.tipo || '').toUpperCase().includes('PROGRAMAD'),
        alimentador: alim,
        municipio: item.municipio || '',
        local: item.municipio ? `${item.municipio} - ${item.conjunto || ''}` : (item.observacao || '')
      };
    });
  }

  async getTeamsInfoBatch(teamNames = []) {
    if (!teamNames || teamNames.length === 0) return {};
    const token = await this._auth.getToken();
    const url = `${this._baseUrl}/api/equipes/batch`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ teams: teamNames })
      });
      if (res.ok) {
        const json = await res.json();
        return json.data || json || {};
      }
    } catch {
      // Fallback gracioso se a rota batch não existir no DAPI direto
    }
    return {};
  }
}

module.exports = OperviewApiClient;

