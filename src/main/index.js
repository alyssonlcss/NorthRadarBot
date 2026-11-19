require('dotenv').config();
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ConfigStore = require('../core/storage/ConfigStore');
const OperviewAuthClient = require('../core/auth/OperviewAuthClient');
const OperviewApiClient = require('../core/data/OperviewApiClient');
const SpotfireScraper = require('../core/data/SpotfireScraper');
const EquipesBrasilClient = require('../core/data/EquipesBrasilClient');
const RoutingResolver = require('../core/diagnosis/RoutingResolver');
const RulesEngine = require('../core/diagnosis/RulesEngine');
const WhatsAppClient = require('../core/whatsapp/WhatsAppClient');
const AlertDaemon = require('../core/AlertDaemon');

let mainWindow = null;
let tray = null;
let configStore = null;
let authClient = null;
let operviewClient = null;
let spotfireScraper = null;
let equipesBrasilClient = null;
let routingResolver = null;
let rulesEngine = null;
let whatsappClient = null;
let alertDaemon = null;

// Garante instância única (não abre múltiplos apps iguais)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initServices();
    createMainWindow();
    createSystemTray();
  });
}

function initServices() {
  configStore = new ConfigStore();
  authClient = new OperviewAuthClient();
  operviewClient = new OperviewApiClient(authClient);
  spotfireScraper = new SpotfireScraper();
  equipesBrasilClient = new EquipesBrasilClient(authClient);
  routingResolver = new RoutingResolver(configStore);
  rulesEngine = new RulesEngine(routingResolver, configStore);
  whatsappClient = new WhatsAppClient();
  alertDaemon = new AlertDaemon(
    configStore,
    operviewClient,
    spotfireScraper,
    equipesBrasilClient,
    rulesEngine,
    routingResolver,
    whatsappClient
  );

  // Notificações do Windows em novos alertas
  alertDaemon.on('alert', ({ inc, rule, target }) => {
    if (Notification.isSupported()) {
      new Notification({
        title: `🚨 Alerta: ${rule.label}`,
        body: `Incidência ${inc.ordem} encaminhada para [${target.groupName}].`
      }).show();
    }
    if (mainWindow) {
      mainWindow.webContents.send('alert:new', { inc, rule, target });
    }
  });

  whatsappClient.on('status', (st) => {
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp:status', {
        status: st,
        qr: whatsappClient.getQrCode()
      });
    }
    updateTrayMenu();
  });

  whatsappClient.on('qr', (qr) => {
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp:qr', qr);
    }
  });

  // Inicia serviços
  const isHeadless = process.env.WHATSAPP_HEADLESS === 'true';
  whatsappClient.start(isHeadless);
  alertDaemon.start();
}

function createMainWindow() {
  const iconPath = path.join(__dirname, '../../assets/icon.png');

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    title: 'NorthRadarBot — Alertas WhatsApp Autônomos',
    backgroundColor: '#0f172a',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Minimiza para bandeja em vez de fechar
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createSystemTray() {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  let trayIcon = null;

  try {
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
    } else {
      // 16x16 PNG fallback
      const blank16x16 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVDhPY/wPBAxUAMpoaCBhAACe3g/h9mHhqwAAAABJRU5ErkJggg==';
      trayIcon = nativeImage.createFromDataURL(blank16x16);
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('NorthRadarBot — Alertas Operacionais');
    updateTrayMenu();

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn('[Tray] Não foi possível inicializar o ícone de bandeja:', err.message);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const cfg = configStore ? configStore.getConfig() : {};
  const isRunning = cfg.robotActive !== false;
  const waStatus = whatsappClient ? whatsappClient.getStatus() : 'DISCONNECTED';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'NorthRadarBot', enabled: false },
    { label: `WhatsApp: ${waStatus}`, enabled: false },
    { type: 'separator' },
    {
      label: isRunning ? '⏸ Pausar Robô' : '▶ Ativar Robô',
      click: () => {
        configStore.saveConfig({ robotActive: !isRunning });
        if (!isRunning) alertDaemon.start();
        else alertDaemon.stop();
        updateTrayMenu();
        if (mainWindow) mainWindow.webContents.send('config:updated');
      }
    },
    {
      label: 'Abrir Painel',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Sair Completamente',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

app.on('before-quit', async () => {
  app.isQuitting = true;
  if (whatsappClient) {
    try {
      await whatsappClient.stop();
    } catch (_) {}
  }
});

// IPC Handlers
ipcMain.handle('get-state', () => {
  return {
    config: configStore.getConfig(),
    history: configStore.getHistory(),
    whatsappStatus: whatsappClient.getStatus(),
    qrCode: whatsappClient.getQrCode()
  };
});

ipcMain.handle('save-config', (event, newConfig) => {
  return configStore.saveConfig(newConfig);
});

ipcMain.handle('reconnect-whatsapp', async () => {
  await whatsappClient.stop();
  const isHeadless = process.env.WHATSAPP_HEADLESS === 'true';
  await whatsappClient.start(isHeadless);
  return { success: true };
});

ipcMain.handle('trigger-cycle-now', async () => {
  await alertDaemon.runCycle();
  return { success: true };
});

