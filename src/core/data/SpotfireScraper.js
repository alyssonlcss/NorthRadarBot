const puppeteer = require('puppeteer-core');
const EdgeProfileManager = require('../auth/EdgeProfileManager');

class SpotfireScraper {
  constructor() {
    this._reportUrl = process.env.SPOTFIRE_REPORT_URL || process.env.SPOTFIRE_URL || '';
    this._username = process.env.SPOTFIRE_USERNAME || '';
    this._password = process.env.SPOTFIRE_PASSWORD || '';
    this._browser = null;
    this._page = null;
  }

  isConfigured() {
    return Boolean(this._reportUrl);
  }

  async getDeslocamentos(polo = 'ATLANTICO') {
    if (!this.isConfigured()) {
      return [];
    }

    const edgeExec = EdgeProfileManager.getEdgeExecutable();
    if (!edgeExec) {
      console.warn('[SpotfireScraper] Microsoft Edge não encontrado para carregar Spotfire.');
      return [];
    }

    let browser = null;
    try {
      const userDataDir = EdgeProfileManager.getEdgeUserDataDir();
      browser = await puppeteer.launch({
        executablePath: edgeExec,
        headless: 'new',
        userDataDir: userDataDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1280,800'
        ]
      });

      const page = await browser.newPage();
      await page.goto(this._reportUrl, { waitUntil: 'networkidle2', timeout: 45000 });

      // Se houver tela de login do Spotfire e credenciais fornecidas
      if (this._username && this._password) {
        const userInput = await page.$("input[type='text'], input[name='username']");
        const passInput = await page.$("input[type='password']");
        if (userInput && passInput) {
          await userInput.type(this._username);
          await passInput.type(this._password);
          await page.keyboard.press('Enter');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        }
      }

      // Aguarda indicador de carregamento do Spotfire sumir
      await page.waitForFunction(() => !document.querySelector('.sf-busy'), { timeout: 30000 }).catch(() => {});

      // Extrai linhas da tabela M300 visível
      const rows = await page.evaluate(() => {
        const items = [];
        const tableRows = document.querySelectorAll('.sfc-canvas .sfc-row, .sfc-table-row');
        tableRows.forEach((row) => {
          const cells = Array.from(row.querySelectorAll('.sfc-cell, .cell-text')).map((c) => c.innerText.trim());
          if (cells.length >= 4) {
            items.push({
              equipe: cells[0] || '',
              eqStatus: cells[1] || '',
              acionada: cells[2] || '',
              emDeslocamento: cells[3] || '',
              noLocal: cells[4] || '',
              liberada: cells[5] || ''
            });
          }
        });
        return items;
      });

      return rows;
    } catch (err) {
      console.warn(`[SpotfireScraper] Falha ao extrair tabela M300 do Spotfire: ${err.message}`);
      return [];
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

module.exports = SpotfireScraper;

