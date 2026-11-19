const puppeteer = require('puppeteer-core');
const EdgeProfileManager = require('./EdgeProfileManager');

class OperviewAuthClient {
  constructor() {
    this._token = null;
    this._tokenExpiresAt = 0;
    this._operviewUrl = process.env.OPERVIEW_API_URL || 'https://operview-ce.enel.com';
  }

  isTokenValid() {
    return this._token && (this._tokenExpiresAt === 0 || Date.now() < (this._tokenExpiresAt - 120000)); // 2 min margem
  }

  async getToken() {
    if (this.isTokenValid()) {
      return this._token;
    }

    // 1. Prioriza token das variáveis de ambiente (TOKEN_ACCESS)
    const envToken = process.env.TOKEN_ACCESS;
    if (envToken && this._validateJwt(envToken)) {
      this._token = envToken.trim();
      return this._token;
    }

    // 2. Se não houver token estático válido, dispara autenticação via browser
    await this.authenticate();
    return this._token;
  }

  async authenticate() {
    // Se o TOKEN_ACCESS no ambiente for válido, usa imediatamente
    if (process.env.TOKEN_ACCESS && this._validateJwt(process.env.TOKEN_ACCESS)) {
      this._token = process.env.TOKEN_ACCESS.trim();
      return this._token;
    }

    const edgeExec = EdgeProfileManager.getEdgeExecutable();
    if (!edgeExec) {
      throw new Error('Microsoft Edge não encontrado para autenticação corporativa.');
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
          '--disable-extensions'
        ]
      });

      const page = await browser.newPage();
      let capturedToken = null;

      // Intercepta requisições de rede para capturar o Header Authorization: Bearer <token>
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const headers = req.headers();
        const authHeader = headers['authorization'] || headers['Authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const rawJwt = authHeader.replace(/^Bearer\s+/i, '').trim();
          if (this._validateJwt(rawJwt)) {
            capturedToken = rawJwt;
          }
        }
        req.continue();
      });

      await page.goto(this._operviewUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      if (capturedToken) {
        this._token = capturedToken;
        return this._token;
      }

      // Tenta ler do LocalStorage / SessionStorage da página
      const storageTokens = await page.evaluate(() => {
        const found = [];
        for (let i = 0; i < localStorage.length; i++) {
          const val = localStorage.getItem(localStorage.key(i));
          if (val && val.includes('eyJ')) found.push(val);
        }
        return found;
      });

      for (const st of storageTokens) {
        if (this._validateJwt(st)) {
          this._token = st;
          return this._token;
        }
      }

      throw new Error('Nenhum token JWT válido do Operview foi capturado.');
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  _validateJwt(jwtString) {
    try {
      const parts = jwtString.split('.');
      if (parts.length !== 3) return false;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      if (payload.exp && payload.exp * 1000 < Date.now()) return false;
      const isOperview = payload.aud === 'OperView' || payload.iss === 'enel';
      if (isOperview) {
        this._tokenExpiresAt = (payload.exp || 0) * 1000;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

module.exports = OperviewAuthClient;

