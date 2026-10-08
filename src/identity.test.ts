import { describe, expect, it } from "vite-plus/test";
import { identify, isFiller, isNoiseTranslation, STOPWORDS, FILLERS } from "./identity";

/**
 * El motor de identidad. Si un lemma sale mal, el filtro de transcripciones se
 * contamina de forma permanente: `running` no coincidiría con `run` y volvería
 * al mazo una palabra que ya sabes.
 */
describe("identify — flexión verbal", () => {
  it.each([
    ["ran", "run"],
    ["went", "go"],
    ["eaten", "eat"],
    ["given", "give"],
    ["began", "begin"],
    ["wrote", "write"],
    ["chose", "choose"],
    ["drove", "drive"],
    ["bought", "buy"],
    ["caught", "catch"],
    ["drank", "drink"],
    ["sang", "sing"],
  ])("%s → %s", (input, expected) => {
    expect(identify(input)?.lemma).toBe(expected);
  });

  it.each([
    ["studies", "study"],
    ["studying", "study"],
    ["running", "run"],
    ["swimming", "swim"],
    ["carries", "carry"],
    ["hoped", "hope"],
  ])("flexión regular %s → %s", (input, expected) => {
    expect(identify(input)?.lemma).toBe(expected);
  });
});

describe("identify — plural", () => {
  it.each([
    ["children", "child"],
    ["geese", "goose"],
    ["knives", "knife"],
    ["mice", "mouse"],
    ["teeth", "tooth"],
    ["thieves", "thief"],
  ])("irregular %s → %s", (input, expected) => {
    expect(identify(input)?.lemma).toBe(expected);
  });

  it.each([
    ["cities", "city"],
    ["buses", "bus"],
    ["dogs", "dog"],
  ])("regular %s → %s", (input, expected) => {
    expect(identify(input)?.lemma).toBe(expected);
  });
});

describe("identify — comparativos", () => {
  // Ningún paquete JS cubre esto; es tabla propia. Sin ella, `better` sería un
  // nodo distinto de `good` y wouldn't aparecer en el filtro.
  it.each([
    ["better", "good"],
    ["best", "good"],
    ["worse", "bad"],
    ["worst", "bad"],
  ])("%s → %s", (input, expected) => {
    expect(identify(input)?.lemma).toBe(expected);
  });

  it("deja intactos los que ya son la base", () => {
    expect(identify("good")?.lemma).toBe("good");
    expect(identify("bad")?.lemma).toBe("bad");
  });
});

describe("identify — overrides", () => {
  it("leaves → leaf, no leave", () => {
    // compromise resuelve el verbo; en transcripción suele ser el plural de
    // *leaf*. Dos palabras distintas colapsando en un nodo contamina el filtro.
    expect(identify("leaves")?.lemma).toBe("leaf");
  });

  it("no override si la palabra ya es el lemma", () => {
    expect(identify("leave")?.lemma).toBe("leave");
  });
});

describe("identify — tipos", () => {
  it("una palabra suelta → kind word", () => {
    expect(identify("run")).toEqual({ lemma: "run", kind: "word" });
  });

  it("dos o más palabras → kind phrase, sin lematizar", () => {
    expect(identify("give up")).toEqual({ lemma: "give up", kind: "phrase" });
    // No se reduce: `gave up` es otra unidad, no una flexión de `give up`.
    expect(identify("gave up")?.kind).toBe("phrase");
  });

  it("normaliza espacios internos y mayúsculas", () => {
    expect(identify("  Give   Up ")?.lemma).toBe("give up");
  });
});

describe("identify — rechazo", () => {
  it.each(["", "   ", "...", "42", "—", "a", "-"])("descarta %j", (input) => {
    expect(identify(input)).toBeNull();
  });

  it("descarta longitud 1", () => {
    expect(identify("x")).toBeNull();
  });

  it.each(["you know", "kind of", "sort of"])("descarta la frase de muletilla %j", (input) => {
    expect(identify(input)).toBeNull();
  });

  it("conserva una frase que no es sólo muletillas", () => {
    expect(identify("give up")?.kind).toBe("phrase");
  });
});

describe("isFiller", () => {
  it("descarta stopwords y muletillas", () => {
    expect(isFiller("the")).toBe(true);
    expect(isFiller("um")).toBe(true);
    expect(isFiller("basically")).toBe(true);
  });

  it("NO descarta vocabulario real", () => {
    expect(isFiller("commensurate")).toBe(false);
    expect(isFiller("startle")).toBe(false);
  });

  it('distingue "like"/"so" léxico de muletilla por contexto', () => {
    // Con objeto directo es léxico; aislado es muletilla.
    expect(isFiller("so")).toBe(true);
    expect(isFiller("like")).toBe(true);
    expect(isFiller("so I could")).toBe(false);
    expect(isFiller("like it")).toBe(false);
  });

  it("las listas no contienen entradas vacías", () => {
    for (const s of [...STOPWORDS, ...FILLERS]) expect(s.trim()).not.toBe("");
  });
});

describe("tamaño de las listas", () => {
  it("stopwords tiene cobertura suficiente", () => {
    expect(STOPWORDS.size).toBeGreaterThan(120);
  });

  it("muletillas cubre los tokens más comunes de habla", () => {
    for (const f of ["um", "uh", "ah", "yeah", "okay", "basically", "literally"]) {
      expect(FILLERS.has(f)).toBe(true);
    }
  });

  it("las muletillas compuestas se descartan como frases", () => {
    // No están en FILLERS porque son multi-token: las descarta la rama de
    // frases de `identify`.
    for (const f of ["you know", "kind of", "sort of", "i mean"]) {
      expect(FILLERS.has(f)).toBe(false);
      expect(identify(f)).toBeNull();
    }
  });
});

describe("isNoiseTranslation — ruido de diccionario, no traducción", () => {
  it("etiquetas POS caen (con punto opcional, sin importar caso)", () => {
    for (const t of ["verb", "noun", "adjective", "Verb", "N.", "adj."]) {
      expect(isNoiseTranslation(t, "cry")).toBe(true);
    }
  });

  it("formas de la palabra caen", () => {
    expect(isNoiseTranslation("cries", "cry")).toBe(true);
    expect(isNoiseTranslation("parents", "parent")).toBe(true);
  });

  it("pronunciaciones caen: mismo esqueleto + no-ASCII", () => {
    expect(isNoiseTranslation("krái", "cry")).toBe(true);
    expect(isNoiseTranslation("hǽv", "have")).toBe(true);
    expect(isNoiseTranslation("θíŋk", "think")).toBe(true);
    expect(isNoiseTranslation("wɑ́tʃ", "watch")).toBe(true);
  });

  it("traducciones reales se quedan", () => {
    expect(isNoiseTranslation("correr", "run")).toBe(false);
    expect(isNoiseTranslation("to show sadness", "cry")).toBe(false);
    expect(isNoiseTranslation("teléfono", "phone")).toBe(false);
  });

  it("tradeoff documentado: cognado acentuado cae y lo recupera el LLM", () => {
    // "música" comparte esqueleto con "music" y trae acento: indistinguible
    // de una pronunciación sin un modelo fonético. Cae aquí y vuelve por
    // `fillMissingTranslations`, que rellena lo que falta.
    expect(isNoiseTranslation("música", "music")).toBe(true);
  });
});
