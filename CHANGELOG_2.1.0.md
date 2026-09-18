# ContabGest 2.1.0 — Fundação

## Correções e melhorias
- Autenticação passou a validar e-mail + senha; removido o fallback que aceitava qualquer senha para perfis com “admin”/“contador” no e-mail.
- Sessões passaram a usar tokens aleatórios com expiração de 8 horas.
- Endpoints `/api` passaram a exigir sessão autenticada; `/api/health` e login permanecem públicos.
- Senhas são armazenadas como hash PBKDF2-SHA512 (120.000 iterações) após o primeiro login de usuários legados.
- A API não devolve `passwordHash` ao frontend.
- Limite de 10 tentativas de login por minuto por origem.
- Payload JSON limitado a 10 MB.
- Persistência do banco JSON passou a ser atômica usando arquivo temporário + rename.
- O status de saúde deixou de afirmar “pronto para deploy” enquanto o banco ainda contém dados de demonstração.
- A aplicação valida a sessão no carregamento e limpa credenciais expiradas.
- “Lembrar neste navegador” agora diferencia `localStorage` de `sessionStorage`.

## Observação
O banco incluído continua sendo um banco de demonstração para preservar os módulos já desenvolvidos. Antes de produção, configure `CONTABGEST_DEFAULT_PASSWORD`, substitua os dados demo e migre para um banco gerenciado.
