# NorthRadarBot — Aplicativo Desktop Autônomo de Alertas WhatsApp

Aplicativo Desktop independente (Windows) para monitoramento de ocorrências e despacho automático de alertas no WhatsApp.

## Características
- **100% Autônomo:** Não depende do NorthRadar Web em execução. Conecta-se diretamente às fontes de dados corporativas (Operview SSO Edge e Spotfire Web Player).
- **Sessão Persistente:** O WhatsApp Web roda nativo e armazena os cookies e autenticação localmente.
- **Leitura Visual de QR Code:** Interface gráfica embutida para escanear o QR Code de primeira conexão.
- **Roteamento Inteligente (Regra 7):** Direcionamento hierárquico por Base, Vínculo (Própria ou Parceira) e Empresa Parceira.
- **System Tray:** Roda silencioso na bandeja do Windows (ao lado do relógio).

## Requisitos
- Windows 10/11
- Node.js 18+ instalado
- Microsoft Edge ou Google Chrome instalado

## Como Iniciar em Modo de Desenvolvimento
```bash
cd c:\Users\BR0083895903\source\NorthRadarBot
npm install
npm start
```

## Como Gerar o Executável (.exe)
```bash
npm run dist
```
O instalador e a versão portátil serão gerados na pasta `dist/`.

