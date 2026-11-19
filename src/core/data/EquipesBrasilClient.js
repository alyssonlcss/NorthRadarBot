const fs = require('fs');
const path = require('path');

class EquipesBrasilClient {
  constructor(authClient, polosFilePath) {
    this._auth = authClient;
    this._baseUrl = (process.env.EQUIPES_BRASILCE_API || '').replace(/\/$/, '');
    this._polosPath = polosFilePath || path.resolve(__dirname, '../../../polos.json');
    this._polosConfig = null;
    this._loadPolosConfig();
  }

  _loadPolosConfig() {
    try {
      if (fs.existsSync(this._polosPath)) {
        this._polosConfig = JSON.parse(fs.readFileSync(this._polosPath, 'utf8'));
      }
    } catch (err) {
      console.warn('[EquipesBrasilClient] Erro ao carregar polos.json:', err.message);
    }
  }

  isConfigured() {
    return Boolean(this._baseUrl);
  }

  async getVehiclesCached() {
    if (!this._baseUrl) return [];
    const token = await this._auth.getToken().catch(() => null);
    const url = `${this._baseUrl}/api/teams/vehicles/cached`;
    try {
      const headers = { Accept: 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json) ? json : (Array.isArray(json.vehicles) ? json.vehicles : []);
    } catch (err) {
      console.warn(`[EquipesBrasilClient] Erro ao buscar vehicles/cached: ${err.message}`);
      return [];
    }
  }

  async getIncidents() {
    if (!this._baseUrl) return [];
    const token = await this._auth.getToken().catch(() => null);
    const url = `${this._baseUrl}/api/incidents`;
    try {
      const headers = { Accept: 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json) ? json : (Array.isArray(json.incidents) ? json.incidents : []);
    } catch (err) {
      console.warn(`[EquipesBrasilClient] Erro ao buscar /incidents: ${err.message}`);
      return [];
    }
  }

  getTeamSubstringsForPolo(poloName) {
    if (!this._polosConfig || !Array.isArray(this._polosConfig.polos)) return [];
    const norm = String(poloName || '').trim().toUpperCase();
    const substrings = [];

    const polo = this._polosConfig.polos.find((p) => String(p.name).toUpperCase() === norm);
    if (polo && Array.isArray(polo.bases)) {
      for (const b of polo.bases) {
        if (Array.isArray(b.emergencyTeams)) substrings.push(...b.emergencyTeams);
        if (Array.isArray(b.otherTeams)) substrings.push(...b.otherTeams);
        if (Array.isArray(b.propria)) substrings.push(...b.propria);
        if (Array.isArray(b.parceira)) substrings.push(...b.parceira);
      }
    }
    return [...new Set(substrings.map((s) => String(s).trim()))].filter(Boolean);
  }

  /**
   * Obtém em paralelo os dados do EquipesBrasilCE (/cached + /incidents)
   * e monta mapas indexados para enriquecimento instantâneo do ciclo.
   */
  async getEquipesPoloData(poloName) {
    if (!this.isConfigured()) {
      return { poloVehicles: [], allVehicles: [], incidents: [], orderToVehicle: new Map(), teamsInfoMap: {} };
    }

    const [allVehicles, incidents] = await Promise.all([
      this.getVehiclesCached(),
      this.getIncidents()
    ]);

    const teamSubstrings = this.getTeamSubstringsForPolo(poloName);
    const poloVehicles = allVehicles.filter((v) => {
      if (!v.Team) return false;
      if (teamSubstrings.length === 0) return true;
      return teamSubstrings.some((sub) => String(v.Team).includes(sub));
    });

    const orderToVehicle = new Map();
    const teamsInfoMap = {};

    for (const v of allVehicles) {
      const teamName = String(v.Team || '').trim();
      if (!teamName) continue;

      let tempoNoStatus = '-';
      if (v.EstadoAgendaDesde) {
        const dt = new Date(v.EstadoAgendaDesde);
        if (!isNaN(dt.getTime())) {
          const diffMin = Math.max(0, Math.round((Date.now() - dt.getTime()) / 60000));
          const h = Math.floor(diffMin / 60);
          const m = diffMin % 60;
          tempoNoStatus = h > 0 ? `${h}h ${m}m` : `${m}m`;
        }
      }

      teamsInfoMap[teamName] = {
        team: teamName,
        filial: v.Filial || 'N/D',
        status: v.EstadoAgenda || 'Indefinido',
        statusDesde: v.EstadoAgendaDesde || null,
        tempoNoStatus,
        technician: v.Name || 'N/A',
        plate: v.Plate || 'N/A',
        shiftStart: v.ShiftStart || '-',
        shiftEnd: v.ShiftEnd || '-',
        scheduledStart: v.ScheduledStart || '-',
        etaArrival: v.EtaArrival || '-',
        etaMin: v.EtaMin || null,
        lat: v.Latitude,
        lng: v.Longitude,
        vehicleType: v.VehicleType || v.VehicleTypeTurno || null
      };

      const orders = [];
      if (v.Incident) orders.push(v.Incident);
      if (Array.isArray(v.Incidents)) orders.push(...v.Incidents);

      for (const ord of orders) {
        const raw = String(typeof ord === 'object' ? ord.ORDEM || ord.ordem : ord).trim();
        if (raw) {
          const norm = raw.replace(/^0+/, '');
          orderToVehicle.set(norm, v);
          orderToVehicle.set(raw, v);
        }
      }
    }

    return {
      poloVehicles,
      allVehicles,
      incidents,
      orderToVehicle,
      teamsInfoMap
    };
  }

  /**
   * Enriquece as incidências com os dados em tempo real do EquipesBrasilCE.
   * Utiliza tanto o cache em lote (/cached) quanto o endpoint detalhado (/api/teams/info/:equipe).
   */
  async enrichIncidencias(incidencias = [], poloData) {
    if (!Array.isArray(incidencias) || incidencias.length === 0 || !poloData) return 0;
    const { orderToVehicle, teamsInfoMap } = poloData;
    let count = 0;

    // 1. Identificar equipes de incidências que vieram do Operview e não estão em /cached
    const missingTeams = [];
    for (const inc of incidencias) {
      const eq = String(inc.equipe || '').trim();
      if (eq && eq !== '-' && eq !== '—' && !teamsInfoMap[eq]) {
        missingTeams.push(eq);
      }
    }

    // 2. Buscar equipes faltantes via /api/teams/info/:equipe (Batch)
    if (missingTeams.length > 0) {
      const uniqueMissing = [...new Set(missingTeams)];
      const fetchedInfos = await this.getTeamsInfoBatch(uniqueMissing);
      for (const [teamName, tInfo] of Object.entries(fetchedInfos)) {
        if (tInfo) {
          teamsInfoMap[teamName] = {
            team: teamName,
            filial: tInfo.filial || 'N/D',
            status: tInfo.incidents?.some((i) => i.status === 'No Local')
              ? 'en_lugar'
              : (tInfo.incidents?.length > 0 ? 'con_ordenes' : 'Indefinido'),
            technician: tInfo.technician || 'N/A',
            plate: tInfo.plate || 'N/A',
            shiftStart: tInfo.shift_actual || tInfo.shift_calendar || '-',
            shiftEnd: tInfo.shift_calendar_end || '-',
            vehicleType: tInfo.vehicle_type || null,
            incidents: tInfo.incidents || []
          };
        }
      }
    }

    for (const inc of incidencias) {
      const rawOrd = String(inc.ordem || '').trim();
      const normOrd = rawOrd.replace(/^0+/, '');

      const veh = (orderToVehicle && (orderToVehicle.get(normOrd) || orderToVehicle.get(rawOrd))) || null;

      if (veh) {
        count++;
        if (!inc.equipe || inc.equipe === '-' || inc.equipe === '—') {
          inc.equipe = veh.Team;
        }
        inc.filial = veh.Filial || inc.filial;
        inc.statusEquipe = veh.EstadoAgenda || inc.statusEquipe;
        inc.tecnico = veh.Name || inc.tecnico;
        inc.placa = veh.Plate || inc.placa;
        inc.shiftStart = veh.ShiftStart || inc.shiftStart;
        inc.shiftEnd = veh.ShiftEnd || inc.shiftEnd;
        inc.eta = veh.EtaArrival || inc.eta;

        if (veh.EstadoAgendaDesde) {
          const dt = new Date(veh.EstadoAgendaDesde);
          if (!isNaN(dt.getTime())) {
            const diffMin = Math.max(0, Math.round((Date.now() - dt.getTime()) / 60000));
            const h = Math.floor(diffMin / 60);
            const m = diffMin % 60;
            inc.tempoNoStatus = h > 0 ? `${h}h ${m}m` : `${m}m`;
          }
        }
      } else if (inc.equipe && teamsInfoMap && teamsInfoMap[inc.equipe]) {
        const tInfo = teamsInfoMap[inc.equipe];
        inc.filial = tInfo.filial || inc.filial;
        inc.statusEquipe = tInfo.status || inc.statusEquipe;
        inc.tempoNoStatus = tInfo.tempoNoStatus || inc.tempoNoStatus;
        inc.tecnico = tInfo.technician || inc.tecnico;
        inc.placa = tInfo.plate || inc.placa;
      }
    }
    return count;
  }

  async getTeamInfo(teamName) {
    if (!this._baseUrl || !teamName) return null;
    const token = await this._auth.getToken().catch(() => null);
    const url = `${this._baseUrl}/api/teams/info/${encodeURIComponent(teamName)}`;

    try {
      const headers = { Accept: 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) return null;
      const json = await res.json();
      return json.data || json;
    } catch (err) {
      console.warn(`[EquipesBrasilClient] Erro ao buscar dados da equipe ${teamName}: ${err.message}`);
      return null;
    }
  }

  async getTeamsInfoBatch(teamNames = []) {
    if (!this._baseUrl || !Array.isArray(teamNames) || teamNames.length === 0) return {};

    const results = {};
    const concurrency = 6;
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < teamNames.length) {
        const team = teamNames[currentIndex++];
        if (!team) continue;
        const info = await this.getTeamInfo(team);
        if (info) {
          results[team] = info;
        }
      }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }
}

module.exports = EquipesBrasilClient;
