<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/27edfffe-fbaa-45ec-a7bd-ee931e480962

## ContabGest — versão 2.1.0

Esta versão inicial de fundação mantém os dados de demonstração separados conceitualmente do ambiente de produção, adiciona autenticação por sessão com senha derivada via PBKDF2, validação da sessão no carregamento da aplicação, persistência atômica do JSON e limite de payload da API.

> **Importante:** o banco incluído ainda contém dados de demonstração. Antes de uso real, configure `CONTABGEST_DEFAULT_PASSWORD`, revise os dados e faça um backup.

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
