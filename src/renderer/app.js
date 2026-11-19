const { ipcRenderer } = require('electron');

let currentConfig = {};
let currentHistory = { sentAlerts: [], logs: [] };

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupEventListeners();
  await refreshState();

  // Escuta atualizações vindas do processo principal
  ipcRenderer.on('whatsapp:status', (event, { status, qr }) => {
    updateWhatsAppStatus(status, qr);
  });

  ipcRenderer.on('whatsapp:qr', (event, qr) => {
    updateQrCode(qr);
  });

  ipcRenderer.on('alert:new', async () => {
    await refreshState();
  });

  ipcRenderer.on('config:updated', async () => {
    await refreshState();
  });

  // Atualiza logs e métricas periodicamente
  setInterval(refreshState, 5000);
});

function setupTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('active'));

      tab.classList.add('active');
      const targetId = `view-${tab.dataset.tab}`;
      const targetView = document.getElementById(targetId);
      if (targetView) targetView.classList.add('active');
    });
  });
}

function setupEventListeners() {
  // Toggle Empresa parceira input se o tipo for PARCEIRA
  const selRouteType = document.getElementById('selRouteType');
  const divRouteEmpresa = document.getElementById('divRouteEmpresa');
  selRouteType.addEventListener('change', () => {
    divRouteEmpresa.style.display = selRouteType.value === 'PARCEIRA' ? 'block' : 'none';
  });

  // Botão Adicionar Regra
  document.getElementById('btnAddRoute').addEventListener('click', async () => {
    const base = document.getElementById('selRouteBase').value;
    const teamType = document.getElementById('selRouteType').value;
    const empresa = document.getElementById('inputRouteEmpresa').value.trim() || 'TODAS';
    const groupName = document.getElementById('inputRouteGroup').value.trim();
    const mentions = document.getElementById('inputRouteMentions').value.trim();

    currentConfig.whatsapp = currentConfig.whatsapp || {};
    currentConfig.whatsapp.teamRouting = currentConfig.whatsapp.teamRouting || [];

    currentConfig.whatsapp.teamRouting.push({
      polo: 'TODOS',
      base,
      teamType,
      empresa: teamType === 'PARCEIRA' ? empresa : 'TODAS',
      groupName,
      mentions
    });

    await ipcRenderer.invoke('save-config', currentConfig);
    renderRoutesTable();
    // Limpa campos
    document.getElementById('inputRouteEmpresa').value = '';
    document.getElementById('inputRouteGroup').value = '';
    document.getElementById('inputRouteMentions').value = '';
  });

  // Salvar Polos Monitorados
  async function saveSelectedPolos(showFeedback = true) {
    const selected = [];
    if (document.getElementById('chkPoloAtlantico')?.checked) selected.push('ATLANTICO');
    if (document.getElementById('chkPoloDecen')?.checked) selected.push('DECEN');
    if (document.getElementById('chkPoloDnort')?.checked) selected.push('DNORT');

    if (selected.length === 0) {
      alert('Selecione pelo menos um polo operacional para monitoramento.');
      const atl = document.getElementById('chkPoloAtlantico');
      if (atl) atl.checked = true;
      selected.push('ATLANTICO');
    }

    currentConfig.polos = selected;
    await ipcRenderer.invoke('save-config', currentConfig);

    if (showFeedback) {
      const btn = document.getElementById('btnSavePolos');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✅ Polos Salvos!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    }
    renderMetrics();
  }

  const btnSavePolos = document.getElementById('btnSavePolos');
  if (btnSavePolos) {
    btnSavePolos.addEventListener('click', () => saveSelectedPolos(true));
  }

  ['chkPoloAtlantico', 'chkPoloDecen', 'chkPoloDnort'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => saveSelectedPolos(false));
    }
  });

  // Detecta quando o usuário está editando qualquer campo de configuração para não sobrescrever
  const viewRouting = document.getElementById('view-routing');
  if (viewRouting) {
    viewRouting.addEventListener('input', () => {
      userHasUnsavedEdits = true;
    });
  }

  // Salvar Grupo Padrão
  document.getElementById('btnSaveGroup').addEventListener('click', async () => {
    const groupName = document.getElementById('inputDefaultGroup').value.trim();
    currentConfig.whatsapp = currentConfig.whatsapp || {};
    currentConfig.whatsapp.groupName = groupName;
    await ipcRenderer.invoke('save-config', currentConfig);
    userHasUnsavedEdits = false;
    const btn = document.getElementById('btnSaveGroup');
    const orig = btn.textContent;
    btn.textContent = '✅ Grupo Salvo!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });

  // Salvar Destinos por Regra de Alerta (Regras 1 a 6)
  const btnSaveRuleGroups = document.getElementById('btnSaveRuleGroups');
  if (btnSaveRuleGroups) {
    btnSaveRuleGroups.addEventListener('click', async () => {
      const ruleKeys = ['duracao18h', 'chi1000', 'clientes100', 'previsaoExpirada', 'sla2Recurso', 'faltaDespacho'];
      currentConfig.whatsapp = currentConfig.whatsapp || {};
      currentConfig.whatsapp.ruleGroups = currentConfig.whatsapp.ruleGroups || {};
      currentConfig.whatsapp.mentionsByRule = currentConfig.whatsapp.mentionsByRule || {};

      ruleKeys.forEach((key) => {
        const inputG = document.getElementById(`ruleGroup_${key}`);
        const inputM = document.getElementById(`ruleMention_${key}`);
        if (inputG) currentConfig.whatsapp.ruleGroups[key] = inputG.value.trim();
        if (inputM) currentConfig.whatsapp.mentionsByRule[key] = inputM.value.trim();
      });

      await ipcRenderer.invoke('save-config', currentConfig);
      userHasUnsavedEdits = false;
      const origText = btnSaveRuleGroups.textContent;
      btnSaveRuleGroups.textContent = '✅ Destinos Salvos!';
      setTimeout(() => { btnSaveRuleGroups.textContent = origText; }, 2000);
    });
  }

  // Checkbox Envio Automático
  document.getElementById('chkAutoSend').addEventListener('change', async (e) => {
    currentConfig.whatsapp = currentConfig.whatsapp || {};
    currentConfig.whatsapp.autoSend = e.target.checked;
    await ipcRenderer.invoke('save-config', currentConfig);
  });

  // Botão Varredura Imediata
  document.getElementById('btnRunNow').addEventListener('click', async () => {
    const btn = document.getElementById('btnRunNow');
    btn.textContent = '⏳ Executando...';
    btn.disabled = true;
    try {
      await ipcRenderer.invoke('trigger-cycle-now');
    } finally {
      setTimeout(() => {
        btn.textContent = '⚡ Varredura Agora';
        btn.disabled = false;
        refreshState();
      }, 2000);
    }
  });

  // Reconectar WhatsApp
  document.getElementById('btnReconnectWa').addEventListener('click', async () => {
    const btn = document.getElementById('btnReconnectWa');
    btn.textContent = '⏳ Reiniciando sessão...';
    btn.disabled = true;
    try {
      await ipcRenderer.invoke('reconnect-whatsapp');
    } finally {
      btn.textContent = '🔄 Reconectar / Trocar WhatsApp';
      btn.disabled = false;
    }
  });

  // Copiar Todos os Logs para Clipboard
  const btnCopyLogs = document.getElementById('btnCopyLogs');
  if (btnCopyLogs) {
    btnCopyLogs.addEventListener('click', async () => {
      const logs = currentHistory.logs || [];
      if (logs.length === 0) {
        alert('Não há logs para copiar no momento.');
        return;
      }
      const plainText = logs.map((l) => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
      try {
        await navigator.clipboard.writeText(plainText);
        const orig = btnCopyLogs.textContent;
        btnCopyLogs.textContent = '✅ Copiado com Sucesso!';
        setTimeout(() => { btnCopyLogs.textContent = orig; }, 2000);
      } catch (err) {
        // Fallback seguro de cópia
        const ta = document.createElement('textarea');
        ta.value = plainText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btnCopyLogs.textContent = '✅ Copiado com Sucesso!';
        setTimeout(() => { btnCopyLogs.textContent = '📋 Copiar Todos os Logs'; }, 2000);
      }
    });
  }

  // Limpar Tela de Logs
  const btnClearLogs = document.getElementById('btnClearLogs');
  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', () => {
      currentHistory.logs = [];
      renderConsoleLogs();
    });
  }
}

let isFormInitialized = false;
let userHasUnsavedEdits = false;

function populateFormInputs(config, force = false) {
  if (userHasUnsavedEdits && !force) return;

  const polos = config.polos || ['ATLANTICO', 'DECEN', 'DNORT'];
  const chkAtl = document.getElementById('chkPoloAtlantico');
  const chkDec = document.getElementById('chkPoloDecen');
  const chkDno = document.getElementById('chkPoloDnort');
  if (chkAtl) chkAtl.checked = polos.includes('ATLANTICO');
  if (chkDec) chkDec.checked = polos.includes('DECEN');
  if (chkDno) chkDno.checked = polos.includes('DNORT');

  const inputDefaultGroup = document.getElementById('inputDefaultGroup');
  if (inputDefaultGroup && config.whatsapp) {
    inputDefaultGroup.value = config.whatsapp.groupName || '';
  }

  const chkAutoSend = document.getElementById('chkAutoSend');
  if (chkAutoSend && config.whatsapp) {
    chkAutoSend.checked = config.whatsapp.autoSend !== false;
  }

  const ruleKeys = ['duracao18h', 'chi1000', 'clientes100', 'previsaoExpirada', 'sla2Recurso', 'faltaDespacho'];
  const ruleGroups = (config.whatsapp && config.whatsapp.ruleGroups) || {};
  const mentionsByRule = (config.whatsapp && config.whatsapp.mentionsByRule) || {};

  ruleKeys.forEach((key) => {
    const inputG = document.getElementById(`ruleGroup_${key}`);
    const inputM = document.getElementById(`ruleMention_${key}`);
    if (inputG) inputG.value = ruleGroups[key] || '';
    if (inputM) inputM.value = mentionsByRule[key] || '';
  });
}

async function refreshState() {
  const state = await ipcRenderer.invoke('get-state');
  currentConfig = state.config || {};
  currentHistory = state.history || { sentAlerts: [], logs: [] };

  renderHeaderStatus(state.whatsappStatus);
  if (state.qrCode && state.whatsappStatus === 'AWAITING_QR') {
    updateQrCode(state.qrCode);
  }
  renderMetrics();
  renderHistoryTable();
  renderRoutesTable();
  renderConsoleLogs();

  // Inicializa os campos do formulário apenas na primeira carga
  if (!isFormInitialized) {
    populateFormInputs(currentConfig);
    isFormInitialized = true;
  }
}

function renderHeaderStatus(waStatus) {
  const robotDot = document.getElementById('robotStatusDot');
  const robotText = document.getElementById('robotStatusText');
  const isRobotActive = currentConfig.robotActive !== false;

  if (isRobotActive) {
    robotDot.className = 'status-dot on';
    robotText.textContent = 'Robô Ativo';
  } else {
    robotDot.className = 'status-dot warn';
    robotText.textContent = 'Robô Pausado';
  }

  const waDot = document.getElementById('waStatusDot');
  const waText = document.getElementById('waStatusText');

  if (waStatus === 'READY') {
    waDot.className = 'status-dot on';
    waText.textContent = 'WhatsApp Conectado';
    showQrSuccess();
  } else if (waStatus === 'AWAITING_QR') {
    waDot.className = 'status-dot warn';
    waText.textContent = 'Aguardando QR Code';
  } else {
    waDot.className = 'status-dot err';
    waText.textContent = 'WhatsApp Desconectado';
  }
}

function updateWhatsAppStatus(status, qr) {
  renderHeaderStatus(status);
  if (qr) updateQrCode(qr);
}

function updateQrCode(qrBase64) {
  const qrImg = document.getElementById('qrImage');
  const qrPlaceholder = document.getElementById('qrPlaceholder');
  const qrSuccess = document.getElementById('qrSuccess');

  if (qrBase64) {
    qrPlaceholder.style.display = 'none';
    qrSuccess.style.display = 'none';
    qrImg.src = qrBase64;
    qrImg.style.display = 'block';
  }
}

function showQrSuccess() {
  const qrImg = document.getElementById('qrImage');
  const qrPlaceholder = document.getElementById('qrPlaceholder');
  const qrSuccess = document.getElementById('qrSuccess');

  qrPlaceholder.style.display = 'none';
  qrImg.style.display = 'none';
  qrSuccess.style.display = 'flex';
}

function renderMetrics() {
  const metricAlerts = document.getElementById('metricAlertsToday');
  const metricCycle = document.getElementById('metricCycleMins');
  const metricPolos = document.getElementById('metricPolos');

  const alerts = currentHistory.sentAlerts || [];
  const todayStr = new Date().toISOString().slice(0, 10);
  const alertsToday = alerts.filter((a) => a.timestamp && a.timestamp.startsWith(todayStr)).length;

  metricAlerts.textContent = alertsToday;
  metricCycle.textContent = `${currentConfig.cycleMinutes || 3} min`;
  metricPolos.textContent = (currentConfig.polos || []).join(', ') || 'Nenhum';
}

function renderHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  const alerts = currentHistory.sentAlerts || [];
  document.getElementById('historyCount').textContent = `${alerts.length} alertas`;

  if (alerts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nenhum alerta disparado na sessão atual.</td></tr>';
    return;
  }

  tbody.innerHTML = alerts.slice(0, 50).map((a) => {
    const time = a.timestamp ? new Date(a.timestamp).toLocaleTimeString('pt-BR') : '-';
    return `
      <tr>
        <td><strong>${time}</strong></td>
        <td>${a.tipo}</td>
        <td><strong>${a.incidencia}</strong></td>
        <td>${a.equipe || '-'}</td>
        <td>${a.base || '-'}</td>
        <td>${a.group || 'Padrão'}</td>
        <td>${a.mentions || '-'}</td>
      </tr>
    `;
  }).join('');
}

function renderRoutesTable() {
  const tbody = document.getElementById('routesTableBody');
  const routes = (currentConfig.whatsapp && currentConfig.whatsapp.teamRouting) || [];

  if (routes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhuma regra cadastrada. O alerta usará o grupo padrão.</td></tr>';
    return;
  }

  tbody.innerHTML = routes.map((r, idx) => {
    const typeLabel = r.teamType === 'PROPRIA' ? 'Própria' : (r.empresa && r.empresa !== 'TODAS' ? `Parceira: ${r.empresa}` : 'Parceira (Todas)');
    return `
      <tr>
        <td><strong>${r.base}</strong></td>
        <td>${typeLabel}</td>
        <td>${r.groupName || 'Grupo Padrão'}</td>
        <td>${r.mentions || 'Nenhum'}</td>
        <td><button type="button" class="btn-action" style="color:#ef4444;" onclick="deleteRoute(${idx})">✕</button></td>
      </tr>
    `;
  }).join('');
}

window.deleteRoute = async function (idx) {
  if (currentConfig.whatsapp && currentConfig.whatsapp.teamRouting) {
    currentConfig.whatsapp.teamRouting.splice(idx, 1);
    await ipcRenderer.invoke('save-config', currentConfig);
    renderRoutesTable();
  }
};

function renderConsoleLogs() {
  const consoleBox = document.getElementById('consoleBox');
  const logs = currentHistory.logs || [];

  if (logs.length === 0) {
    consoleBox.innerHTML = '<div class="console-empty">Aguardando primeiros registros de log...</div>';
    return;
  }

  consoleBox.innerHTML = logs.map((l) => `
    <div class="console-entry">
      <span class="console-time">[${l.timestamp}]</span>
      <span class="console-level ${l.level}">${l.level}</span>
      <span class="console-msg">${escapeHtml(l.message)}</span>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

