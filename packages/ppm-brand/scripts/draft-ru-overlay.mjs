// Developer tool: drafts the mechanical part of the PPM RU overlay from the upstream Plane ru locale.
// It is not part of the build or the tests. The draft must be proofread by a person and then merged
// into src/locales/i18n-overlay.json by hand (see the glossary in the UX0.2 vocabulary notes).
//
// Usage: node scripts/draft-ru-overlay.mjs <out-dir>
// Writes <out-dir>/ru-overlay.draft.json (nested by namespace) and <out-dir>/ru-overlay.flagged.json
// (strings the tool cannot translate reliably: modules, views, ambiguous case, brand, leftovers).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RU_DIR = fileURLToPath(new URL("../../i18n/src/locales/ru/", import.meta.url));
const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: node scripts/draft-ru-overlay.mjs <out-dir>");
  process.exit(1);
}

// JS \b does not work with Cyrillic, so every rule is anchored with Unicode letter look-arounds.
const NL = "(?<![\\p{L}])";
const NR = "(?![\\p{L}])";
const wordRe = (source) => new RegExp(`${NL}${source}${NR}`, "giu");
const keepCase = (source, target) => (/^\p{Lu}/u.test(source) ? target[0].toUpperCase() + target.slice(1) : target);

// «рабочий элемент» (m.) -> «задача» (f.): agreement of the modifiers right before the phrase.
const ADJ_NOM_F = {
  новый: "новая",
  родительский: "родительская",
  дочерний: "дочерняя",
  этот: "эта",
  выбранный: "выбранная",
  дублирующийся: "дублирующаяся",
  первый: "первая",
  входящий: "входящая",
  повторяющийся: "повторяющаяся",
  существующий: "существующая",
  свой: "своя",
  каждый: "каждая",
  связанный: "связанная",
  один: "одна",
  любой: "любая",
};
const ADJ_ACC_F = {
  новый: "новую",
  родительский: "родительскую",
  дочерний: "дочернюю",
  этот: "эту",
  выбранный: "выбранную",
  первый: "первую",
  входящий: "входящую",
  повторяющийся: "повторяющуюся",
  существующий: "существующую",
  свой: "свою",
  каждый: "каждую",
  один: "одну",
  любой: "любую",
};
const ADJ_GEN_F = {
  этого: "этой",
  нового: "новой",
  родительского: "родительской",
  выбранного: "выбранной",
  первого: "первой",
  вашего: "вашей",
  каждого: "каждой",
  дочернего: "дочерней",
  своего: "своей",
  связанного: "связанной",
  входящего: "входящей",
  повторяющегося: "повторяющейся",
  одного: "одной",
};
const ADJ_DAT_F = {
  этому: "этой",
  повторяющемуся: "повторяющейся",
  любому: "любой",
  каждому: "каждой",
  выбранному: "выбранной",
  родительскому: "родительской",
  своему: "своей",
};
const ADJ_PREP_F = {
  связанном: "связанной",
  этом: "этой",
  родительском: "родительской",
  выбранном: "выбранной",
  повторяющемся: "повторяющейся",
};
const ADJ_INS_F = {
  этим: "этой",
  родительским: "родительской",
  выбранным: "выбранной",
  повторяющимся: "повторяющейся",
};
// Short participle predicate after a nominative singular: «создан» -> «создана».
// Short adjectives with a fleeting vowel are listed explicitly: «доступен» -> «доступна».
const SHORT_ADJECTIVES_F = { доступен: "доступна", виден: "видна", нужен: "нужна", активен: "активна" };
const toFeminineParticiple = (word) =>
  SHORT_ADJECTIVES_F[word.toLowerCase()] ??
  word
    .replace(/ён$/u, "ена")
    .replace(/ен$/u, "ена")
    .replace(/ан$/u, "ана")
    .replace(/ят$/u, "ята")
    .replace(/ыт$/u, "ыта");
// Words after which «рабочий элемент» is accusative («Создать задачу», «в задачу»).
const ACCUSATIVE_TRIGGERS =
  /(?:создать|создайте|добавить|добавьте|удалить|удалите|выберите|выбрать|открыть|откройте|редактировать|изменить|отклонить|отклоните|копировать|скопировать|переместить|назначить|назначьте|архивировать|восстановить|просмотреть|обновить|дублировать|опишите|дайте|добавлять|создавать|начните добавлять|хотите удалить|хотите отклонить|на|в|за|про|через)$/iu;
const NOMINATIVE_LEADS = /^(найден|есть|был|это)$/iu;

const PLURAL_RULES = [
  ["рабочими\\s+элементами", "задачами"],
  ["рабочих\\s+элементах", "задачах"],
  ["рабочих\\s+элементов", "задач"],
  ["рабочих\\s+элемента", "задачи"],
  ["рабочим\\s+элементам", "задачам"],
  ["рабочие\\s+элементы", "задачи"],
  ["рабочие\\s+задачи", "задачи"],
  ["рабочих\\s+задач", "задач"],
  ["рабочую\\s+задачу", "задачу"],
  ["рабочая\\s+задача", "задача"],
];
const OBLIQUE_SINGULAR_RULES = [
  ["рабочего\\s+элемента", "задачи", ADJ_GEN_F],
  ["рабочему\\s+элементу", "задаче", ADJ_DAT_F],
  ["рабочим\\s+элементом", "задачей", ADJ_INS_F],
  ["рабочем\\s+элементе", "задаче", ADJ_PREP_F],
];
// «подэлемент» -> «подзадача» (same gender change as above).
const SUB_ITEM_RULES = [
  ["под-?элементами", "подзадачами"],
  ["под-?элементах", "подзадачах"],
  ["под-?элементов", "подзадач"],
  ["под-?элементам", "подзадачам"],
  ["под-?элементы", "подзадачи"],
  ["под-?элемента", "подзадачи"],
  ["под-?элементу", "подзадаче"],
  ["под-?элементом", "подзадачей"],
  ["под-?элементе", "подзадаче"],
  ["под-?элемент", "подзадача"],
];

// Splits "a b\nc " into words with the whitespace after each one, so rewrites keep line breaks.
const splitWords = (text) => [...text.matchAll(/(\p{L}+)(\s+)/gu)].map(([, word, space]) => ({ word, space }));
const joinWords = (words) => words.map(({ word, space }) => word + space).join("");
// Index of the first word of the trailing run of modifiers found in the table.
const modifierStart = (words, isModifier) => {
  let index = words.length;
  while (index > 0 && isModifier(words[index - 1].word.toLowerCase())) index--;
  return index;
};

function replaceObliqueSingular(text) {
  let result = text;
  for (const [phrase, noun, adjectives] of OBLIQUE_SINGULAR_RULES) {
    const pattern = new RegExp(`${NL}((?:\\p{L}+\\s+){0,2})(${phrase})${NR}`, "giu");
    result = result.replace(pattern, (_match, before, found) => {
      // Only the modifiers right before the phrase agree with it: «этого типа рабочего элемента» keeps «этого».
      const words = splitWords(before);
      const start = modifierStart(words, (word) => Boolean(adjectives[word]));
      const fixed = words.map(({ word, space }, index) => ({
        word: index >= start ? keepCase(word, adjectives[word.toLowerCase()]) : word,
        space,
      }));
      return joinWords(fixed) + keepCase(found, noun);
    });
  }
  return result;
}

function replaceNominativeSingular(text, flags) {
  const pattern = new RegExp(`${NL}((?:\\p{L}+\\s+){0,4})(рабочий\\s+элемент)${NR}((?:\\s+\\p{L}+){0,2})`, "giu");
  return text.replace(pattern, (_match, before, phrase, after) => {
    const words = splitWords(before);
    const start = modifierStart(words, (word) => Boolean(ADJ_NOM_F[word] || ADJ_ACC_F[word]));
    const lead = words.slice(0, start);
    const modifiers = words.slice(start);
    const lastLead = lead.at(-1)?.word ?? "";
    const lastTwoLead = lead
      .slice(-2)
      .map(({ word }) => word)
      .join(" ");
    const isAccusative =
      lead.length > 0 && (ACCUSATIVE_TRIGGERS.test(lastTwoLead) || ACCUSATIVE_TRIGGERS.test(lastLead));
    const noun = isAccusative ? "задачу" : "задача";
    const table = isAccusative ? ADJ_ACC_F : ADJ_NOM_F;
    if (!isAccusative && lead.length > 0 && !NOMINATIVE_LEADS.test(lastLead)) flags.add("SG_CASE_GUESS");

    const fixedLead = lead.map(({ word, space }, index) => ({
      word: !isAccusative && index === lead.length - 1 && /^найден$/iu.test(word) ? keepCase(word, "найдена") : word,
      space,
    }));
    const fixedModifiers = modifiers.map(({ word, space }) => ({
      word: keepCase(word, table[word.toLowerCase()] ?? word),
      space,
    }));
    const tail = isAccusative
      ? after
      : after.replace(/^(\s+(?:успешно|уже|не)\s+)?(\s*)(\p{L}+)/u, (whole, adverb = "", space, word) =>
          /(ён|ен|ан|ят|ыт)$/u.test(word) && !/(время|имен)$/u.test(word)
            ? adverb + space + keepCase(word, toFeminineParticiple(word))
            : whole
        );
    const head = modifiers.length ? noun : keepCase(phrase, noun);
    return joinWords(fixedLead) + joinWords(fixedModifiers) + head + tail;
  });
}

function translate(value, flags) {
  let text = value;
  for (const [phrase, target] of PLURAL_RULES) text = text.replace(wordRe(phrase), (m) => keepCase(m, target));
  text = replaceObliqueSingular(text);
  text = replaceNominativeSingular(text, flags);
  for (const [phrase, target] of SUB_ITEM_RULES) text = text.replace(wordRe(phrase), (m) => keepCase(m, target));
  // «цикл» -> «спринт»: both masculine, endings match. «циклическая ссылка» is not a sprint.
  text = text.replace(wordRe("цикл(ами|ам|ах|ов|ом|а|у|е|ы)?"), (m, ending) => keepCase(m, `спринт${ending ?? ""}`));
  // «с циклом» -> «со спринтом»: the preposition takes -о before «сп».
  text = text.replace(/(?<!\p{L})([Сс])(\s+)(?=[Сс]принт)/gu, "$1о$2");

  if (/(?<!\p{L})модул/iu.test(text)) flags.add("MODULE_MANUAL");
  if (/представлени/iu.test(text)) flags.add("VIEW_MANUAL");
  if (/рабоч\p{L}*\s+элемент/iu.test(text)) flags.add("WORK_ITEM_LEFTOVER");
  if (/(?<!\p{L})Plane(?!\p{L})/u.test(text)) flags.add("PLANE_MANUAL");
  return text;
}

function flatten(tree, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatten(value, fullKey, out);
    else out[fullKey] = value;
  }
  return out;
}

function setPath(tree, keyPath, value) {
  const parts = keyPath.split(".");
  let node = tree;
  for (const part of parts.slice(0, -1)) node = node[part] ??= {};
  node[parts.at(-1)] = value;
}

const draft = {};
const flagged = [];
const changedPerNamespace = {};
for (const file of readdirSync(RU_DIR)
  .filter((name) => name.endsWith(".json"))
  .toSorted()) {
  const namespace = file.replace(/\.json$/, "");
  const strings = flatten(JSON.parse(readFileSync(path.join(RU_DIR, file), "utf8")));
  for (const [key, value] of Object.entries(strings)) {
    if (typeof value !== "string") continue;
    const flags = new Set();
    const text = translate(value, flags);
    if (text !== value) {
      setPath((draft[namespace] ??= {}), key, text);
      changedPerNamespace[namespace] = (changedPerNamespace[namespace] ?? 0) + 1;
    }
    if (flags.size) flagged.push({ key: `${namespace}:${key}`, flags: [...flags], from: value, to: text });
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "ru-overlay.draft.json"), `${JSON.stringify({ ru: draft }, null, 2)}\n`);
writeFileSync(path.join(outDir, "ru-overlay.flagged.json"), `${JSON.stringify(flagged, null, 2)}\n`);
const byFlag = {};
for (const entry of flagged) for (const flag of entry.flags) byFlag[flag] = (byFlag[flag] ?? 0) + 1;
const changed = Object.values(changedPerNamespace).reduce((sum, count) => sum + count, 0);
console.log(JSON.stringify({ changed, changedPerNamespace, flagged: flagged.length, byFlag }, null, 2));
