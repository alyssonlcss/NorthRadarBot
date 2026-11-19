const { EventEmitter } = require('events');
const puppeteer = require('puppeteer-core');
const path = require('path');
const os = require('os');
const fs = require('fs');

class WhatsAppClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this._headless = options.headless !== undefined ? options.headless : (process.env.WHATSAPP_HEADLESS === 'true');
    const defaultDataDir = path.join(os.homedir(), '.northradar-bot', 'whatsapp-session');
    const configuredDir = options.userDataDir || process.env.WHATSAPP_USER_DATA_DIR;
    this._userDataDir = configuredDir ? path.resolve(configuredDir) : defaultDataDir;

    try {
      if (!fs.existsSync(this._userDataDir)) {
        fs.mkdirSync(this._userDataDir, { recursive: true });
      }
    } catch (err) {
      console.warn('[WhatsAppClient] Não foi possível criar pasta de sessão:', err.message);
    }

    this._status = 'DISCONNECTED'; // DISCONNECTED | AWAITING_QR | READY
    this._qrCode = null;
    this._browser = null;
    this._page = null;
    this._queue = [];
    this._isSending = false;
  }

  getStatus() {
    return this._status;
  }

  getQrCode() {
    return this._qrCode;
  }

  async start(headless) {
    if (headless !== undefined) {
      this._headless = headless;
    }
    if (this._browser) return;

    try {
      this._status = 'AWAITING_QR';
      this.emit('status', this._status);

      this._browser = await puppeteer.launch({
        headless: this._headless,
        userDataDir: this._userDataDir,
        executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,800'
        ]
      });

      const pages = await this._browser.pages();
      this._page = pages.length > 0 ? pages[0] : await this._browser.newPage();
      await this._page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await this._page.setViewport({ width: 1280, height: 800 });

      // Oculta indicador de automação para evitar bloqueio anti-bot
      await this._page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      });

      await this._page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

      this._watchSession();
    } catch (err) {
      this._status = 'DISCONNECTED';
      this.emit('status', this._status);
      this.emit('error', err);
      console.error('[WhatsAppClient] Falha ao iniciar:', err);
    }
  }

  async _watchSession() {
    if (!this._page) return;

    const checkInterval = setInterval(async () => {
      try {
        if (!this._page || this._page.isClosed()) {
          clearInterval(checkInterval);
          this._status = 'DISCONNECTED';
          this.emit('status', this._status);
          return;
        }

        // Clica automaticamente em botões como "Usar aqui", "Use here", "Tentar novamente" se surgirem
        await this._page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const btn of buttons) {
            const label = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (label.includes('usar aqui') || label.includes('use here') ||
                label.includes('tentar novamente') || label.includes('recarregar')) {
              btn.click();
              break;
            }
          }
        }).catch(() => {});

        // Verifica se a tela principal do WhatsApp carregou (barra de busca ou painel lateral)
        const chatList = await this._page.$('#pane-side, div[data-testid="chat-list"], input[data-tab="3"], div[contenteditable="true"][data-tab="3"]');
        if (chatList) {
          if (this._status !== 'READY') {
            this._status = 'READY';
            this._qrCode = null;
            this.emit('status', this._status);
            this.emit('ready');
          }
          return;
        }

        // Se houver botão para recarregar QR code expirado, clica nele
        const reloadBtn = await this._page.$('button[aria-label*="QR"], div[data-ref] span[role="button"], span[data-icon="refresh"]');
        if (reloadBtn) {
          await reloadBtn.click().catch(() => {});
        }

        // Verifica se o QR Code está visível na tela
        const qrCanvas = await this._page.$('div[data-ref] canvas, canvas');
        if (qrCanvas) {
          const box = await qrCanvas.boundingBox();
          if (box && box.width > 50 && box.height > 50) {
            const qrData = await qrCanvas.screenshot({ encoding: 'base64' });
            const newQr = `data:image/png;base64,${qrData}`;
            if (this._qrCode !== newQr) {
              this._qrCode = newQr;
              this._status = 'AWAITING_QR';
              this.emit('status', this._status);
              this.emit('qr', this._qrCode);
            }
          }
        }
      } catch (err) {
        // Ignora erros temporários durante navegação
      }
    }, 2000);
  }

  async sendMessage(groupName, messageText, mentions = '') {
    return new Promise((resolve, reject) => {
      this._queue.push({ groupName, messageText, mentions, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._isSending || this._queue.length === 0) return;
    this._isSending = true;
    const task = this._queue.shift();

    try {
      if (this._status !== 'READY') {
        throw new Error('WhatsApp Web não está autenticado.');
      }

      const page = this._page;

      // 1. Busca pelo grupo (suporte dinâmico aos seletores mais recentes do WhatsApp Web)
      const searchSelector = 'input[data-tab="3"], input[role="textbox"], input[aria-label*="Pesquisar"], div[contenteditable="true"][data-tab="3"], #side div[contenteditable="true"], div[data-testid="chat-list-search"]';
      let searchBox = null;
      try {
        searchBox = await page.waitForSelector(searchSelector, { timeout: 12000 });
      } catch (_) {
        searchBox = await page.$(searchSelector);
      }

      if (!searchBox) {
        throw new Error('Campo de busca de grupos não encontrado. Verifique se o WhatsApp Web carregou.');
      }

      await searchBox.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');

      await page.keyboard.type(task.groupName, { delay: 30 });
      await new Promise((r) => setTimeout(r, 1000));

      // 2. Abre a conversa (Tenta Enter + Fallback de clique na lista lateral)
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 500));

      await page.evaluate((targetGroup) => {
        const norm = String(targetGroup || '').trim().toLowerCase();
        if (!norm) return;
        const spans = Array.from(document.querySelectorAll('#pane-side span[title]'));
        const match = spans.find((s) => String(s.getAttribute('title') || '').trim().toLowerCase().includes(norm));
        if (match) match.click();
      }, task.groupName).catch(() => {});

      // 3. Aguarda o campo de digitação da mensagem
      const composerSelector = '[data-testid="conversation-compose-box-input"], footer div[contenteditable="true"], footer [role="textbox"], #main footer div[contenteditable="true"]';
      const composer = await page.waitForSelector(composerSelector, { timeout: 15000 });
      if (!composer) throw new Error('Campo de digitação não encontrado.');

      await composer.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');

      // 4. Inserção de texto (via colagem atômica ClipboardEvent para suportar grandes textos e caracteres invisíveis instantaneamente)
      const mentionsList = Array.isArray(task.mentions)
        ? task.mentions
        : String(task.mentions || '').split(/[,;\s]+/).map((m) => m.trim().replace(/^@+/, '')).filter(Boolean);

      const hasMentions = mentionsList.length > 0;
      const textToInsert = hasMentions
        ? String(task.messageText || '').replace(/(?:\r?\n)*\*Cc:\*.*$/i, '').trim()
        : String(task.messageText || '');

      await this._insertMultilineText(page, textToInsert, composerSelector);

      // 5. Inserção de menções reais interativas (@contatos)
      if (hasMentions) {
        await this._insertMentions(page, mentionsList, composerSelector);
      }

      // 6. Dispara o envio
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 800));

      task.resolve({ success: true, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[WhatsAppClient] Erro ao enviar mensagem:', err);
      task.reject(err);
    } finally {
      this._isSending = false;
      this._processQueue();
    }
  }

  async _insertMultilineText(page, text, composerSelector) {
    const cleanText = String(text || '');
    if (!cleanText) return;

    // Tenta inserção via ClipboardEvent('paste') atômica (~150ms)
    if (composerSelector && typeof page.evaluate === 'function') {
      const pastedDispatched = await page.evaluate((sel, content) => {
        try {
          const el = document.querySelector(sel);
          if (!el || typeof DataTransfer === 'undefined' || typeof ClipboardEvent === 'undefined') {
            return false;
          }
          el.focus();
          const dt = new DataTransfer();
          dt.setData('text/plain', content);
          const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          el.dispatchEvent(ev);
          return true;
        } catch (_) {
          return false;
        }
      }, composerSelector, cleanText).catch(() => false);

      if (pastedDispatched === true) {
        await new Promise((r) => setTimeout(r, 250));
        const hasContent = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return Boolean(el && (el.innerText || '').trim().length > 0);
        }, composerSelector).catch(() => true);

        if (hasContent) {
          return;
        }
      }
    }

    // Fallback: se ClipboardEvent não foi aceito, divide e digita
    const lines = cleanText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        await page.keyboard.type(lines[i], { delay: 5 });
      }
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }
  }

  async _insertMentions(page, mentions, composerSelector) {
    if (!Array.isArray(mentions) || mentions.length === 0) return;

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        const selObj = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selObj.removeAllRanges();
        selObj.addRange(range);
      }
    }, composerSelector).catch(() => {});

    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('*Cc:* ');

    for (const rawMention of mentions) {
      const cleanMention = String(rawMention || '').trim().replace(/^@+/, '');
      if (!cleanMention) continue;

      const searchToken = cleanMention.includes(' ') ? cleanMention.split(/\s+/)[0] : cleanMention;
      await page.keyboard.type(`@${searchToken}`, { delay: 40 });
      await new Promise((r) => setTimeout(r, 600));

      let clickedSpecific = false;
      if (cleanMention.includes(' ') && typeof page.evaluate === 'function') {
        clickedSpecific = await page.evaluate((fullName) => {
          const containers = Array.from(document.querySelectorAll(
            'footer [role="listbox"], [data-testid="mentions-list"], [data-testid="mention-menu"], footer [role="menu"], footer div[style*="position: absolute"]'
          ));
          const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
          const normTarget = stripAccents(fullName);
          for (const c of containers) {
            const items = Array.from(c.querySelectorAll('[role="button"], [role="option"], div[data-animate-dropdown-item="true"]'));
            const match = items.find((it) => stripAccents(it.innerText || it.textContent || '').includes(normTarget));
            if (match && typeof match.click === 'function') {
              match.click();
              return true;
            }
          }
          return false;
        }, cleanMention).catch(() => false);
      }

      if (!clickedSpecific) {
        await page.keyboard.press('Tab');
        await new Promise((r) => setTimeout(r, 250));
      }

      await page.keyboard.type(' ');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async stop() {
    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
      this._page = null;
      this._status = 'DISCONNECTED';
      this.emit('status', this._status);
    }
  }
}

module.exports = WhatsAppClient;
