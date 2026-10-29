-- Gestor Flex (versão externa) — integração TopSul (painel CS TopSul).
-- Dialeto: Postgres. Idempotente (ADD COLUMN IF NOT EXISTS): rodar de
-- novo não apaga dados. Nenhum dado é apagado por esta migração.
-- A integração TopSul guarda o segredo ("secret") da API TopSul, que
-- vai no corpo de cada chamada junto com o token (que vai no caminho
-- da URL). O segredo nunca volta para a tela — só "salvo". A coluna
-- api_base/api_token já existe (migração 003, do provedor removido)
-- e é reutilizada pela TopSul: base da API + token. O provedor é
-- texto simples, sem restrição de valores, então "topsul" já cabe
-- nele sem nenhuma alteração de restrição.

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS api_secret text NOT NULL DEFAULT '';
