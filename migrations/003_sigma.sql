-- Gestor Flex (versão externa) — integração Sigma (painel OneTV/NEWONETV).
-- Dialeto: Postgres. Idempotente (ADD COLUMN IF NOT EXISTS): rodar de
-- novo não apaga dados. Nenhum dado é apagado por esta migração.
-- A integração Sigma guarda a base da API de revendedor e o token
-- Bearer nela (o token nunca volta para a tela — só "salvo"). O
-- servidor ganha o provedor do painel ("wplay" ou "sigma"); os
-- servidores antigos continuam "wplay", sem mudar comportamento.

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS api_base text NOT NULL DEFAULT '';
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS api_token text NOT NULL DEFAULT '';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS panel_provider text NOT NULL DEFAULT 'wplay';
