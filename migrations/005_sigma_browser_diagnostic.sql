-- Gestor Flex (versão externa) — diagnóstico rico da localização do
-- botão "Renovar" do painel Sigma por navegador (etapa 1: só
-- localizar, sem clicar). Dialeto: Postgres. Idempotente (ADD COLUMN
-- IF NOT EXISTS): rodar de novo não apaga dados. Nenhum dado é
-- apagado por esta migração.
-- O servidor guarda o diagnóstico da ÚLTIMA localização como JSON
-- em texto: estágio alcançado, tempos por etapa, título/caminho da
-- página, flags de presença de textos visíveis e trecho curto
-- SANITIZADO da tela. Nenhuma credencial é guardada aqui — o trecho
-- nunca inclui usuário/senha/token.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS browser_locate_diagnostic text NOT NULL DEFAULT '';
