# Hospedagem do Gestor Flex fora do Muse — Render (gratuito para começar)

## Por que hospedar fora do Muse

O gestor que roda dentro do Muse tem um endereço que pede **login do
Muse** para quem abre. Os clientes não têm esse login, então o link da
fatura que vai na mensagem não abre para eles. Com a hospedagem no
Render, o gestor ganha um **endereço público próprio** (terminado em
`.onrender.com`): o cliente toca no link e cai direto na fatura dele,
**sem login nenhum**.

A fatura abre **somente com o código secreto do link daquele cliente**
(`#/fatura/<código>`). O código é aleatório por cliente; o número
sequencial do cliente sozinho não abre nenhuma fatura. Links antigos
(só com o número) não funcionam — depois de salvar o endereço público,
reenvie o link novo aos clientes (ele aparece nos detalhes de cada
cliente e já sai pronto nas mensagens).

## Antes de começar: leia isto

- **O gestor novo começa vazio.** Os servidores, clientes e planos que
  estão no gestor dentro do Muse **não** passam sozinhos para o
  Render. Depois do deploy, é preciso cadastrar de novo, à mão, no
  endereço novo. Crie a sua conta **primeiro**, antes de outras
  pessoas: cada conta começa vazia e os dados ficam separados por
  conta.
- **Nunca mande senha, token, chave ou URL do banco em chat.** Tokens
  do Mercado Pago e senhas de painel são digitados só dentro do
  gestor, nas abas próprias, depois que ele estiver no ar.
- **O caminho do banco é um só: o Blueprint.** Não crie o Postgres
  manualmente antes (New → Postgres): o Blueprint do passo 4 já cria
  o banco pelo `render.yaml`. Criar à mão deixaria dois bancos.

## Limites do plano gratuito do Render

- O site gratuito **dorme depois de ~15 minutos sem uso**; a primeira
  abertura depois disso pode demorar cerca de **1 minuto**. Avise os
  clientes.
- O **banco de dados gratuito tem prazo de expiração**; depois dele, o
  Render pode apagar o banco. Antes do prazo, passe o banco para um
  plano pago ou guarde cópia dos dados.
- O disco do plano gratuito é temporário: depois de uma nova
  publicação (redeploy), a sessão do WhatsApp salva no aparelho pode
  precisar de um novo QR Code. Isso ainda **não foi verificado no
  Render** — trate a primeira conexão de WhatsApp lá como teste.
- O gratuito é para começar e testar. Com movimento maior, o plano
  pago mantém o site sempre acordado.

Documentação do plano gratuito: https://render.com/docs/free

## O que já foi verificado e o que ainda NÃO foi

Verificado localmente (com dados de teste falsos, sem cobrança real):

- criar conta, entrar, cadastrar servidor/plano/cliente;
- fatura pública sem login, com plano e valor certos, só com o código
  secreto; código errado ou número do cliente sozinho não abre nada
  nem vaza dados de outro cliente; gerar novo link invalida o antigo;
- sem Mercado Pago configurado, a fatura fica em “aguardando
  configuração” e **nenhuma cobrança é gerada**;
- segunda conta começa vazia, sem ver os dados da primeira.

**Ainda NÃO verificado** (não prometa a clientes até confirmar):

- o deploy no Render em si — nenhum endereço `.onrender.com` existe
  ainda;
- o Pix de ponta a ponta com o Mercado Pago de verdade (gerar a chave,
  pagar e ver a confirmação);
- a renovação automática dentro do painel IPTV: a API do painel
  respondia HTTP 400 nos testes e a extensão (`[+]` Estender) é uma
  chamada editável e hipotética. Pagamento aprovado fica “extensão
  pendente” e **nenhum crédito é dado como consumido** até uma
  extensão real retornar sucesso;
- a conexão do WhatsApp por QR Code no Render, com leitura no celular
  de verdade.

## Passo a passo (começando do zero)

### 1. Crie a conta no GitHub

1. Abra https://github.com/signup e crie a conta (e-mail e senha).
2. Confirme o e-mail, se o GitHub pedir.

### 2. Crie a conta no Render

1. Abra https://render.com/docs/free e toque em criar conta.
2. Prefira **entrar com o GitHub** (a mesma conta do passo 1): assim
   o Render já fica ligado ao GitHub para o passo 4.
3. Não crie nenhum serviço nem banco ainda.

### 3. Coloque o código do gestor no GitHub

1. No GitHub, crie um repositório novo e **vazio** (ex.: nome
   `gestor-iptv`), sem README inicial.
2. Suba **todo o conteúdo da pasta do projeto** `gestor-iptv-externo`
   para esse repositório, **sem** as pastas `node_modules/`,
   `client/dist/`, `data/` e `.gestor-data/` (elas são geradas na
   hora do deploy ou são dados locais — não vão para o GitHub).
3. Confira que estes arquivos ficaram **na raiz** do repositório:
   `render.yaml`, `Dockerfile` e `.env.example`.
4. Quem souber usar `git` pode subir pela linha de comando; quem não
   souber, pode usar o botão **Add file → Upload files** na página do
   repositório (subindo os arquivos em partes, sem as pastas acima).

### 4. Crie o serviço no Render com o Blueprint (caminho único)

1. No Render: **New → Blueprint**.
2. Conecte o repositório do passo 3 e autorize o acesso a ele.
3. O Render lê o `render.yaml` e mostra o serviço web
   (`gestor-iptv`, plano Free) e o banco (`gestor-iptv-db`, plano
   Free). **Não crie um Postgres separado.**
4. Em `PUBLIC_BASE_URL`, deixe o Render preencher depois do primeiro
   deploy (o endereço aparece no topo da página do serviço) e salve a
   variável com esse endereço.
5. Aperte **Deploy** (ou Apply) e espere a primeira publicação
   terminar. O Render mostra o endereço do serviço (`.onrender.com`)
   no topo da página do serviço.

### 5. Ligue o endereço público dentro do gestor

1. Abra o endereço `.onrender.com` e **crie a sua conta primeiro**
   (e-mail e senha) — antes de qualquer outra pessoa.
2. No gestor, abra **Suporte → Hospedagem fora do Muse**, cole esse
   endereço no campo **Endereço público do gestor** e salve. A partir
   daí, todos os links de fatura das mensagens usam o endereço
   público com o código secreto de cada cliente.
3. Só informar o endereço no campo **não** põe o site no ar — o
   deploy do passo 4 precisa estar publicado.

### 6. Teste como cliente

1. Em uma janela anônima (ou outro celular, sem entrar no Muse), abra
   o link da fatura de um cliente de teste.
2. A fatura dele abre direto, sem login, com plano, valor e o botão
   de copiar a chave Pix. Na primeira abertura, o site gratuito pode
   demorar ~1 minuto para acordar.
3. Se pedir login do Muse, o endereço público ainda não está salvo
   no gestor ou o deploy não terminou — volte ao passo 5.

### 7. Depois do teste: configure o que é seu, dentro do gestor

- Mercado Pago (aba de pagamento): só Public Key + Access Token,
  botão de testar a conexão. Só gere Pix de verdade quando o teste
  de conexão passar.
- Servidor (link + usuário + senha do painel): ao salvar, o gestor
  testa o link de verdade e mostra Conectado ou o motivo.
- WhatsApp: aba WhatsApp → Gerar QR Code → ler com o celular. A
  conexão fica até você mesma desconectar.

## Arquivos de deploy (na raiz do projeto)

- `render.yaml` — Blueprint do Render: cria o Web Service (Docker,
  plano Free) e o Postgres (`gestor-iptv-db`, plano Free), ligando
  os dois pela `DATABASE_URL`.
- `Dockerfile` — imagem do Web Service (Bun + Node): instala as
  dependências, compila o cliente e roda o servidor real
  (`server/src/server.ts`), que serve as páginas **e** o endpoint
  de ações (`POST /actions`). O Node é usado só pelo processo da
  sessão do WhatsApp.
- `.env.example` — modelo das variáveis de ambiente. **Nenhum arquivo
  contém segredo.**
- `migrations/001_init.sql` — cria as tabelas vazias no Postgres
  (carimbos de milissegundos em `bigint`, datas em `timestamp(3)`).
- `server/src/` — servidor standalone (Bun): banco Postgres via
  `DATABASE_URL` (sem ela, Postgres embarcado PGlite, só para
  desenvolvimento local), sincronização de cobranças a cada 60
  segundos em processo, e o serviço de WhatsApp por QR Code
  (Baileys) adaptado do gestor original, sem o SDK do Muse.
