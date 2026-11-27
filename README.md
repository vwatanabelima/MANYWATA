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

`tests/midia.test.js` cobre a publicação de mídia com `fetch` falso (nunca chama o Instagram): autenticação, `confirmar`, validação, limite de 24h antes de criar container, ordem das chamadas ao Graph, status `ERROR`/timeout, permalink que falha depois de publicar, o CLI e que o token não aparece em resposta nem em log. Usa um relógio falso com agenda (esperas em paralelo andam juntas, ninguém espera de verdade) pra cobrir: carrossel de 9 slides com cada `POST /media` levando 6s, filhos criados em paralelo com `children` na ordem certa mesmo com respostas fora de ordem, `aguardarStatus` com orçamento 0/negativo (checa e espera o mínimo), mensagem de timeout com o tempo real, `publicado: false` e o `vercel.json` batendo com `api/_lib/tempos.js`. Também cobre a hospedagem no Supabase Storage (`scripts/_storage.mjs`) com `fetch` falso: ordem e headers do upload, URLs públicas passadas à rota, recusa sem `SUPABASE_*` / arquivo não-JPEG / > 8 MB antes de subir qualquer coisa, limpeza só quando o resultado é definido (sucesso, erro com `publicado: false`, upload parcial), temporários mantidos quando é indefinido (504, rede, timeout do CLI, resposta sem detalhe), o subcomando `limpar`, `--base-url` e `--dry-run` sem Storage, e que a service role key nunca aparece em saída nem em erro. Stories: params exatos do container (`image_url` + `media_type: "STORIES"`, sem `caption`), 1 item só, legenda recusada, não-JPEG, 503/401/`confirmar` sem fetch, cota cheia sem container, story sem permalink → 200 sem aviso, story de vídeo → 501, alias do carrossel recusando `STORIES` e `REELS`, o subcomando `story` do CLI (upload de 1 arquivo, limpeza, 504 mantém o arquivo, `--dry-run`, aviso de dimensões) e a leitura de largura x altura do JPEG. Reels: params exatos do container (`media_type: "REELS"` + `video_url` + `caption`; `cover_url`/`share_to_feed` só quando enviados), `video_url` ou `url` `.mp4`/`.mov`/`.m4v`, 0/2 itens, JPEG, `http`, IP privado e `share_to_feed` não booleano → 400 sem fetch, `ERROR`/`EXPIRED`/timeout sem `media_publish`, orçamento de 270s, cota cheia, permalink ausente → 200 com aviso; e o subcomando `reels` do CLI com `ffprobe` falso e MP4 mínimo (só o box `ftyp`; tamanhos grandes com arquivo esparso): dry-run sem `--confirmar` e com `--dry-run` sem nenhum fetch, upload `video/mp4`, limpeza igual, recusa sem rede (sem `--legenda`, não-MP4, duração fora de 3s–15min, > 300 MB, > 8 MB do bucket no `--confirmar`), aviso do bucket no dry-run, recomendações que só avisam e que chave/segredo não aparecem na saída.

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

Publica no Instagram pela API oficial (Instagram API with Instagram Login), **numa chamada só**. Hoje: **carrossel**, **story de imagem** (ver [Stories](#stories)) e **Reels** (ver [Reels](#reels), com ressalvas de tempo e de hospedagem) da @eternizacards. Story de vídeo já tem lugar no desenho, mas responde 501 (ver [o que falta](#o-que-falta-para-stories-de-vídeo)).

### Fluxo de negócio

1. A especialista faz o briefing.
2. O Programador monta o carrossel (`slide-01.jpg`, `slide-02.jpg`, ... + `instagram-post.txt` com a legenda).
3. **O Vinicius vê as imagens e o texto antes** (os próprios arquivos da pasta de render) e aprova.
4. **Com o ok dele**, alguém roda o publicar (`confirmar: true` / `--confirmar`). A rota cria os containers e **posta direto**. Não tem rascunho nem preview do lado do servidor: o que for mandado é o que vai pro perfil.

⚠️ Publicar não tem volta pela API. Rode **uma vez**. Se der timeout ou falha de rede no meio, **confira o perfil antes de rodar de novo** (pode ter publicado). Nesses casos o CLI mantém as imagens no bucket e mostra o comando `limpar` pra usar depois.

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

Story: mesmo body com `"tipo": "STORIES"`, **exatamente 1 item** e **sem `legenda`** (ver [Stories](#stories)).

Reels: `"tipo": "REELS"`, **exatamente 1 item** `{"video_url": "https://..."}` (ou `{"url": "https://.../x.mp4"}`), `legenda` opcional e, opcionais, `cover_url` (JPEG) e `share_to_feed` (booleano) no corpo (ver [Reels](#reels)).

Ordem do que a rota faz:

1. **Sem tocar no Instagram:** método (405), `PUBLICAR_SECRET` configurado (503), Bearer (401), `confirmar` (400), tipo (400/501), conta (400), itens/URLs/legenda (400), token da conta (503). Qualquer recusa aqui = **zero** chamada ao Graph.
2. `content_publishing_limit`: cota de 24h atingida → **429 sem criar nenhum container**.
3. Um container-filho por slide, **todos ao mesmo tempo** (cada `POST /media` leva segundos porque o Meta baixa a imagem antes de responder; em sequência, 9 slides estouravam o tempo). Os ids voltam na ordem dos slides, não na ordem em que o Meta responde. Espera os filhos `FINISHED`, também em paralelo; se um falhar (criação recusada ou `ERROR`), a espera dos outros é cancelada e o erro diz qual slide foi (`slide 5 de 9: ...`), sem publicar nada.
4. Container `CAROUSEL` com `children` na mesma ordem + `caption`; espera `FINISHED`.
5. `media_publish`.
6. Permalink. Se falhar aqui, o post **já está no ar**: volta **200 com `aviso`**, pra ninguém repetir achando que não foi.

No story, os passos 3 e 4 viram **um** container (`image_url` + `media_type: "STORIES"`, sem `caption`) e, no passo 6, ficar sem permalink é normal: volta 200 com `permalink: null` e **sem** `aviso`.

No Reels, os passos 3 e 4 também viram **um** container (`media_type: "REELS"` + `video_url` + `caption`, e `cover_url`/`share_to_feed` se vierem), com orçamento de **270s** em vez de 240s. Reels tem permalink: se faltar, volta 200 **com** `aviso`, igual ao carrossel.

Resposta 200: `{"mediaId", "permalink", "username", "quota": {"usado", "total"}, "conta", "tipo"}` (+ `aviso` se o permalink do carrossel/Reels falhou ou não veio).

Erros são `{"erro": "...", "publicado": false}`. O `publicado: false` só vem quando o `media_publish` **não foi chamado** (certeza de que nada foi pro perfil). Se o `media_publish` foi chamado e deu erro, o campo **não vem**: resultado indefinido, confira o perfil. Status: **400** entrada inválida ou `confirmar` diferente de `true` · **401** sem Bearer ou Bearer errado · **405** método errado · **409** container já publicado · **410** container expirou no Instagram · **429** limite de 24h atingido (nada criado) · **501** tipo não implementado (hoje só story de vídeo) · **502** o Instagram recusou ou deu `ERROR` (mensagem do Meta, sem token; nada publicado) · **503** `PUBLICAR_SECRET` ou token da conta ausente · **504** container não ficou pronto a tempo (nada publicado; a mensagem traz o tempo que a rota realmente esperou e o último status, ex.: `não ficou pronto em 240s (último status: IN_PROGRESS)`).

### Limites de tempo

Todos em [`api/_lib/tempos.js`](api/_lib/tempos.js), que explica a relação entre eles:

| O quê | Valor | Observação |
|-------|-------|------------|
| `maxDuration` da função (`vercel.json`, `api/midia/*.js` e `api/carrossel/*.js`) | **300s** | plano Hobby com Fluid Compute permite até 300s. Um teste confere que o `vercel.json` bate com `MAX_DURATION_S` |
| Orçamento dos containers (criar + esperar `FINISHED`) | **240s** | os 60s restantes são folga pra espera mínima, `CAROUSEL`, `media_publish`, permalink e resposta |
| Orçamento do container do Reels (`ORCAMENTO_REELS_MS`) | **270s** | um container só, então sobra menos coisa pra depois: 30s pra `media_publish`, permalink e resposta. Vídeo longo **ainda pode estourar** (504, nada publicado) |
| Espera mínima por container | **10s e 3 checagens** | mesmo que o orçamento já tenha acabado (ou seja zero), a rota checa de verdade e espera isso antes de dar 504 |
| Polling do `status_code` | **2s → 5s** | cresce 1,5x a cada volta |
| Timeout do CLI chamando a rota | **330s** | maior que o `maxDuration`, senão o CLI desistiria antes da resposta |

Mudou o `maxDuration`? Mude `vercel.json` e `tempos.js` juntos (o teste reclama se não baterem). Se o Fluid Compute estiver desligado no projeto, o Hobby volta a limitar em 60s e o deploy recusa o `maxDuration: 300`.

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

# story de 1 imagem (ver "Stories" abaixo)
node scripts/midia.mjs story carrossel/drop-natal/story.jpg --confirmar --dry-run
node scripts/midia.mjs story carrossel/drop-natal/story.jpg --confirmar

# Reels de 1 vídeo (ver "Reels" abaixo). Sem --confirmar é dry-run.
node scripts/midia.mjs reels reels/drop-natal.mp4 --legenda reels/drop-natal.txt
node scripts/midia.mjs reels reels/drop-natal.mp4 --legenda reels/drop-natal.txt --confirmar

# apagar os temporários de uma publicação de resultado indefinido (depois de conferir o perfil)
node scripts/midia.mjs limpar drop-natal-20261115-0105-a1b2c3 --confirmar
```

- Lê `slide-NN.jpg` da pasta em ordem numérica (`slide-2` antes de `slide-10`) e a legenda de `instagram-post.txt` na mesma pasta.
- **Sem `--confirmar` ele recusa**, inclusive com `--dry-run`. Exceção: `reels` sem `--confirmar` faz dry-run (ver [Reels](#reels)).
- `--conta` padrão: `eterniza`.
- A chamada à rota pode levar **alguns minutos** (até 300s). O CLI espera até 330s e desiste (resultado indefinido, ver abaixo).
- **Sem `--base-url`** (padrão): sobe os JPEGs pro Supabase Storage, publica e apaga **quando o resultado é definido** (ver [hospedagem](#hospedagem-das-imagens)).
- `limpar <prefixo> --confirmar`: apaga **uma** pasta do bucket `instagram-temp` (lista o que tem nela e apaga). O prefixo é o que o CLI imprime (`<slug>-<AAAAMMDD-HHMM>-<aleatório>`; aceita também `instagram-temp/<prefixo>/`). Só `a-z`, `0-9` e `-`: nada de barra, `..` ou vazio. **Sem `--confirmar` recusa** sem chamar nada. Precisa das `SUPABASE_*` no ambiente.
- **Com `--base-url`**: monta as URLs como `<--base-url>/<nome-do-arquivo>`; os JPEGs precisam já estar nesse endereço. Não toca no Storage e não precisa das `SUPABASE_*`.
- `--dry-run`: não sobe nada e não chama a rota. Mostra os caminhos no bucket, as URLs públicas e o corpo que mandaria. Não exige as credenciais (só avisa se faltarem).
- Lê `PUBLICAR_SECRET` e `MANYWATA_URL` (padrão `https://manywata.vercel.app`) do ambiente ou do `.env.local`. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` vêm **só do ambiente**. Nunca imprime segredo nem chave; mensagens de erro passam por `sanitizar()`.

### Stories

Story de **uma imagem**, publicado pela mesma rota (`POST /api/midia/publicar`, `"tipo": "STORIES"`) e pelo mesmo fluxo do carrossel: `confirmar: true`, cota de 24h antes de criar o container, `media_publish`. O alias `/api/carrossel/publicar` continua **só** carrossel (story lá dá 400).

**Formato:**
- **1 imagem JPEG**, em URL https pública (mesma regra da [hospedagem](#hospedagem-das-imagens)). 2 itens ou mais → 400 (publique um story por vez).
- **1080x1920** (9:16) é o recomendado. Outro tamanho o Instagram aceita, mas pode cortar ou pôr borda.
- **Sem legenda.** Story não tem caption na API. Se vier `legenda` não vazia, a rota responde **400** em vez de ignorar, pra ninguém achar que o texto vai aparecer. Texto do story vai **na própria imagem**.
- **Vídeo ainda não**: item `.mp4`/`.mov`/`.m4v` ou com `video_url` → **501** (ver [o que falta](#o-que-falta-para-stories-de-vídeo)). Vídeo no feed/aba Reels: use [Reels](#reels).
- **Stickers interativos** (enquete, link, pergunta, menção clicável, música, contagem regressiva) **não são suportados pela API de publicação**: o story sai só com a imagem. Se precisar de sticker, publique pelo app.

  Conferido na documentação oficial da Meta em 15/11/2026: a API de publicação **não suporta stickers em stories**. A doc cita link, enquete e local, e por extensão isso vale também pra caixa de pergunta, quiz, figurinhas/GIF e música. A única exceção é **mencionar usuários pelo parâmetro `user_tags`** (sem sticker), que este código **ainda não implementa**. Outras limitações da publicação: só JPEG, sem shopping tags e sem filtros. Na prática, a interação vai no texto da arte (ex.: "responde no direct"); se quiser sticker, adicione à mão no app. Fontes: [IG User Media, seção "Story Limitations"](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media) ("Publishing stickers (i.e., link, poll, location) is not supported; however mentioning users without a sticker is supported.") e [Content Publishing, seção Limitations](https://developers.facebook.com/docs/instagram-platform/content-publishing/).

**Permalink:** story pode voltar sem permalink (some em 24h e o Graph nem sempre devolve). Isso **não é erro**: a resposta é 200 com `mediaId` e `permalink: null` (ou o link, se vier), sem `aviso`. O `mediaId` já confirma a publicação.

```bash
curl -sX POST https://manywata.vercel.app/api/midia/publicar \
  -H "Authorization: Bearer $PUBLICAR_SECRET" -H "Content-Type: application/json" \
  -d '{"conta": "eterniza", "tipo": "STORIES", "itens": [{"url": "https://exemplo.com/st/promo.jpg"}], "confirmar": true}'
# → 200 {"mediaId": "...", "permalink": null, "username": "eternizacards", "quota": {...}, "conta": "eterniza", "tipo": "STORIES"}
```

**CLI:**

```bash
node scripts/midia.mjs story <arquivo.jpg> --confirmar [--conta eterniza] [--base-url <url>] [--dry-run]
```

- **Sem `--confirmar` recusa**, inclusive com `--dry-run`.
- Antes de qualquer rede: o arquivo precisa começar com `FF D8 FF` (JPEG) e ter **até 8 MB**. Lê largura x altura do cabeçalho do JPEG e **avisa** (não bloqueia) se não for 1080x1920. A leitura não aplica a rotação do EXIF.
- Sem `--base-url`: sobe pra `instagram-temp/<nome-do-arquivo-sanitizado>-<AAAAMMDD-HHMM>-<aleatório>/<nome-do-arquivo-sanitizado>.jpg`, chama a rota com `tipo: "STORIES"` (sem `legenda` no corpo) e segue **a mesma regra de limpeza do carrossel** ([tabela](#hospedagem-das-imagens)): apaga só com resultado definido; 504, falha de rede, timeout ou resposta indefinida **mantêm** o arquivo e mostram o comando `limpar`.
- Com `--base-url`: a URL é `<--base-url>/<nome-do-arquivo>`; não toca no Storage.
- `--dry-run`: não sobe nem chama nada; mostra o caminho no bucket, a URL pública e o corpo.

### Reels

Reels de **um vídeo**, pela mesma rota (`POST /api/midia/publicar`, `"tipo": "REELS"`) e pelo mesmo fluxo: `confirmar: true`, cota de 24h antes de criar o container, container `FINISHED`, `media_publish`, permalink. O alias `/api/carrossel/publicar` continua **só** carrossel (Reels lá dá 400).

**Na rota:**
- **Exatamente 1 item**, URL https pública: `itens[0].video_url` (o caminho pode não ter extensão, mas se tiver precisa ser de vídeo) **ou** `itens[0].url` terminando em `.mp4`/`.mov`/`.m4v` (maiúscula ou minúscula). JPEG/imagem, item sem URL, `http`, `localhost`/IP privado → **400** sem tocar no Instagram.
- `legenda`: mesmas regras do carrossel (2200 caracteres, 30 hashtags, 20 menções). Vazia ou ausente → o container vai **sem** `caption`.
- `cover_url` (opcional, no corpo): capa em JPEG público. `share_to_feed` (opcional): **booleano estrito** (`"true"`, `1`, `null` → 400). Só entram nos params do container quando vêm no corpo.
- Container `ERROR` (502) ou `EXPIRED` (410) abortam **sem** `media_publish` (`publicado: false`). A mensagem do `ERROR` lembra os limites do Reels.

```bash
curl -sX POST https://manywata.vercel.app/api/midia/publicar \
  -H "Authorization: Bearer $PUBLICAR_SECRET" -H "Content-Type: application/json" \
  -d '{"conta": "eterniza", "tipo": "REELS", "itens": [{"video_url": "https://exemplo.com/rl/drop.mp4"}], "legenda": "Drop de Natal. #tcg", "confirmar": true}'
# → 200 {"mediaId": "...", "permalink": "https://www.instagram.com/reel/...", ..., "tipo": "REELS"}
```

⚠️ **Ressalvas (leia antes de publicar vídeo):**
- **Tempo.** A rota continua sendo **uma chamada só** (como carrossel e story), com 300s de `maxDuration` (plano Hobby). O Reels usa 270s esperando o container ficar `FINISHED`. Vídeo longo ou pesado **pode não ficar pronto a tempo**: a rota responde **504** sem publicar e o CLI mantém o arquivo no bucket (resultado indefinido; o Instagram pode seguir processando o container). Dividir em duas chamadas (cria o container / checa e publica) é outro desenho e **não entra agora**.
- **Hospedagem.** O bucket `instagram-temp` **hoje aceita só `image/jpeg` até 8 MB**. Então, pelo Storage, o upload de vídeo vai ser recusado. O CLI sabe disso: no `--confirmar` ele **recusa antes de qualquer rede** se o MP4 passa de 8 MB, e no dry-run só avisa. Liberar `video/mp4` e subir o limite de arquivo do bucket (no máximo até o teto do plano Free, **50 MB**) **depende do ok do Vinicius** e não gera custo de plano. Atenção: o teto Free pode ser 50.000.000 bytes ou 50 MiB. O vídeo de ~50,65 MB (**50.653.437 bytes**, ~48,31 MiB) cabe se for 50 MiB, mas **não cabe** se for 50.000.000 bytes, mesmo depois de ajustar o bucket. Nesse caso, reencode um pouco menor. Enquanto isso, `--base-url` com o vídeo já numa URL https pública funciona.
- **TUS** (upload resumível) **não entra** e não contorna o limite do bucket (o limite é do bucket, não do jeito de subir). O CLI usa o upload padrão (um `POST`), sem dependência nova. Se o bucket for ampliado no futuro, arquivos > 6 MB sobem de forma mais confiável por TUS, mas o `POST` padrão da API do Storage aceita até o limite do plano.

**CLI:**

```bash
node scripts/midia.mjs reels <arquivo.mp4> --legenda <arquivo.txt> --confirmar [--conta eterniza] [--base-url <url>] [--dry-run]
npm run midia:reels -- reels/drop-natal.mp4 --legenda reels/drop-natal.txt
```

- **Sem `--confirmar` não recusa: faz dry-run** (diferente de `publicar`/`story`). Valida o vídeo, mostra o caminho no bucket, a URL pública e o corpo que mandaria, e **não chama rede nenhuma** (nem Storage, nem a rota). `--dry-run` faz o mesmo, com ou sem `--confirmar`. Não exige `SUPABASE_*` nem `PUBLICAR_SECRET` (só avisa se faltarem).
- Só **`--confirmar` sem `--dry-run`** publica.
- **`--legenda <arquivo.txt>` é obrigatório** (não procura `instagram-post.txt` sozinho). A legenda passa pelas mesmas regras da rota antes de qualquer rede.
- **Validação local, antes de qualquer rede** (`scripts/_video.mjs`):
  - bloqueia: arquivo inexistente ou que não é arquivo; extensão diferente de `.mp4`/`.mov`/`.m4v`; sem a assinatura `ftyp` de MP4/MOV; **mais de 300 MB** (limite do Instagram pra Reels);
  - com **`ffprobe`** no `PATH` (só usa se existir; o CLI não instala nada): bloqueia **duração fora de 3s a 15min**, container que não é mp4/mov e arquivo sem faixa de vídeo; **avisa** (não bloqueia) o que é recomendação: proporção diferente de 9:16 (1080x1920 é o típico; vídeo gravado em pé com rotação conta certo), largura > 1920, fps fora de 23–60, vídeo que não é H.264/HEVC, áudio que não é AAC, vídeo > 25 Mbps, áudio > 128 kbps;
  - **sem `ffprobe`**: confere existência, tamanho e assinatura e **avisa** que a duração não foi conferida, sem bloquear.
- Sem `--base-url`: sobe pra `instagram-temp/<nome-do-arquivo-sanitizado>-<AAAAMMDD-HHMM>-<aleatório>/<nome-do-arquivo-sanitizado>.mp4` com `Content-Type: video/mp4` (`.mov` sobe como `video/quicktime`), chama a rota com `tipo: "REELS"`, `itens: [{"video_url": ...}]` e a legenda, e segue **a mesma regra de limpeza** do carrossel e do story ([tabela](#hospedagem-das-imagens)). Hoje, com o bucket em 8 MB / só JPEG, um MP4 > 8 MB é recusado aqui, antes de qualquer rede, com a explicação acima.
- Com `--base-url`: a URL é `<--base-url>/<nome-do-arquivo>`; não sobe nem apaga nada, e o limite do bucket não se aplica.
- O log diz `Publicando reels (1 vídeo)`.

Exemplo do aviso no dry-run de um MP4 de 50.653.437 bytes:

```
aviso: drop.mp4 tem 48,31 MiB (50,65 MB, 50.653.437 bytes). O bucket instagram-temp hoje aceita só image/jpeg até 8 MB: o Storage vai recusar este upload.
  - TUS (upload resumível) não resolve: o limite é do bucket, não do jeito de subir.
  - Liberar video/mp4 e subir o limite de arquivo do bucket (no máximo até o teto do plano Free, 50 MB) depende do ok do Vinicius. Não muda o plano nem gera custo.
  - Se o teto Free for 50.000.000 bytes (e não 50 MiB), este arquivo não cabe nem depois de ajustar o bucket: reencode o vídeo um pouco menor.
  - Alternativa: --base-url com o vídeo já numa URL https pública.
```

Com `--confirmar`, a mesma mensagem vem como erro (`Recusado: ...` + `Nada foi enviado.`).

### Hospedagem das imagens

Quem baixa as imagens é o **servidor do Meta**, não a rota. Então cada slide precisa estar numa **URL https pública**, acessível de fora sem login, e ser **JPEG**. A rota recusa `http`, `localhost`, IP privado e extensão que não seja `.jpg`/`.jpeg`. Se a URL não abrir de fora, o Meta devolve status `ERROR` e a rota responde 502 sem publicar.

**Solução: bucket `instagram-temp` no Supabase do eternizacards**, usado só durante a publicação.

- Bucket **público** (o Meta precisa baixar sem login), aceita só `image/jpeg`, máximo 8 MB por arquivo (`MAX_BYTES` em `scripts/_storage.mjs`). Vídeo do Reels **não passa** hoje; mudar isso (liberar `video/mp4`, subir o limite até no máximo os 50 MB do Free) depende do ok do Vinicius, e aí se atualiza `MAX_BYTES` junto (ver [Reels](#reels)).
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
4. **Apaga** os arquivos que subiu (`DELETE /storage/v1/object/instagram-temp` com `{"prefixes": [...]}`), **só quando o resultado é definido**:

| Resultado | Apaga? |
|-----------|--------|
| 200 com `mediaId` (publicou) | **sim** |
| Upload falhou antes de chamar a rota (apaga o que chegou a subir) | **sim** |
| Erro da rota com corpo JSON `{"erro", "publicado": false}` e status **diferente de 504** (ex.: 400, 429, 502 de container `ERROR`) | **sim** |
| **504**, inclusive o 504 da nossa rota com `publicado: false` (container não ficou pronto) | **não** |
| Falha de rede, timeout do CLI (330s), resposta sem JSON / sem detalhe (ex.: 504 da própria Vercel), 200 sem `mediaId` | **não** |
| Erro sem `publicado: false` (o `media_publish` foi chamado e falhou) | **não** |

Quando **não** apaga, o CLI sai com erro, imprime os caminhos e o que fazer:

1. Conferir o perfil (pode levar alguns minutos pra aparecer).
2. Se **não** publicou: rodar o `publicar` de novo. Usa uma pasta nova no bucket (o carimbo muda), então não colide com a anterior.
3. Depois, publicado ou não, apagar os temporários: `node scripts/midia.mjs limpar <prefixo> --confirmar` (ou à mão no painel).

Por que não apagar no caso indefinido: o Instagram pode ainda estar processando containers que apontam pra essas URLs. Apagar no meio pode deixar um post quebrado ou fazer um retry falhar. E por que o 504 da nossa rota também entra aqui, se ela garante que o `media_publish` não foi chamado: os containers continuam processando do lado do Meta depois que a rota desiste, e a regra fica conservadora de propósito. Manter custa alguns KB no bucket por algumas horas; apagar cedo demais não tem volta.

Se **apagar falhar**, o publish continua valendo (código de saída 0) e o CLI imprime um aviso com o comando `limpar` e os caminhos. Se você interromper com Ctrl+C no meio, o resultado é indefinido: confira o perfil e depois rode o `limpar` com o prefixo que apareceu em "Subindo ... para instagram-temp/<prefixo>/".

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
- Story: 1 mídia, sem legenda, recomendado 1080x1920. Stickers interativos não existem na API de publicação.
- Reels: MP4/MOV, **3s a 15min**, até **300 MB**; recomendado 9:16 (1080x1920), 23–60 fps, H.264/HEVC até 25 Mbps, áudio AAC até 128 kbps. O processamento do vídeo no Meta pode levar minutos.
- A conta precisa ser profissional (Business/Creator), e o token precisa da permissão `instagram_business_content_publish`.

### Como funciona por dentro

- `api/_lib/` não vira rota na Vercel (prefixo `_`). Lá ficam `seguranca.js` (auth, sanitização, validação de URL), `instagram-publicacao.js` (cliente do Graph com `fetch`/`sleep`/`now` injetáveis + registro `TIPOS`) e `rotas-midia.js` (a rota).
- **Sem banco nem store** na rota: cada chamada é independente. O único armazenamento é o bucket temporário que o CLI usa (`scripts/_storage.mjs`: `lerCredenciaisStorage`, `lerSlidesJpeg`, `enviarParaStorage`, `listarDoStorage`, `apagarDoStorage`, todos com `fetch` injetável).
- Tempo: a função tem 300s (`vercel.json`); os containers têm até 240s (Reels: 270s); o resto fica pro `media_publish` e o permalink (ver [Limites de tempo](#limites-de-tempo)). Filhos são criados e esperados em paralelo (`emParalelo` em `instagram-publicacao.js`), então 9 slides levam o tempo do slide mais lento, não a soma.
- O token vai no header `Authorization: Bearer`, nunca na URL. Toda mensagem de erro e de log passa por `sanitizar()`, que tira `access_token=`, `Bearer ...` e os segredos conhecidos.

### O que falta para Stories de vídeo

O registro `TIPOS` em `api/_lib/instagram-publicacao.js` tem `CAROUSEL`, `REELS` e `STORIES` (só imagem) implementados. O story de vídeo é recusado com 501 dentro do `validar()` de `STORIES`.

**Reels ✅ pronto na rota e no CLI** (ver [Reels](#reels)), com o que ainda fica de fora:
1. **Tempo**: continua uma chamada só, com 270s de espera dentro dos 300s da função. Vídeo que demora mais pra ficar `FINISHED` dá 504. A saída é dividir em duas chamadas (uma cria o container e devolve o id, outra checa o status e publica quando estiver `FINISHED`), mantendo `confirmar: true` e a checagem de cota antes de criar. Não foi feito.
2. **Hospedagem**: o bucket `instagram-temp` segue em `image/jpeg` até 8 MB. Pra subir vídeo pelo Storage falta o ok do Vinicius pra liberar `video/mp4` e subir o limite (até no máximo os 50 MB do Free, sem custo de plano); depois disso, atualizar `MAX_BYTES` em `scripts/_storage.mjs`.
3. **TUS**: não implementado (e não precisa enquanto o bucket for ≤ 8 MB). Vale considerar se o limite subir, pra arquivos > 6 MB.

**Stories: imagem ✅ pronto** (ver [Stories](#stories)). 1 JPEG, sem legenda (400 se vier), `criarContainer({ image_url, media_type: "STORIES" })`, permalink opcional (`permalinkOpcional: true` no registro).

**Stories: vídeo (falta)**
1. `validar()`: hoje item com `video_url` ou URL `.mp4`/`.mov`/`.m4v` → 501. Trocar por: aceitar 1 `video_url` https (MP4/MOV), nunca junto com imagem, ainda sem legenda.
2. `criarContainers()`: `criarContainer({ media_type: "STORIES", video_url })`.
3. **Tempo**: o mesmo do Reels. Processar vídeo pode passar dos 300s da função; dá pra reaproveitar o orçamento do Reels, mas o certo é o fluxo em duas chamadas (cria o container / checa e publica).
4. Hospedagem: o mesmo do Reels (bucket só aceita `image/jpeg` até 8 MB). O CLI `story` também só aceita JPEG hoje; a validação de vídeo do `reels` (`scripts/_video.mjs`) pode ser reaproveitada.
5. Limites do Meta pra vídeo em story (duração, tamanho): conferir na doc na hora de implementar.

**Pendências gerais**
- Conferir na doc se Stories contam no limite de 50/24h. A rota checa a cota de qualquer jeito (falha fechada).
- Stickers interativos: fora do alcance da API de publicação (ver [Stories](#stories)).

Tudo exige a mesma permissão do carrossel (`instagram_business_content_publish`). O resto (auth, `confirmar`, limite, sanitização, publish, permalink) já é genérico.

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
