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
| `PUBLICAR_SECRET` | senha da rota de publicação de mídia (ver [Publicação de mídia](#publicação-de-mídia)) |

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

`tests/midia.test.js` cobre a publicação de mídia com `fetch` falso (nunca chama o Instagram): autenticação, `confirmar`, validação, limite de 24h antes de criar container, ordem das chamadas ao Graph, status `ERROR`/timeout, permalink que falha depois de publicar, o CLI e que o token não aparece em resposta nem em log. Também cobre a hospedagem no Supabase Storage (`scripts/_storage.mjs`) com `fetch` falso: ordem e headers do upload, URLs públicas passadas à rota, recusa sem `SUPABASE_*` / arquivo não-JPEG / > 8 MB antes de subir qualquer coisa, limpeza depois de sucesso, de erro da rota e de upload parcial, `--base-url` e `--dry-run` sem Storage, e que a service role key nunca aparece em saída nem em erro.

## Insights orgânicos

```bash
npm run insights              # @watanabe.ia, últimos 12 posts
npm run insights:eterniza
npm run insights:todas
node scripts/insights.mjs --conta eterniza --limit 20 --no-save
```

Lê o token do `.env.local` (ou do ambiente) pelo nome que está em `contas.js`. JSON cru vai pra `output/insights-<slug>-<data>.json`.

Se der 401: o cron rotacionou o token na Vercel, recopie pro `.env.local`.

## Publicação de mídia

Publica no Instagram pela API oficial (Instagram API with Instagram Login), **numa chamada só**. Hoje: **carrossel** da @eternizacards. Reels e Stories já têm lugar no desenho, mas respondem 501 (ver [o que falta](#o-que-falta-para-reels-e-stories)).

### Fluxo de negócio

1. A especialista faz o briefing.
2. O Programador monta o carrossel (`slide-01.jpg`, `slide-02.jpg`, ... + `instagram-post.txt` com a legenda).
3. **O Vinicius vê as imagens e o texto antes** (os próprios arquivos da pasta de render) e aprova.
4. **Com o ok dele**, alguém roda o publicar (`confirmar: true` / `--confirmar`). A rota cria os containers e **posta direto**. Não tem rascunho nem preview do lado do servidor: o que for mandado é o que vai pro perfil.

⚠️ Publicar não tem volta pela API. Rode **uma vez**. Se der timeout ou falha de rede no meio, **confira o perfil antes de rodar de novo** (pode ter publicado).

### Endpoints

| Rota | Método | Auth | O que faz |
|------|--------|------|-----------|
| `/api/midia/publicar` | POST | `Authorization: Bearer <PUBLICAR_SECRET>` | valida, checa o limite de 24h, cria os containers, espera `FINISHED`, publica e devolve o `permalink` |
| `/api/carrossel/publicar` | POST | Bearer | alias com `tipo` fixo `CAROUSEL` (pode omitir; outro tipo → 400) |

Body:

```json
{
  "conta": "eterniza",
  "tipo": "CAROUSEL",
  "itens": [{"url": "https://..."}, {"url": "https://..."}],
  "legenda": "...",
  "confirmar": true
}
```

`confirmar` tem que ser o booleano `true`: `"true"`, `1` ou ausente dá 400.

Ordem do que a rota faz:

1. **Sem tocar no Instagram:** método (405), `PUBLICAR_SECRET` configurado (503), Bearer (401), `confirmar` (400), tipo (400/501), conta (400), itens/URLs/legenda (400), token da conta (503). Qualquer recusa aqui = **zero** chamada ao Graph.
2. `content_publishing_limit`: cota de 24h atingida → **429 sem criar nenhum container**.
3. Um container-filho por slide, na ordem; espera cada um `FINISHED`.
4. Container `CAROUSEL` com `children` na mesma ordem + `caption`; espera `FINISHED`.
5. `media_publish`.
6. Permalink. Se falhar aqui, o post **já está no ar**: volta **200 com `aviso`**, pra ninguém repetir achando que não foi.

Resposta 200: `{"mediaId", "permalink", "username", "quota": {"usado", "total"}, "conta", "tipo"}` (+ `aviso` se o permalink falhou).

Erros são `{"erro": "..."}`: **400** entrada inválida ou `confirmar` diferente de `true` · **401** sem Bearer ou Bearer errado · **405** método errado · **409** container já publicado · **410** container expirou no Instagram · **429** limite de 24h atingido (nada criado) · **501** tipo não implementado · **502** o Instagram recusou ou deu `ERROR` (mensagem do Meta, sem token; nada publicado) · **503** `PUBLICAR_SECRET` ou token da conta ausente · **504** container não ficou pronto a tempo (nada publicado).

Se der 502/504 em container, sobram containers órfãos no Instagram. Eles não aparecem no perfil e o Meta descarta em 24h.

### Exemplo (curl)

```bash
curl -sX POST https://manywata.vercel.app/api/midia/publicar \
  -H "Authorization: Bearer $PUBLICAR_SECRET" -H "Content-Type: application/json" \
  -d '{
    "conta": "eterniza",
    "tipo": "CAROUSEL",
    "itens": [{"url": "https://exemplo.com/c1/slide-01.jpg"}, {"url": "https://exemplo.com/c1/slide-02.jpg"}],
    "legenda": "Sua carta, seu nome. #tcg",
    "confirmar": true
  }'
# → 200 {"mediaId": "...", "permalink": "https://www.instagram.com/p/...", "username": "eternizacards", "quota": {"usado": 4, "total": 50}, ...}
```

### CLI

```bash
# 1. credenciais do Storage, do arquivo protegido (só no terminal do operador)
set -a; . /home/box/.secrets/supabase-eterniza.env; set +a

# 2. conferir o que seria feito, sem subir nem chamar nada
node scripts/midia.mjs publicar carrossel/drop-natal/render --confirmar --dry-run

# 3. só com o ok do Vinicius nas imagens e no texto
node scripts/midia.mjs publicar carrossel/drop-natal/render --confirmar
npm run midia:publicar -- carrossel/drop-natal/render --confirmar --conta eterniza

# alternativa: imagens já publicadas em outro lugar (não sobe nem apaga nada)
node scripts/midia.mjs publicar carrossel/drop-natal/render --base-url https://exemplo.com/c1 --confirmar
```

- Lê `slide-NN.jpg` da pasta em ordem numérica (`slide-2` antes de `slide-10`) e a legenda de `instagram-post.txt` na mesma pasta.
- **Sem `--confirmar` ele recusa**, inclusive com `--dry-run`.
- `--conta` padrão: `eterniza`.
- **Sem `--base-url`** (padrão): sobe os JPEGs pro Supabase Storage, publica e apaga (ver [hospedagem](#hospedagem-das-imagens)).
- **Com `--base-url`**: monta as URLs como `<--base-url>/<nome-do-arquivo>`; os JPEGs precisam já estar nesse endereço. Não toca no Storage e não precisa das `SUPABASE_*`.
- `--dry-run`: não sobe nada e não chama a rota. Mostra os caminhos no bucket, as URLs públicas e o corpo que mandaria. Não exige as credenciais (só avisa se faltarem).
- Lê `PUBLICAR_SECRET` e `MANYWATA_URL` (padrão `https://manywata.vercel.app`) do ambiente ou do `.env.local`. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` vêm **só do ambiente**. Nunca imprime segredo nem chave; mensagens de erro passam por `sanitizar()`.

### Hospedagem das imagens

Quem baixa as imagens é o **servidor do Meta**, não a rota. Então cada slide precisa estar numa **URL https pública**, acessível de fora sem login, e ser **JPEG**. A rota recusa `http`, `localhost`, IP privado e extensão que não seja `.jpg`/`.jpeg`. Se a URL não abrir de fora, o Meta devolve status `ERROR` e a rota responde 502 sem publicar.

**Solução: bucket `instagram-temp` no Supabase do eternizacards**, usado só durante a publicação.

- Bucket **público** (o Meta precisa baixar sem login), aceita só `image/jpeg`, máximo 8 MB por arquivo.
- Plano Free do Supabase: **sem custo** dentro de 1 GB de armazenamento e 5 GB de tráfego por mês. Como os arquivos são apagados logo depois de publicar, o armazenamento fica perto de zero; o tráfego é basicamente o download do Meta (um carrossel de 10 slides de ~500 KB ≈ 5 MB).
- Quem sobe e apaga é o **CLI, na máquina do operador**. A rota na Vercel não sabe do Supabase, e as `SUPABASE_*` **não vão pra Vercel**.

**Credenciais.** `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` ficam num arquivo protegido do operador (`/home/box/.secrets/supabase-eterniza.env`, `chmod 600`). Carregue no terminal antes de rodar:

```bash
set -a; . /home/box/.secrets/supabase-eterniza.env; set +a
```

O CLI só lê essas duas do ambiente: nunca de argumento de linha de comando (vazaria no histórico e no `ps`), nunca do `.env.local`. A service role key passa por cima de RLS, então **não cole em lugar nenhum**. Ela nunca é impressa, e qualquer texto de erro passa por `sanitizar()` antes de aparecer.

**Fluxo do `publicar` sem `--base-url`:**

1. **Sem rede:** `--confirmar`, pasta, 2 a 10 `slide-NN.jpg`, legenda (`instagram-post.txt`), `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `PUBLICAR_SECRET`, e cada arquivo com **até 8 MB** e começando com os bytes JPEG (`FF D8 FF`). Qualquer falha aqui = nada sobe.
2. **Upload**, na ordem dos slides, pra `instagram-temp/<slug>-<AAAAMMDD-HHMM>-<aleatório>/slide-NN.jpg` (`POST /storage/v1/object/instagram-temp/<caminho>` com `x-upsert: false`). O slug é o nome da pasta pai de `render` (ou da própria pasta, se ela não se chama `render`), só `[a-z0-9-]`. Hora em UTC.
3. **Publica**: chama `POST /api/midia/publicar` com as URLs públicas `<SUPABASE_URL>/storage/v1/object/public/instagram-temp/<caminho>`.
4. **Apaga** os arquivos que subiu (`DELETE /storage/v1/object/instagram-temp` com `{"prefixes": [...]}`). Isso roda **sempre**: depois de publicar, depois de erro da rota, depois de upload parcial (apaga o que chegou a subir) e também quando o resultado é incerto (timeout ou falha de rede chamando a rota).

Por que apagar mesmo no caso incerto: o Meta baixa as imagens quando cria os containers, então o post publicado não depende mais delas. Se o apagar pegar uma publicação ainda em andamento, o pior caso é o container dar `ERROR` e nada ir pro ar. Nos dois casos a mensagem manda **conferir o perfil antes de rodar de novo**. Rodar de novo usa uma pasta nova no bucket (o carimbo muda), então não tem colisão.

Se **apagar falhar**, o publish continua valendo (código de saída 0) e o CLI imprime um aviso com os caminhos pra apagar à mão no painel do Supabase (Storage → `instagram-temp`). Mesma coisa se você interromper com Ctrl+C no meio: confira o bucket e apague o que tiver sobrado.

### Envs

| Var | Onde | Tipo | Observação |
|-----|------|------|------------|
| `PUBLICAR_SECRET` | **a criar**: Vercel (production) + `.env.local` de quem usa o CLI | **Sensitive** serve, ninguém precisa ler de volta | mínimo 32 caracteres: `openssl rand -hex 32`. Sem ela a rota responde 503 |
| `IG_ACCESS_TOKEN_ETERNIZA` | já existe, **só no target production** | Encrypted | em deploy de preview a rota responde 503 ("token não configurado"), então **preview da Vercel não publica**. Pra testar de ponta a ponta tem que ser em produção |
| `MANYWATA_URL` | só `.env.local` (CLI) | — | opcional |
| `SUPABASE_URL` | **só no ambiente local do operador**, carregada de `/home/box/.secrets/supabase-eterniza.env`. **Não na Vercel**, não no `.env.local` | — | `https://<projeto>.supabase.co` do eternizacards |
| `SUPABASE_SERVICE_ROLE_KEY` | idem | — | passa por cima de RLS: nunca em argv, log ou chat. Só o CLI usa, pra subir/apagar no `instagram-temp` |

Depois de criar: **`vercel --prod` de novo**.

### Limites do Meta (regra deles, não do código)

- **50 posts publicados via API por conta a cada 24h**. A rota checa `content_publishing_limit` antes de criar qualquer container e devolve 429 se a cota acabou.
- Carrossel: **2 a 10 itens**, imagens **JPEG** em URL pública. Mais de 10 o Meta recusa.
- Legenda: até **2200 caracteres**, **30 hashtags** e **20 menções (@)**.
- A conta precisa ser profissional (Business/Creator), e o token precisa da permissão `instagram_business_content_publish`.

### Como funciona por dentro

- `api/_lib/` não vira rota na Vercel (prefixo `_`). Lá ficam `seguranca.js` (auth, sanitização, validação de URL), `instagram-publicacao.js` (cliente do Graph com `fetch`/`sleep`/`now` injetáveis + registro `TIPOS`) e `rotas-midia.js` (a rota).
- **Sem banco nem store** na rota: cada chamada é independente. O único armazenamento é o bucket temporário que o CLI usa (`scripts/_storage.mjs`: `lerCredenciaisStorage`, `lerSlidesJpeg`, `enviarParaStorage`, `apagarDoStorage`, todos com `fetch` injetável).
- Tempo: a função tem 60s (`vercel.json`). Os containers têm até ~45s; o resto fica pro `media_publish` e o permalink. Imagem costuma ficar `FINISHED` na hora.
- O token vai no header `Authorization: Bearer`, nunca na URL. Toda mensagem de erro e de log passa por `sanitizar()`, que tira `access_token=`, `Bearer ...` e os segredos conhecidos.

### O que falta para Reels e Stories

O registro `TIPOS` em `api/_lib/instagram-publicacao.js` já tem as entradas `REELS` e `STORIES` com `implementado: false` (a rota responde 501). Pra ligar cada uma:

**Reels**
1. `validar()`: exatamente 1 item com URL https de vídeo (MP4/MOV; checar extensão), legenda com `validarLegenda`, `cover_url` opcional (JPEG público, via `validarUrlPublica`), `share_to_feed` opcional (booleano estrito).
2. `criarContainers()`: `criarContainer({ media_type: "REELS", video_url, caption, cover_url?, share_to_feed? })`.
3. **Tempo**: vídeo leva minutos pra ficar `FINISHED`, não cabe em 60s. Vai precisar dividir em duas chamadas (uma cria o container e devolve o id, outra checa o status e publica quando estiver `FINISHED`), mantendo `confirmar: true` e a checagem de cota antes de criar.
4. Limites do Meta (duração, proporção recomendada 9:16, tamanho do arquivo): conferir na doc de Content Publishing na hora de implementar. Pela URL não dá pra checar; documentar e deixar o `status` `ERROR` do Meta explicar.
5. Hospedagem: o bucket `instagram-temp` só aceita `image/jpeg` até 8 MB. Vídeo vai precisar de outra regra de MIME/tamanho (ou outro bucket), e de manter o arquivo até o container ficar `FINISHED`, que pode levar minutos.
6. Testes: os mesmos do carrossel trocando os params + o fluxo em duas chamadas.

**Stories**
1. `validar()`: 1 item com `image_url` (JPEG) **ou** `video_url` (MP4/MOV), nunca os dois. **Sem legenda**: Stories não têm caption, então recusar `legenda` com 400 pra ninguém achar que ela vai aparecer.
2. `criarContainers()`: `criarContainer({ media_type: "STORIES", image_url | video_url })`.
3. Imagem cabe no fluxo de uma chamada. Vídeo tem o mesmo problema de tempo do Reels.
4. Conferir na doc se Stories contam no limite de 50/24h. A rota checa a cota de qualquer jeito.

Os dois exigem a mesma permissão do carrossel. O resto (auth, `confirmar`, limite, sanitização, publish, permalink) já é genérico.

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
