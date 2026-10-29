-- Gestor Flex (versão externa) — localização do botão "Renovar" do
-- painel Sigma por navegador (ETAPA 1: só localizar, sem clicar).
-- Dialeto: Postgres. Idempotente (ADD COLUMN IF NOT EXISTS): rodar de
-- novo não apaga dados. Nenhum dado é apagado por esta migração.
-- O servidor guarda o resultado da ÚLTIMA localização (encontrou ou
-- não, motivo em linguagem simples e quando testou). Nenhuma
-- credencial é guardada aqui — usuário/senha do painel continuam nos
-- campos que já existiam.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS browser_locate_found integer NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS browser_locate_detail text NOT NULL DEFAULT '';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS browser_locate_tested_at bigint;
