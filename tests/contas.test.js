import { describe, test, expect } from "vitest";
import {
  CONTAS,
  contaPorUserId,
  contaPorSlug,
  regraQueCasa,
  tokenDaConta,
} from "../api/contas.js";

describe("contaPorUserId", () => {
  test("acha a conta pelo user_id que o webhook manda em entry.id", () => {
    const conta = contaPorUserId("17841438494434121");
    expect(conta?.slug).toBe("eterniza");
  });

  test("devolve undefined pra user_id desconhecido", () => {
    expect(contaPorUserId("99999999999999999")).toBeUndefined();
  });

  test("devolve undefined pra user_id vazio ou nulo", () => {
    expect(contaPorUserId(undefined)).toBeUndefined();
    expect(contaPorUserId("")).toBeUndefined();
  });
});

describe("contaPorSlug", () => {
  test("acha a conta pelo slug", () => {
    expect(contaPorSlug("watanabe")?.userId).toBe("17841400866194604");
  });

  test("devolve undefined pra slug desconhecido", () => {
    expect(contaPorSlug("naoexiste")).toBeUndefined();
  });
});

describe("regraQueCasa", () => {
  const regras = [
    { keyword: "trio", dm: "dm do trio" },
    { keyword: "quero", dm: "dm do quero" },
  ];

  test("casa quando a palavra está contida no comentário", () => {
    expect(regraQueCasa(regras, "eu quero uma dessas")?.keyword).toBe("quero");
  });

  test("ignora maiúsculas", () => {
    expect(regraQueCasa(regras, "QUERO!!")?.keyword).toBe("quero");
  });

  test("aplica a PRIMEIRA regra que casa, não a mais longa", () => {
    expect(regraQueCasa(regras, "quero o trio")?.keyword).toBe("trio");
  });

  test("devolve undefined quando nada casa", () => {
    expect(regraQueCasa(regras, "que carta linda")).toBeUndefined();
  });

  test("lista de regras vazia nunca casa nada", () => {
    expect(regraQueCasa([], "quero")).toBeUndefined();
  });

  test("texto vazio ou nulo não casa nada", () => {
    expect(regraQueCasa(regras, "")).toBeUndefined();
    expect(regraQueCasa(regras, undefined)).toBeUndefined();
  });

  test("ignora acento no comentário e na keyword", () => {
    const comAcento = [{ keyword: "unica", dm: "dm da unica" }];
    expect(regraQueCasa(comAcento, "Única")?.keyword).toBe("unica");
    expect(regraQueCasa(comAcento, "unica")?.keyword).toBe("unica");
    expect(regraQueCasa(comAcento, "única")?.keyword).toBe("unica");
    // keyword com acento também é normalizada
    expect(regraQueCasa([{ keyword: "única" }], "UNICA")?.keyword).toBe("única");
  });

  test("continua casando por substring, não por palavra inteira", () => {
    expect(regraQueCasa(regras, "trios")?.keyword).toBe("trio");
  });
});

const DM_QUERO =
  "Oi! Vi seu comentário. Você manda a foto e o nome, a gente desenha no estilo de carta de jogo e imprime em papel holográfico, 63x88mm, o tamanho oficial, que cabe em sleeve e toploader. A Carta Única sai por R$ 39,90. O Trio são 3 cartas por R$ 99,90 com frete grátis, e você escolhe quem entra em cada uma. A arte fica pronta em até 3 dias úteis depois que a foto e o nome chegam, e a produção leva 4 dias úteis depois que você aprova a arte. Modelos e preços: https://eternizacards.com.br/?utm_source=instagram&utm_medium=dm&utm_campaign=comentario&utm_content=quero";

describe("gatilhos reais da eterniza", () => {
  const regras = contaPorSlug("eterniza").regras;
  const casa = (texto) => regraQueCasa(regras, texto)?.keyword;

  test("cada comentário cai na regra certa", () => {
    expect(casa("Trio")).toBe("trio");
    expect(casa("Única")).toBe("unica");
    expect(casa("unica")).toBe("unica");
    expect(casa("MODELOS")).toBe("modelos");
    expect(casa("quero")).toBe("quero");
  });

  test("'que carta linda' não dispara nada", () => {
    expect(regraQueCasa(regras, "que carta linda")).toBeUndefined();
  });

  test("comentário com 'quero' e 'trio' cai no trio (mais específica vence)", () => {
    expect(casa("quero o trio")).toBe("trio");
    expect(casa("trio, quero!")).toBe("trio");
  });

  test("as 4 regras existem nessa ordem: trio, unica, modelos, quero", () => {
    expect(regras.map((r) => r.keyword)).toEqual(["trio", "unica", "modelos", "quero"]);
  });

  test("todas respondem em público com o mesmo texto", () => {
    for (const r of regras) {
      expect(r.publicReply).toBe("Te chamei no direct! 📩");
    }
  });

  test("não existe gatilho 'carta'", () => {
    expect(regras.some((r) => r.keyword.toLowerCase().includes("carta"))).toBe(false);
  });

  test("nenhuma DM fala de WhatsApp, Black Friday ou R$ 89,90", () => {
    for (const r of regras) {
      expect(r.dm.toLowerCase()).not.toContain("whatsapp");
      expect(r.dm.toLowerCase()).not.toContain("black friday");
      expect(r.dm).not.toContain("R$ 89,90");
    }
  });

  test("cada DM leva o utm_content da própria keyword", () => {
    for (const r of regras) {
      expect(r.dm).toContain(`utm_content=${r.keyword}`);
    }
  });

  test("a Única não promete frete grátis", () => {
    const unica = regras.find((r) => r.keyword === "unica");
    expect(unica.dm.toLowerCase()).not.toContain("frete");
  });

  test("dm do 'quero' é exatamente o texto aprovado", () => {
    expect(regras.find((r) => r.keyword === "quero").dm).toBe(DM_QUERO);
  });
});

describe("tokenDaConta", () => {
  test("lê o token do env var nomeado em tokenEnv", () => {
    const conta = { tokenEnv: "TOKEN_FAKE" };
    expect(tokenDaConta(conta, { TOKEN_FAKE: "abc123" })).toBe("abc123");
  });

  test("devolve undefined quando o env var não está setado", () => {
    expect(tokenDaConta({ tokenEnv: "NAO_EXISTE" }, {})).toBeUndefined();
  });
});

// Estes guardam decisões, não implementação. Se quebrarem, foi de propósito
// ou foi acidente — vale parar e olhar.
describe("invariantes do cadastro de contas", () => {
  test("cada conta tem user_id próprio", () => {
    const ids = CONTAS.map((c) => c.userId);
    expect(new Set(ids).size).toBe(CONTAS.length);
  });

  test("cada conta tem token próprio", () => {
    // Duas contas apontando pro mesmo tokenEnv = DM da eterniza saindo pela
    // conta do watanabe, em silêncio. É o pior bug possível aqui.
    const envs = CONTAS.map((c) => c.tokenEnv);
    expect(new Set(envs).size).toBe(CONTAS.length);
  });

  test("user_id tem cara de id de conta profissional, não de id app-scoped", () => {
    // O app-scoped `id` é curto e NÃO casa com entry.id do webhook.
    // Os user_id do Instagram começam com 178414 e têm 17 dígitos.
    for (const c of CONTAS) {
      expect(c.userId).toMatch(/^\d{17}$/);
    }
  });

  test("watanabe está com as regras desligadas", () => {
    // Decisão de 2026-09-17: a copy antiga mandava pra waitlist de uma
    // comunidade que não existe mais. Religar exige copy nova.
    expect(contaPorSlug("watanabe")?.regras).toEqual([]);
  });

  test("toda regra tem keyword e dm preenchidos", () => {
    for (const conta of CONTAS) {
      for (const regra of conta.regras) {
        expect(regra.keyword?.trim()).toBeTruthy();
        expect(regra.dm?.trim()).toBeTruthy();
      }
    }
  });

  test("link da eterniza carrega UTM pra venda por DM não virar órfã no banco", () => {
    const regras = contaPorSlug("eterniza").regras;
    expect(regras.length).toBeGreaterThan(0);
    for (const regra of regras) {
      expect(regra.dm).toContain("utm_source=instagram");
      expect(regra.dm).toContain("utm_medium=dm");
    }
  });

  test("nenhuma DM passa do limite de 1000 bytes UTF-8 do Instagram", () => {
    for (const conta of CONTAS) {
      for (const regra of conta.regras) {
        expect(Buffer.byteLength(regra.dm, "utf8")).toBeLessThanOrEqual(1000);
      }
    }
  });
});
