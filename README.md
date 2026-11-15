# ig-webhook (MANYWATA)

Webhook Instagram **comentário → DM** (private reply), serverless na Vercel. Igual ManyChat, sem ManyChat.

Um app do Meta, uma Callback URL, **várias contas**. Quem atende quem está em [`api/contas.js`](api/contas.js).

## Contas atendidas

| slug | conta | user_id | token |
|------|-------|---------|-------|
| `watanabe` | @watanabe.ia | `17841400866194604` | `IG_ACCESS_TOKEN` |
| `eterniza` | @eternizacards | `17841438494434121` | `IG_ACCESS_TOKEN_ETERNIZA` |

As regras (palavra-gatilho → DM + resposta pública) ficam dentro de cada conta em `contas.js`. Edite e dê `git push` — a Vercel redeploya sozinha.

> O watanabe está com `regras: []` desde 2026-09-17. A copy antiga mandava pra waitlist de uma comunidade que não existe mais; religar exige copy nova.

## URL do webhook

`https://manywata.vercel.app/api/webhook`

## Env vars (na Vercel)

Project → Settings → Environment Variables. Veja `.env.example`.

| Var | O que é |
|-----|---------|
| `IG_VERIFY_TOKEN` | string que você inventa; a MESMA no campo "Verificar token" do Meta |
| `IG_APP_SECRET` | "Chave secreta do app" do painel Meta — valida o HMAC de todo webhook |
| `IG_ACCESS_TOKEN` | token long-lived do @watanabe.ia |
| `IG_ACCESS_TOKEN_ETERNIZA` | token long-lived do @eternizacards |
| `PUBLICAR_SECRET` | senha das rotas de publicação de mídia (ver [Publicação de mídia](#publicação-de-mídia-rascunho--publicar)) |

🔴 Os tokens `IG_ACCESS_TOKEN*` são tipo **Encrypted**, nunca **Sensitive**: o cron `refresh-token.mjs` precisa ler o valor de volta pra renovar. O `PUBLICAR_SECRET` pode ser Sensitive.

Depois de setar/alterar env var → **`vercel --prod` de novo** (a Vercel não relê env em runtime sem redeploy).

## Adicionar uma conta nova

1. Autorizar a conta no **mesmo app** do Meta (Instagram → Configuração da API com login do Instagram → Gerar token). App novo exigiria App Review de novo.
2. Pegar o `user_id`:
   ```
   GET https://graph.instagram.com/v26.0/me?fields=user_id,username&access_token=<token>
   ```
   ⚠️ `user_id`, **não** `id`. O `id` é app-scoped e não casa com o `entry.id` do webhook — usar o errado faz o webhook ignorar todo comentário, em silêncio.
3. Assinar o webhook pra essa conta:
   ```
   POST https://graph.instagram.com/v26.0/<user_id>/subscribed_apps?subscribed_fields=comments,messages&access_token=<token>
   ```
   Tem que voltar `{"success": true}`. **O POST substitui a lista inteira**, então mande sempre `comments,messages` — só `comments` derruba o `messages` calado.
4. Token num env var novo na Vercel (Encrypted).
5. Adicionar a entrada em `api/contas.js` e dar push.

## Quando o DM para de sair

Antes de mexer em código ou copy, confira se a conta ainda está assinada:

```
GET https://graph.instagram.com/v26.0/<user_id>/subscribed_apps?access_token=<token>
```

`{"data":[]}` significa que a conta não está assinada e **nenhum comentário gera webhook** — sem erro, sem log, sem nada. Desativar o webhook no painel zera isso, e reativar não restaura: tem que refazer o POST do passo 3.

## Testes

```bash
npm test
```

Cobre o cadastro de contas e o casamento de regras. Os testes de invariante existem pra pegar o pior bug possível aqui: duas contas apontando pro mesmo token, o que faria o DM de uma sair pela outra em silêncio.

`tests/midia.test.js` cobre a publicação de mídia com `fetch` falso (nunca chama o Instagram): autenticação, validação, ordem das chamadas ao Graph, limite de 24h, id adulterado/expirado e que o token não aparece em resposta nem em log.

## Insights orgânicos

```bash
npm run insights              # @watanabe.ia, últimos 12 posts
npm run insights:eterniza
npm run insights:todas
node scripts/insights.mjs --conta eterniza --limit 20 --no-save
```

Lê o token do `.env.local` (ou do ambiente) pelo nome que está em `contas.js`. JSON cru vai pra `output/insights-<slug>-<data>.json`.

Se der 401: o cron rotacionou o token na Vercel, recopie pro `.env.local`.

## Publicação de mídia (rascunho → publicar)

Publica no Instagram pela API oficial (Instagram API with Instagram Login), em **duas etapas separadas**. Hoje: **carrossel** da @eternizacards. Reels e Stories já têm lugar no desenho, mas respondem 501 (ver [o que falta](#o-que-falta-para-reels-e-stories)).

### Fluxo de negócio

1. A especialista faz o briefing.
2. O Programador monta o carrossel (`slide-01.jpg`, `slide-02.jpg`, ... + `instagram-post.txt` com a legenda).
3. A especialista sobe os JPEGs numa URL pública e cria o **rascunho**. O Instagram recebe as imagens e monta o container, mas **nada aparece no perfil**.
4. Ela manda o **link do preview** pro Vinicius.
5. **Só com a confirmação do Vinicius** alguém roda o **publicar** (`confirmar: true` / `--confirmar`).

O rascunho vale **24h** (é o tempo que o Instagram guarda container não publicado). Passou disso, gere outro.

### Endpoints

Todos exigem `PUBLICAR_SECRET` configurado no servidor (sem ele: **503**, nenhuma chamada ao Instagram).

| Rota | Método | Auth | O que faz |
|------|--------|------|-----------|
| `/api/midia/rascunho` | POST | `Authorization: Bearer <PUBLICAR_SECRET>` | valida, cria os containers e espera `FINISHED`. **Não publica.** Devolve `id` e `preview` |
| `/api/midia/publicar` | POST | `Authorization: Bearer <PUBLICAR_SECRET>` | com `confirmar: true`: re-checa o container, checa o limite de 24h e publica. Devolve `permalink` |
| `/api/midia/preview?id=...` | GET | o próprio `id` assinado (Bearer opcional) | página HTML com os slides e a legenda. Só leitura |
| `/api/carrossel/rascunho` | POST | Bearer | alias de `/api/midia/rascunho` com `tipo` fixo `CAROUSEL` (pode omitir) |
| `/api/carrossel/publicar` | POST | Bearer | alias de `/api/midia/publicar` que só aceita rascunho de carrossel |

Os aliases existem porque eram 3 linhas cada; a rota "oficial" é `/api/midia/*`.

Respostas de erro são `{"erro": "..."}`: **400** entrada inválida ou `confirmar` diferente de `true` · **401** sem Bearer, Bearer errado ou id adulterado · **405** método errado · **409** container já publicado · **410** rascunho/container expirado · **429** limite de 24h atingido (nada publicado) · **501** tipo não implementado · **502** o Instagram recusou (mensagem do Meta, sem token) · **503** `PUBLICAR_SECRET` ou token da conta ausente · **504** container não ficou pronto a tempo.

**Por que o preview abre só com o id:** o id é assinado (HMAC-SHA256) com chave derivada do `PUBLICAR_SECRET` e só sai pra quem chamou o rascunho com o segredo. Ele mostra o que já carrega (URLs públicas + legenda), não chama o Instagram e não tem botão de publicar, então dá pra mandar o link por WhatsApp e abrir no celular. **Publicar sempre exige o Bearer**: o id sozinho não publica nada.

### Exemplos (curl)

```bash
# rascunho
curl -sX POST https://manywata.vercel.app/api/midia/rascunho \
  -H "Authorization: Bearer $PUBLICAR_SECRET" -H "Content-Type: application/json" \
  -d '{
    "conta": "eterniza",
    "tipo": "CAROUSEL",
    "itens": [{"url": "https://exemplo.com/c1/slide-01.jpg"}, {"url": "https://exemplo.com/c1/slide-02.jpg"}],
    "legenda": "Sua carta, seu nome. #tcg"
  }'
# → 201 {"id": "eyJ2Ijox...", "preview": "https://manywata.vercel.app/api/midia/preview?id=...", "expiraEm": "...", ...}

# publicar (só depois do OK do Vinicius)
curl -sX POST https://manywata.vercel.app/api/midia/publicar \
  -H "Authorization: Bearer $PUBLICAR_SECRET" -H "Content-Type: application/json" \
  -d '{"id": "eyJ2Ijox...", "confirmar": true}'
# → 200 {"publicado": true, "mediaId": "...", "permalink": "https://www.instagram.com/p/...", "quota": {"usado": 4, "total": 50}}
```

### CLI

```bash
# rascunho a partir da pasta de render (slide-NN.jpg em ordem numérica + instagram-post.txt)
node scripts/midia.mjs rascunho carrossel/render --base-url https://exemplo.com/c1
npm run midia:rascunho -- carrossel/render --base-url https://exemplo.com/c1 --conta eterniza

# ou com a lista de URLs pronta
node scripts/midia.mjs rascunho --urls https://exemplo.com/a.jpg,https://exemplo.com/b.jpg --legenda post.txt

# conferir sem chamar nada
node scripts/midia.mjs rascunho carrossel/render --base-url https://exemplo.com/c1 --dry-run

# publicar (sem --confirmar ele recusa)
node scripts/midia.mjs publicar <id> --confirmar

# reimprimir o link do preview
node scripts/midia.mjs preview <id>
```

`--base-url` é obrigatório porque quem baixa as imagens é o servidor do Meta: elas precisam estar numa URL **https pública** antes do rascunho, e o CLI ainda não faz upload (ver pendência abaixo). Os nomes dos arquivos são anexados à `--base-url`.

O CLI lê `PUBLICAR_SECRET` e `MANYWATA_URL` (padrão `https://manywata.vercel.app`) do ambiente ou do `.env.local`.

### Envs novas (criar na Vercel)

| Var | Onde | Tipo | Observação |
|-----|------|------|------------|
| `PUBLICAR_SECRET` | Vercel (production) + `.env.local` de quem usa o CLI | **Sensitive** serve, ninguém precisa ler de volta | mínimo 32 caracteres: `openssl rand -hex 32`. Trocar o valor invalida todos os rascunhos em aberto |
| `MANYWATA_URL` | só `.env.local` (CLI) | — | opcional |

Depois de criar: **`vercel --prod` de novo**.

⚠️ `IG_ACCESS_TOKEN_ETERNIZA` hoje existe **só no target production**. Em deploy de preview as rotas respondem 503 ("token não configurado"), então **preview da Vercel não publica**. Isso é bom, mas quer dizer que pra testar de ponta a ponta tem que ser em produção.

### Limites do Meta (regra deles, não do código)

- **50 posts publicados via API por conta a cada 24h**. A rota checa `content_publishing_limit` antes de publicar e devolve 429 sem publicar se a cota acabou.
- Container não publicado **expira em 24h**. O id do rascunho expira junto (410).
- Carrossel: **2 a 10 itens**, imagens **JPEG** em URL pública. Mais de 10 o Meta recusa.
- Legenda: até **2200 caracteres**, **30 hashtags** e **20 menções (@)**.
- A conta precisa ser profissional (Business/Creator), e o token precisa da permissão `instagram_business_content_publish`.

### Como funciona por dentro

- `api/_lib/` não vira rota na Vercel (prefixo `_`). Lá ficam `seguranca.js` (auth, id assinado, sanitização, validação de URL), `instagram-publicacao.js` (cliente do Graph + registro `TIPOS`) e `rotas-midia.js` (as três rotas).
- **Sem banco nem store**: o id do rascunho é `base64url(JSON) + "." + HMAC-SHA256`, com conta, tipo, id do container, URLs, legenda e validade. Assinatura conferida com `timingSafeEqual`; expirado dá 410 sem chamar o Instagram. Como a legenda vai dentro do id, o link do preview fica comprido (alguns KB). Funciona, mas tem cara feia.
- Carrossel: cria um container-filho por slide (`is_carousel_item=true`, `image_url`), espera cada um ficar `FINISHED`, cria o container `CAROUSEL` com `children` na mesma ordem e `caption`, e espera `FINISHED`. Orçamento de ~50s (a função tem 60s, ver `vercel.json`).
- O token vai no header `Authorization: Bearer`, nunca na URL. Toda mensagem de erro passa por `sanitizar()`, que tira `access_token=`, `Bearer ...` e os segredos conhecidos.
- Se o permalink falhar **depois** de publicar, a rota devolve 200 com `aviso`, pra ninguém tentar de novo achando que não foi.

### Pendência: Vercel Blob

O projeto ainda não tem Vercel Blob, então só entra URL pública pronta. Ponto de extensão documentado em `scripts/midia.mjs` (`montarItens`): com `BLOB_READ_WRITE_TOKEN` configurado, o CLI faz `put()` de cada slide no Blob e usa a URL devolvida. As rotas não mudam, continuam recebendo URL pública. Não tem dependência instalada pra isso ainda (`@vercel/blob` entra junto).

### O que falta para Reels e Stories

O registro `TIPOS` em `api/_lib/instagram-publicacao.js` já tem as entradas `REELS` e `STORIES` com `implementado: false` (as rotas respondem 501). Pra ligar cada uma:

**Reels**
1. `validar()`: exatamente 1 item com URL https de vídeo (MP4/MOV; checar extensão), legenda com `validarLegenda`, `cover_url` opcional (JPEG público, via `validarUrlPublica`), `share_to_feed` opcional (booleano estrito).
2. `criarContainers()`: `criarContainer({ media_type: "REELS", video_url, caption, cover_url?, share_to_feed? })`.
3. **Tempo**: vídeo leva minutos pra ficar `FINISHED`, não cabe em 60s. Precisa de um estado "processando": o rascunho devolve o id já assinado com o container `IN_PROGRESS`, e um `GET /api/midia/status?id=...` (novo) faz uma checagem só. O `publicar` já re-checa `FINISHED` antes de publicar, então ele continua seguro.
4. Preview: a página já troca `<img>` por `<video>` quando a URL termina em `.mp4`/`.mov`. Mostrar a capa (`cover_url`) se vier.
5. Limites do Meta (duração, proporção recomendada 9:16, tamanho do arquivo): conferir na doc de Content Publishing na hora de implementar. Pela URL não dá pra checar; documentar e deixar o `status` `ERROR` do Meta explicar.
6. Testes: os mesmos do carrossel trocando os params + o fluxo "processando → status → publicar".

**Stories**
1. `validar()`: 1 item com `image_url` (JPEG) **ou** `video_url` (MP4/MOV), nunca os dois. **Sem legenda**: Stories não têm caption, então recusar `legenda` com 400 pra ninguém achar que ela vai aparecer.
2. `criarContainers()`: `criarContainer({ media_type: "STORIES", image_url | video_url })`.
3. Vídeo tem o mesmo problema de tempo do Reels (reusar o `GET status`).
4. Preview em proporção 9:16 em vez de 4:5.
5. Conferir na doc se Stories contam no limite de 50/24h. O `publicar` checa a cota de qualquer jeito.

Os dois exigem a mesma permissão do carrossel. O resto (auth, id assinado, limite, sanitização, publicar) já é genérico.

## Renovação de token

GitHub Action `refresh-token.yml`, cron semanal (segunda 06:00 UTC). Estende +60 dias e grava na Vercel. Itera **todas** as contas de `contas.js` — conta nova não precisa de secret novo. Uma conta com token morto não impede a renovação das outras.

Secrets do repo: `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_DEPLOY_HOOK`, (`VERCEL_TEAM_ID` se Team).

## Plugar no Meta

1. URL de callback: `https://manywata.vercel.app/api/webhook`
2. Verificar token: o mesmo `IG_VERIFY_TOKEN`
3. **Verificar e salvar** → handshake passa
4. Assinar o campo **`comments`** no app, e o `subscribed_apps` por conta (acima)

## Limites (regra do Meta, não do código)

- 1 private reply **por comentário**, dentro de **7 dias**.
- App precisa estar **Live**; em Desenvolvimento só funciona o botão "Teste" do painel.
- A conta dona do post precisa ser **pública**. Conta privada não gera notificação de comentário.
- Advanced Access é exigido pro campo `comments`.

## Gotcha de serverless

A função da Vercel encerra ao enviar a resposta. O envio do DM tem que ser `await`ado **antes** do `res.status(200)`, senão o fetch é cortado no meio: loga 200 e nada chega.
