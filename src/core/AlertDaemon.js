const EventEmitter = require('events');

class AlertDaemon extends EventEmitter {
  constructor(configStore, operviewClient, spotfireScraper, equipesBrasilClient, rulesEngine, routingResolver, whatsappClient) {
    super();
    this._store = configStore;
    this._operview = operviewClient;
    this._spotfire = spotfireScraper;
    this._equipesBrasil = equipesBrasilClient;
    this._engine = rulesEngine;
    this._router = routingResolver;
    this._whatsapp = whatsappClient;
    this._timer = null;
    this._isRunning = false;
  }

  start() {
    if (this._timer) return;
    const cfg = this._store.getConfig();
    const intervalMs = Math.max(1, Number(cfg.cycleMinutes || 3)) * 60 * 1000;

    this._store.addLog('INFO', `Iniciando RadarBot Daemon (ciclos a cada ${cfg.cycleMinutes || 3} min)...`);
    this.emit('log', `RadarBot Daemon iniciado.`);

    // Executa imediatamente o primeiro ciclo
    this.runCycle().catch((err) => {
      this._store.addLog('ERROR', `Erro no ciclo inicial: ${err.message}`);
    });

    this._timer = setInterval(() => {
      this.runCycle().catch((err) => {
        this._store.addLog('ERROR', `Erro no ciclo automático: ${err.message}`);
      });
    }, intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this._store.addLog('INFO', 'RadarBot Daemon pausado.');
      this.emit('log', 'RadarBot Daemon pausado.');
    }
  }

  async runCycle() {
    if (this._isRunning) return;
    this._isRunning = true;
    const cfg = this._store.getConfig();

    if (!cfg.robotActive) {
      this._isRunning = false;
      return;
    }

    const cycleStartTime = Date.now();
    this._cycleCount = (this._cycleCount || 0) + 1;

    try {
      this.emit('cycle:start');
      const polos = (Array.isArray(cfg.polos) && cfg.polos.length > 0) ? cfg.polos : ['ATLANTICO', 'DECEN', 'DNORT'];

      this._store.addLog('INFO', `▶ [Ciclo #${this._cycleCount}] Iniciando varredura | Polos: [${polos.join(', ')}]`);

      let totalIncidenciasGeral = 0;
      let totalAlertasDisparados = 0;

      for (const polo of polos) {
        // ── 1. FONTE: Operview DAPI ──
        let incidencias = [];
        try {
          const t0Operview = Date.now();
          incidencias = await this._operview.getIncidencias(polo);
          const elapsedOperview = Date.now() - t0Operview;

          if (incidencias.length > 0) {
            this._store.addLog('INFO', `[Operview DAPI] Polo ${polo}: ${incidencias.length} ocorrências recebidas (${elapsedOperview}ms).`);
          } else {
            this._store.addLog('INFO', `[Operview DAPI] Polo ${polo}: 0 ocorrências ativas encontradas (${elapsedOperview}ms).`);
          }
        } catch (err) {
          this._store.addLog('WARN', `[Operview DAPI] Erro ao consultar polo ${polo}: ${err.message}`);
          continue;
        }

        totalIncidenciasGeral += incidencias.length;
        if (!Array.isArray(incidencias) || incidencias.length === 0) continue;

        // ── 2. FONTE: Spotfire Web Player (M300 Deslocamentos) ──
        let deslocamentosM300 = [];
        if (this._spotfire && this._spotfire.isConfigured()) {
          try {
            const t0Spotfire = Date.now();
            deslocamentosM300 = await this._spotfire.getDeslocamentos(polo);
            const elapsedSpotfire = Date.now() - t0Spotfire;
            this._store.addLog('INFO', `[Spotfire M300] Polo ${polo}: ${deslocamentosM300.length} registros extraídos (${elapsedSpotfire}ms).`);
          } catch (m300Err) {
            this._store.addLog('WARN', `[Spotfire M300] Falha ao consultar polo ${polo}: ${m300Err.message}`);
          }
        } else {
          // Spotfire não configurado
        }

        // ── 3. FONTE: EquipesBrasilCE (Viaturas /cached + Incidentes) ──
        let teamsInfoMap = {};
        if (this._equipesBrasil && this._equipesBrasil.isConfigured()) {
          try {
            const t0Eb = Date.now();
            const ebData = await this._equipesBrasil.getEquipesPoloData(polo);
            const elapsedEb = Date.now() - t0Eb;

            // Enriquecer ocorrências com equipes, filiais, status do despacho e tempos
            const enrichedCount = await this._equipesBrasil.enrichIncidencias(incidencias, ebData);
            teamsInfoMap = ebData.teamsInfoMap || {};

            this._store.addLog(
              'INFO',
              `[EquipesBrasilCE] Polo ${polo}: ${ebData.poloVehicles?.length || 0} viaturas ativas no polo | ${enrichedCount} ocorrências vinculadas a equipes (${elapsedEb}ms).`
            );
          } catch (ebErr) {
            this._store.addLog('WARN', `[EquipesBrasilCE] Falha ao enriquecer equipes: ${ebErr.message}`);
          }
        }

        // ── 4. PROCESSAMENTO: Motor de Regras e Roteamento ──
        let criticalFoundPolo = 0;

        for (const inc of incidencias) {
          const matchedRules = this._engine.evaluateIncidence(inc, teamsInfoMap, deslocamentosM300);
          if (!matchedRules || matchedRules.length === 0) continue;

          for (const rule of matchedRules) {
            criticalFoundPolo++;

            // Anti-flood check (cooldown de 2h para a mesma ocorrência e regra)
            if (this._store.isAlertInCooldown(inc.ordem, rule.key, 120)) {
              this._store.addLog('INFO', `⏳ [Anti-Flood] Alerta suprimido para Inc. ${inc.ordem} (${rule.label}) — já disparado nas últimas 2h.`);
              continue;
            }

            const target = this._router.resolveTarget(rule.key, inc, rule.teamName || inc.equipe, teamsInfoMap);
            const msgText = this._engine.formatWhatsAppMessage(inc, matchedRules, target, deslocamentosM300, teamsInfoMap);

            this._store.addLog('ALERT', `🚨 [Diagnóstico] Gatilho "${rule.label}" | Inc. ${inc.ordem} (Base: ${inc.base || 'N/D'}) -> Destino: [${target.groupName}]`);

            // ── 5. FONTE: WhatsApp Automation (Despacho) ──
            const waStatus = this._whatsapp ? this._whatsapp.getStatus() : 'DISCONNECTED';

            if (cfg.whatsapp.autoSend && waStatus === 'READY') {
              try {
                this._store.addLog('INFO', `[WhatsApp Web] Despachando mensagem para [${target.groupName}]...`);
                await this._whatsapp.sendMessage(target.groupName, msgText, target.mentions);
                this._store.addLog('SUCCESS', `✅ [WhatsApp Web] Mensagem entregue com sucesso em [${target.groupName}] (Inc. ${inc.ordem})`);
                totalAlertasDisparados++;

                // Registra histórico apenas quando o envio tiver sucesso
                this._store.recordSentAlert({
                  tipo: rule.key,
                  incidencia: inc.ordem,
                  equipe: rule.teamName || inc.equipe || 'N/D',
                  base: inc.base || 'N/D',
                  group: target.groupName,
                  mentions: target.mentions,
                  preview: `${rule.label} - ${inc.ordem}`
                });

                this.emit('alert', { inc, rule, target });
              } catch (sendErr) {
                this._store.addLog('ERROR', `❌ [WhatsApp Web] Falha no envio para [${target.groupName}]: ${sendErr.message}`);
              }
            } else if (!cfg.whatsapp.autoSend) {
              this._store.addLog('INFO', `ℹ️ [WhatsApp Web] Disparo pausado (Auto-envio desativado no painel).`);
            } else {
              this._store.addLog('WARN', `⚠️ [WhatsApp Web] Não enviado: sessão desconectada (Status: ${waStatus}).`);
            }
          }
        }

        if (incidencias.length > 0) {
          this._store.addLog('INFO', `[Diagnóstico] Polo ${polo}: ${incidencias.length} ocorrências avaliadas nas 7 regras (${criticalFoundPolo} críticas detectadas).`);
        }
      }

      const cycleElapsedSec = ((Date.now() - cycleStartTime) / 1000).toFixed(1);
      this._store.addLog('INFO', `✔ [Ciclo #${this._cycleCount}] Varredura concluída em ${cycleElapsedSec}s (Total Ocorrências: ${totalIncidenciasGeral} | Alertas: ${totalAlertasDisparados}). Próximo ciclo em ${cfg.cycleMinutes || 3} min.`);
      this.emit('cycle:end');
    } finally {
      this._isRunning = false;
    }
  }
}

module.exports = AlertDaemon;

