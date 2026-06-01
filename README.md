# ig-webhook

Webhook Instagram **comentário → DM** (private reply), serverless na Vercel. Igual ManyChat, sem ManyChat.

## URL do webhook

Depois do deploy: `https://<seu-projeto>.vercel.app/api/webhook`

## Deploy (uma vez)

```bash
npm i -g vercel        # se não tiver
cd ig-webhook
vercel                 # cria o projeto (escolha conta, aceita defaults)
vercel --prod          # vai pra produção, te dá a URL final
```

## Env vars (na Vercel)

Project → Settings → Environment Variables. Copie do `.env.example`:

| Var | O que é |
|-----|---------|
| `IG_VERIFY_TOKEN` | string que você inventa; a MESMA no campo "Verificar token" do Meta |
| `IG_ACCESS_TOKEN` | token long-lived da conta IG |
| `IG_APP_SECRET` | "Chave secreta do app" do painel Meta |
| `IG_TRIGGER_WORD` | (opcional) palavra que dispara; vazio = todos |
| `IG_REPLY_TEXT` | texto do DM automático |

Depois de setar/alterar env var → **`vercel --prod` de novo** (a Vercel não relê env em runtime sem redeploy).

## Plugar no Meta (passo 3 do painel)

1. URL de callback: `https://<seu-projeto>.vercel.app/api/webhook`
2. Verificar token: o mesmo `IG_VERIFY_TOKEN`
3. **Verificar e salvar** → handshake passa
4. Assinar o campo **`comments`**

## Testar

Comente num post seu com a palavra-gatilho → DM chega no autor.
Logs: `vercel logs` ou painel Vercel → Deployment → Functions.

## Limites (regra do Meta, não do código)

- 1 private reply **por comentário**, dentro de **7 dias**.
- Em produção pra contas que não são testadoras → precisa **App Review** das permissões.
