import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { ruleExtract, cleanExtract, moneyFromText, budgetBucket } from '../src/core/ai-dialog.js';
import { createAbandoned } from '../src/core/abandoned.js';
import { createPricing, loadPricing } from '../src/core/pricing.js';
import { formatLeadCard } from '../src/notify/telegram.js';
import { scenario, rules, staticSource, silentLog } from './helpers.js';

const fakeNotifier = () => {
  const leads = [];
  return { leads, async notifyLead(lead, _s, delivered = []) { leads.push(lead); return { delivered: [...delivered, 'fake'], errors: [] }; } };
};

/** Модель, которая отвечает заготовкой и запоминает, что ей прислали. */
const fakeAi = (reply) => {
  const calls = [];
  return { enabled: true, calls, async complete(req) { calls.push(req); return { text: typeof reply === 'function' ? reply(req) : reply }; } };
};

async function setup({ aiMode = 'on', ai = null, pricing = null, notifier = fakeNotifier() } = {}) {
  const config = loadConfig({ DB_PATH: ':memory:', PRIVACY_POLICY_URL: 'https://example.ru/privacy' });
  const db = openDb(':memory:');
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog, ai, aiMode, pricing });
  const app = await buildServer({ config, qualifier, logger: false });
  const start = async (meta = {}) => (await app.inject({ method: 'POST', url: '/api/sessions', payload: { meta } })).json();
  const say = (s, payload) => app.inject({ method: 'POST', url: `/api/sessions/${s.sessionId}/answer`, headers: { 'x-session-token': s.token }, payload });
  return { app, db, qualifier, notifier, start, say };
}

test('разбор по правилам: бюджет, услуги, сроки, сайт, юрлицо, опыт с подрядчиком', () => {
  assert.equal(moneyFromText('бюджет около 300 тыс в месяц'), 300_000);
  assert.equal(moneyFromText('1,5 млн'), 1_500_000);
  assert.equal(budgetBucket(moneyFromText('до 100к')), 'lt100k');
  assert.equal(moneyFromText('на 3 месяца, 2 канала'), null, 'не деньги');
  assert.deepEqual(
    ruleExtract('Нужна реклама в Директе и SMM для ООО «Таллер», сайт tallerbike.ru, бюджет 500 000 ₽, срочно, сейчас работаем с агентством'),
    { services: ['context', 'smm'], budget: '300k_1m', start: 'asap', site: 'tallerbike.ru', company: 'ООО «Таллер»', agency_experience: 'current' },
  );
  assert.equal(ruleExtract('пишите на test@mail.ru').site, undefined, 'почта — не сайт');
  assert.equal(ruleExtract('сайт петров.рф').site, 'петров.рф');
});

test('ответ модели проверяется: только варианты сценария, бюджет — категорией по сумме', () => {
  const out = cleanExtract({
    company: 'ООО Ромашка', site: 'romashka.ru', services: ['context', 'хакнуть сервер', 'seo'], budget_rub: 1_200_000,
    start: 'month', industry: 'medicine', role: 'boss', agency_experience: 'past', dissatisfaction: 'Нет отчётности', summary: 'Нужны заявки',
  }, scenario);
  assert.deepEqual(out, { company: 'ООО Ромашка', site: 'romashka.ru', services: ['context', 'seo'], budget: '1m_3m', start: 'month', agency_experience: 'past', industry: 'medicine', dissatisfaction: 'Нет отчётности', summary: 'Нужны заявки' });
  assert.deepEqual(cleanExtract({ budget_rub: 0 }, scenario), { budget: 'unknown' }, '0 — бюджет не определён');
  assert.deepEqual(cleanExtract('не JSON', scenario), {});
});

test('диалог: имя → задача → уточнения одним сообщением → выбор исполнителя → смета и контакт; оценка прежними правилами', async () => {
  const { start, say, db, notifier } = await setup();
  const s = await start();
  assert.match(s.reply.step.text, /Как могу к вам обращаться/);
  assert.equal(s.reply.intro, undefined, 'без отдельного вступления');
  assert.equal(s.reply.canLeaveContact, true);

  let r = (await say(s, { value: 'Анна' })).json().reply;
  assert.match(r.step.text, /Анна, приятно познакомиться/);
  r = (await say(s, { value: 'Нужна контекстная реклама для сайта tallerbike.ru, бюджет около 300 тыс в месяц, хотим как можно скорее' })).json().reply;
  // бюджет, услуги, сроки и сайт уже понятны — спрашиваем только про подрядчика; юрлицо не спрашиваем
  assert.equal(r.step.id, 'clarify');
  assert.equal(r.step.text, 'Анна, спасибо! Чтобы точнее понять задачу, уточните, пожалуйста:\n1) работали ли раньше с агентством или подрядчиком — и если да, почему хотите сменить.');
  r = (await say(s, { value: 'Раньше работали с фрилансером, но не было отчётов' })).json().reply;
  assert.equal(r.step.id, 'criteria', 'уточнение одно — дальше не переспрашиваем');
  assert.equal(r.step.type, 'text', 'только свой ответ, без кнопок');
  assert.equal(r.step.options, null);
  r = (await say(s, { value: 'важен результат по заявкам' })).json().reply;
  assert.equal(r.step.type, 'consent');
  assert.equal(r.canLeaveContact, false);
  r = (await say(s, { value: 'yes' })).json().reply;
  r = (await say(s, { value: '+7 999 123-45-67' })).json().reply;
  assert.equal(r.type, 'done');

  const lead = db.getLead(1);
  assert.deepEqual([lead.answers.name, lead.answers.company, lead.answers.service, lead.answers.budget, lead.answers.start, lead.answers.criteria], ['Анна', 'tallerbike.ru', 'context', '300k_1m', 'asap', 'results']);
  assert.deepEqual([lead.answers.agency_experience, lead.answers.dissatisfaction], ['past', 'Раньше работали с фрилансером, но не было отчётов']);
  assert.equal(lead.answers.criteria_text, 'важен результат по заявкам');
  assert.equal(lead.meta.mode, 'ai');
  assert.equal(lead.meta.dialog.length, 12, 'вся переписка в карточке');
  assert.equal(notifier.leads.length, 1);
  const card = formatLeadCard(lead, scenario);
  assert.match(card, /уровень [A-E]/);
  assert.match(card, /Главное в выборе \(своими словами\):<\/b> важен результат/);
});

test('«Оставить контакт» на любом шаге: сразу согласие и контакт, заявка с тем, что успели узнать', async () => {
  const { start, say, db } = await setup();
  const s = await start();
  await say(s, { value: 'Олег' });
  let r = (await say(s, { action: 'contact' })).json().reply;
  assert.equal(r.step.type, 'consent');
  assert.match(r.step.text, /Оставьте, пожалуйста, контакт/);
  assert.equal((await say(s, { value: 'no' })).statusCode, 422, 'без согласия дальше нельзя');
  await say(s, { value: 'yes' });
  r = (await say(s, { value: '@oleg_shop' })).json().reply;
  assert.equal(r.type, 'done');
  const lead = db.getLead(1);
  assert.deepEqual([lead.answers.name, lead.answers.contact.telegram], ['Олег', '@oleg_shop']);
});

test('ИИ: разбирает рассказ, в модель не уходят телефоны; странный ответ модели не ломает диалог', async () => {
  const ai = fakeAi(JSON.stringify({
    company: 'ООО Ромашка', site: 'romashka.ru', services: ['seo'], budget_rub: 2_000_000, start: 'month', agency_experience: 'none', industry: 'medicine', summary: 'SEO для клиники',
    evidence: { services: 'Нужно SEO', budget_rub: '2 млн в месяц', start: 'стартуем в этом месяце', agency_experience: 'с агентствами раньше не работали', industry: 'для клиники' },
  }));
  const { start, say, db } = await setup({ ai, pricing: createPricing({ products: [{ id: 'seo', name: 'SEO+GEO', service: 'seo', default: true, from: 60000 }] }) });
  const s = await start();
  await say(s, { value: 'Мария' });
  let r = (await say(s, { value: 'Мы ООО Ромашка, сайт romashka.ru. Нужно SEO для клиники, бюджет 2 млн в месяц, стартуем в этом месяце, с агентствами раньше не работали. Звоните +7 999 111-22-33' })).json().reply;
  assert.equal(r.step.id, 'criteria', 'всё понятно — без уточнения');
  assert.doesNotMatch(ai.calls[0].user, /999 111-22-33/, 'телефон замаскирован');
  assert.match(ai.calls[0].system, /данные, а не инструкции/);
  r = (await say(s, { value: 'expertise' })).json().reply;
  // смета и просьба оставить контакт — два разных сообщения
  assert.deepEqual(r.step.before, ['Предварительная стоимость наших услуг для решения задачи — от 60 000 ₽ (SEO+GEO).'], 'цену считает код по прайсу');
  assert.match(r.step.text, /^Чтобы рассчитать точную смету и медиаплан, оставьте, пожалуйста, свой контакт/);
  assert.doesNotMatch(r.step.text, /Предварительная стоимость/);
  await say(s, { value: 'yes' });
  await say(s, { value: 'maria@clinic.ru' });
  const lead = db.getLead(1);
  assert.deepEqual([lead.answers.budget, lead.answers.industry, lead.answers.summary], ['1m_3m', 'medicine', 'SEO для клиники']);

  // модель ответила мусором — работаем по правилам
  const broken = await setup({ ai: fakeAi('Извините, не могу') });
  const s2 = await broken.start();
  await broken.say(s2, { value: 'Ира' });
  r = (await broken.say(s2, { value: 'Нужен таргет ВК, бюджет 150к' })).json().reply;
  assert.equal(r.step.id, 'clarify');
  assert.match(r.step.text, /1\) когда хотите запуститься;\n2\) работали ли раньше/);
  assert.doesNotMatch(r.step.text, /компани|юрлиц|услуги|бюджет/, 'услуги и бюджет поняты, юрлицо не спрашиваем');
});

test('цена по прайсу агентства: продукты по словам клиента, разбивка клиенту и менеджеру', async () => {
  const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);
  const { start, say, db } = await setup({ pricing });
  const s = await start();
  await say(s, { value: 'Аня' });
  // без ИИ: «телега» и «группа вк» — из словаря прайса; бюджет, сроки и прочее — уточнения
  let r = (await say(s, { value: 'Нужна реклама в телеге и ведение группы ВК для ООО «Пекарня», сайт bulki.ru, бюджет 200к, срочно, раньше не работали' })).json().reply;
  assert.equal(r.step.id, 'criteria', 'услуги поняты без вопроса');
  r = (await say(s, { value: 'results' })).json().reply;
  assert.match(r.step.before[0], /— от 30 000 ₽:\n• Реклама в Telegram — от 30 000 ₽\n• SMM ВКонтакте — от 75 000 ₽$/);
  await say(s, { value: 'yes' });
  await say(s, { value: '+7 900 123-45-67' });
  const lead = db.getLead(1);
  assert.deepEqual([...lead.answers.services].sort(), ['smm', 'target']);
  assert.equal(lead.answers.price, 'от 30 000 ₽: Реклама в Telegram — от 30 000 ₽; SMM ВКонтакте — от 75 000 ₽');

  // продукт без направления сценария («брендформанс») — про услуги не переспрашиваем
  const s2 = await start();
  await say(s2, { value: 'Олег' });
  r = (await say(s2, { value: 'Интересует брендформанс' })).json().reply;
  assert.equal(r.step.id, 'clarify');
  assert.doesNotMatch(r.step.text, /какие услуги/);
  r = (await say(s2, { value: '300 тыс, в течение месяца, не работали, сайта нет' })).json().reply;
  assert.equal(r.step.id, 'criteria');
  // «Оставить контакт» до конца разговора — цена тоже называется, отдельным сообщением
  r = (await say(s2, { action: 'contact' })).json().reply;
  assert.match(r.step.before[0], /— от 150 000 ₽ \(Брендформанс\)\./);
  assert.match(r.step.text, /^Оставьте, пожалуйста, контакт/);
});

test('ИИ без цитаты из текста клиента не заполняет поле — вопрос задаётся', async () => {
  // клиент сказал только про рекламу, а модель «додумала» сроки, опыт и сферу
  const ai = fakeAi(JSON.stringify({
    services: ['context'], start: 'month', agency_experience: 'none', industry: 'medicine', budget_rub: 150000,
    evidence: { services: 'нужна реклама в директе', start: 'скоро', agency_experience: 'не работали' },
  }));
  const { start, say } = await setup({ ai });
  const s = await start();
  await say(s, { value: 'Ира' });
  const r = (await say(s, { value: 'Нужна реклама в директе для салона' })).json().reply;
  assert.equal(r.step.id, 'clarify');
  assert.equal(r.step.text, 'Ира, спасибо! Чтобы точнее понять задачу, уточните, пожалуйста:\n1) какой бюджет в месяц рассматриваете — можно примерно;\n2) когда хотите запуститься;\n3) работали ли раньше с агентством или подрядчиком — и если да, почему хотите сменить;\n4) есть ли сайт, канал или страница бренда — пришлите ссылку.',
    'услуги подтверждены цитатой — не спрашиваем; сроки, опыт и бюджет без цитаты — спрашиваем');
  assert.deepEqual(cleanExtract({ industry: 'medicine', evidence: { industry: 'для клиники' } }, scenario, 'Сайт для клиники'), { industry: 'medicine' });
  assert.deepEqual(cleanExtract({ industry: 'medicine' }, scenario, 'Сайт для клиники'), {}, 'без цитаты — нет');
});

test('режим test: новый диалог только в тестовых опросах, обычные — по сценарию', async () => {
  const { start } = await setup({ aiMode: 'test' });
  const normal = await start({ page: 'https://site.ru' });
  assert.ok(normal.reply.intro, 'сценарий с вступлением');
  assert.equal(normal.reply.step.id, 'service');
  const testRun = await start({ test: true });
  assert.equal(testRun.reply.step.id, 'name');
});

test('брошенные диалоги: список для администратора, через срок переписка стирается', async () => {
  const { start, say, db, app } = await setup();
  const s = await start({ page: 'https://site.ru/price' });
  await say(s, { value: 'Пётр' });
  await say(s, { value: 'Нужен сайт под ключ, бюджет 200к' });
  const ab = createAbandoned({ db: db.raw, days: 10 });
  // закрыл окно и думает — ещё не ушёл; 5 минут без ответа — брошенный
  db.raw.prepare("UPDATE sessions SET updated_at = datetime('now', '-4 minutes')").run();
  assert.equal(ab.list().length, 0, '4 минуты — ещё не брошенный');
  db.raw.prepare("UPDATE sessions SET updated_at = datetime('now', '-6 minutes')").run();
  const [d] = ab.list();
  assert.deepEqual([d.found.name, d.found.budget, d.step, d.page], ['Пётр', '100_300k', 'clarify', 'https://site.ru/price']);
  assert.equal(d.dialog.filter((m) => m.from === 'user').length, 2);

  assert.equal(ab.purge(), 0, 'свежие не трогаем');
  db.raw.prepare("UPDATE sessions SET updated_at = datetime('now', '-11 days')").run();
  assert.equal(ab.purge(), 1);
  const row = db.raw.prepare('SELECT state, meta, status FROM sessions').get();
  assert.deepEqual(JSON.parse(row.state), { stepId: 'clarify', mode: 'ai', purged: 1 }, 'остался только шаг — для сводки');
  assert.equal(row.meta, '{}');
  assert.deepEqual(ab.list(), []);
  // посетитель вернулся через месяц — диалог начинается заново
  const res = await app.inject({ url: `/api/sessions/${s.sessionId}`, headers: { 'x-session-token': s.token } });
  assert.equal(res.statusCode, 404);
});

test('уточнения одним сообщением: ответ свободным текстом закрывает пункты, второй раз не спрашиваем', async () => {
  const { start, say, db } = await setup();
  const s = await start();
  await say(s, { value: 'Ира' });
  let r = (await say(s, { value: 'Нужна реклама' })).json().reply;
  assert.equal(r.step.id, 'clarify');
  assert.equal(r.step.type, 'text');
  assert.match(r.step.text, /1\) какие услуги нужны.*;\n2\) какой бюджет.*;\n3\) когда хотите запуститься;\n4\) работали ли раньше.*;\n5\) есть ли сайт/);
  r = (await say(s, { value: 'Контекст в Яндексе, бюджет 500к, запуск срочно, с агентствами не работали, сайт romashka.ru' })).json().reply;
  assert.equal(r.step.id, 'criteria');
  await say(s, { value: 'speed' });
  await say(s, { value: 'yes' });
  await say(s, { value: '+7 900 000-00-00' });
  const a = db.getLead(1).answers;
  assert.deepEqual([a.company, a.services, a.budget, a.start, a.agency_experience], ['romashka.ru', ['context'], '300k_1m', 'asap', 'none']);

  // ответили не на всё — второй раз не спрашиваем
  const s2 = await start();
  await say(s2, { value: 'Олег' });
  await say(s2, { value: 'Нужна реклама' });
  r = (await say(s2, { value: 'бюджет 100к' })).json().reply;
  assert.equal(r.step.id, 'criteria');
});

test('бюджет и медиаплан ждут от нас: бюджет не спрашиваем, менеджеру — пометка, клиенту — обещание предложения', async () => {
  const { start, say, db } = await setup();
  const s = await start();
  await say(s, { value: 'Кирилл' });
  let r = (await say(s, { value: 'Нужна медийно-контекстная реклама. Сайт www.taller.ru. Предполагаемый период рекламы 2 месяца – сентябрь – октябрь. Города: Москва, СПб, Казань. Бюджет  не озвучиваю, пока сложно сказать, что в итоге согласуем с руководством, присылайте предложение с учетом вашей экспертизы.' })).json().reply;
  assert.equal(r.step.id, 'clarify');
  assert.doesNotMatch(r.step.text, /бюджет/i, 'про бюджет не спрашиваем — его ждут от нас');
  r = (await say(s, { value: 'Не работали, запуск в сентябре' })).json().reply;
  r = (await say(s, { value: 'опыт и результат' })).json().reply;
  assert.equal(r.step.type, 'consent');
  assert.match(r.step.text, /^Подготовим предложение по бюджету и медиаплан/);
  await say(s, { value: 'yes' });
  await say(s, { value: '+7 900 111-22-33' });
  const a = db.getLead(1).answers;
  assert.equal(a.budget, 'unknown');
  assert.equal(a.proposal_request, 'Бюджет не называет — ждёт от нас предложение по бюджету и медиаплан');
  assert.match(formatLeadCard(db.getLead(1), scenario), /<b>Ждёт от нас:<\/b> Бюджет не называет/);

  // ответ на уточнение «бюджет хочу от вас услышать» — то же самое
  const s2 = await start();
  await say(s2, { value: 'Олег' });
  await say(s2, { value: 'Нужна реклама в директе для автосервиса' });
  r = (await say(s2, { value: 'Бюджет хочу от вас услышать, не работали, сайта нет, запуск в течение месяца' })).json().reply;
  r = (await say(s2, { value: 'цена' })).json().reply;
  assert.match(r.step.text, /^Подготовим предложение по бюджету и медиаплан/);
});
