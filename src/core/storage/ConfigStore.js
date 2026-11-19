const fs = require('fs');
const path = require('path');
const os = require('os');

class ConfigStore {
  constructor(appDataPath) {
    this._dir = appDataPath || path.join(os.homedir(), '.northradar-bot');
    this._configFile = path.join(this._dir, 'config.json');
    this._historyFile = path.join(this._dir, 'history.json');
    this._init();
  }

  _init() {
    try {
      if (!fs.existsSync(this._dir)) {
        fs.mkdirSync(this._dir, { recursive: true });
      }
      if (!fs.existsSync(this._configFile)) {
        fs.writeFileSync(this._configFile, JSON.stringify(this._defaultConfig(), null, 2), 'utf8');
      }
      if (!fs.existsSync(this._historyFile)) {
        fs.writeFileSync(this._historyFile, JSON.stringify({ sentAlerts: [], logs: [] }, null, 2), 'utf8');
      }
    } catch (err) {
      console.error('[ConfigStore] Falha ao inicializar armazenamento local:', err);
    }
  }

  _defaultConfig() {
    return {
      robotActive: true,
      cycleMinutes: Number(process.env.CYCLE_MINUTES || 3),
      polos: (process.env.SPOTFIRE_POLOS || 'ATLANTICO,DECEN,DNORT').split(',').map((p) => p.trim()),
      whatsapp: {
        autoSend: process.env.WHATSAPP_AUTO_SEND !== 'false',
        groupName: process.env.WHATSAPP_DEFAULT_GROUP || 'Alertas Operacionais COI',
        mentionsByRule: {
          duracao18h: '',
          chi1000: '',
          clientes100: '',
          previsaoExpirada: '',
          sla2Recurso: '',
          faltaDespacho: '',
          estagnacaoEquipe: ''
        },
        ruleGroups: {
          duracao18h: '',
          chi1000: '',
          clientes100: '',
          previsaoExpirada: '',
          sla2Recurso: '',
          faltaDespacho: '',
          estagnacaoEquipe: ''
        },
        teamRouting: []
      },
      keywords: {
        propria: (process.env.PROPRIA_FILIAL_KEYWORDS || 'ENEL').split(',').map((k) => k.trim()),
        parceiras: (process.env.PARCEIRAS_FILIAL_KEYWORDS || 'BeQ,Applus').split(',').map((k) => k.trim())
      }
    };
  }

  getConfig() {
    try {
      const data = fs.readFileSync(this._configFile, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      return this._defaultConfig();
    }
  }

  saveConfig(newConfig) {
    try {
      const current = this.getConfig();
      const merged = {
        ...current,
        ...newConfig,
        polos: Array.isArray(newConfig.polos) ? newConfig.polos : (current.polos || ['ATLANTICO', 'DECEN', 'DNORT']),
        whatsapp: {
          ...(current.whatsapp || {}),
          ...(newConfig.whatsapp || {}),
          ruleGroups: {
            ...((current.whatsapp && current.whatsapp.ruleGroups) || {}),
            ...((newConfig.whatsapp && newConfig.whatsapp.ruleGroups) || {})
          },
          mentionsByRule: {
            ...((current.whatsapp && current.whatsapp.mentionsByRule) || {}),
            ...((newConfig.whatsapp && newConfig.whatsapp.mentionsByRule) || {})
          }
        }
      };
      fs.writeFileSync(this._configFile, JSON.stringify(merged, null, 2), 'utf8');
      return merged;
    } catch (err) {
      console.error('[ConfigStore] Falha ao salvar configurações:', err);
      throw err;
    }
  }

  getHistory() {
    try {
      const data = fs.readFileSync(this._historyFile, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      return { sentAlerts: [], logs: [] };
    }
  }

  recordSentAlert(alertEntry) {
    try {
      const hist = this.getHistory();
      hist.sentAlerts = hist.sentAlerts || [];
      hist.sentAlerts.unshift({
        id: alertEntry.id || Date.now().toString(),
        timestamp: new Date().toISOString(),
        tipo: alertEntry.tipo,
        incidencia: alertEntry.incidencia,
        equipe: alertEntry.equipe,
        base: alertEntry.base,
        group: alertEntry.group,
        mentions: alertEntry.mentions,
        preview: alertEntry.preview || ''
      });
      // Mantém últimos 500 alertas
      if (hist.sentAlerts.length > 500) {
        hist.sentAlerts = hist.sentAlerts.slice(0, 500);
      }
      fs.writeFileSync(this._historyFile, JSON.stringify(hist, null, 2), 'utf8');
    } catch (err) {
      console.error('[ConfigStore] Erro ao registrar alerta:', err);
    }
  }

  isAlertInCooldown(incidencia, ruleKey, cooldownMinutes = 120) {
    try {
      const hist = this.getHistory();
      const cutoff = Date.now() - (cooldownMinutes * 60 * 1000);
      return (hist.sentAlerts || []).some((a) => {
        return a.incidencia === incidencia &&
          a.tipo === ruleKey &&
          new Date(a.timestamp).getTime() > cutoff;
      });
    } catch (err) {
      return false;
    }
  }

  addLog(level, message) {
    try {
      const hist = this.getHistory();
      hist.logs = hist.logs || [];
      hist.logs.unshift({
        timestamp: new Date().toLocaleTimeString('pt-BR'),
        level: level || 'INFO',
        message
      });
      if (hist.logs.length > 300) {
        hist.logs = hist.logs.slice(0, 300);
      }
      fs.writeFileSync(this._historyFile, JSON.stringify(hist, null, 2), 'utf8');
    } catch (err) {
      console.error('[ConfigStore] Erro ao gravar log:', err);
    }
  }
}

module.exports = ConfigStore;

