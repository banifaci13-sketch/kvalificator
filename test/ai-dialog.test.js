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

test('диалог: имя → задача → уточнения по одному вопросу → выбор исполнителя → согласие → контакт; оценка прежними правилами', async () => {
  const { start, say, db, notifier } = await setup();
  const s = await start();
  assert.match(s.reply.step.text, /Как могу к вам обращаться/);
  assert.equal(s.reply.intro, undefined, 'без отдельного вступления');
  assert.equal(s.reply.canLeaveContact, true);

  let r = (await say(s, { value: 'Анна' })).json().reply;
  assert.match(r.step.text, /Анна, приятно познакомиться/);
  r = (await say(s, { value: 'Нужна контекстная реклама для сайта tallerbike.ru, бюджет около 300 тыс в месяц, хотим как можно скорее' })).json().reply;
  // уточнения — по одному вопросу за сообщение; бюджет, услуги, сроки и сайт уже понятны — их не спрашиваем
  assert.equal(r.step.id, 'clarify_company');
  assert.match(r.step.text, /^Анна, спасибо! Уточню пару моментов\.\n\nКак называется ваша компания\? Укажите, пожалуйста, юрлицо\.$/);
  r = (await say(s, { value: 'ООО «Таллер»' })).json().reply;
  assert.equal(r.step.id, 'clarify_agency_experience');
  assert.equal(r.step.text, 'Работали ли раньше с агентством или подрядчиком?', 'дальше — только вопрос');
  assert.ok(r.step.allowText && r.step.options.length === 3, 'варианты кнопками и свой ответ');
  // «да, работали» — один раз спросим, почему меняют
  r = (await say(s, { value: 'Да, работали с фрилансером' })).json().reply;
  assert.equal(r.step.id, 'clarify_dissatisfaction');
  r = (await say(s, { value: 'Не было отчётов' })).json().reply;
  assert.equal(r.step.id, 'criteria');
  assert.ok(r.step.allowText && r.step.options.length, 'варианты кнопками и свой ответ');
  r = (await say(s, { value: 'важен результат по заявкам' })).json().reply;
  assert.equal(r.step.type, 'consent');
  assert.equal(r.canLeaveContact, false);
  r = (await say(s, { value: 'yes' })).json().reply;
  r = (await say(s, { value: '+7 999 123-45-67' })).json().reply;
  assert.equal(r.type, 'done');

  const lead = db.getLead(1);
  assert.deepEqual([lead.answers.name, lead.answers.company, lead.answers.service, lead.answers.budget, lead.answers.start, lead.answers.criteria], ['Анна', 'ООО «Таллер», tallerbike.ru', 'context', '300k_1m', 'asap', 'results']);
  assert.deepEqual([lead.answers.agency_experience, lead.answers.dissatisfaction], ['past', 'Не было отчётов']);
  assert.equal(lead.answers.criteria_text, 'важен результат по заявкам');
  assert.equal(lead.rating, 3);
  assert.equal(lead.meta.mode, 'ai');
  assert.equal(lead.meta.dialog.length, 16, 'вся переписка в карточке');
  assert.equal(notifier.leads.length, 1);
  const card = formatLeadCard(lead, scenario);
  assert.match(card, /уровень C/);
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
  assert.match(r.step.text, /Предварительная стоимость наших услуг для решения задачи — от 60 000 ₽ \(SEO\+GEO\)/, 'цену считает код по прайсу');
  await say(s, { value: 'yes' });
  await say(s, { value: 'maria@clinic.ru' });
  const lead = db.getLead(1);
  assert.deepEqual([lead.answers.budget, lead.answers.industry, lead.answers.summary], ['1m_3m', 'medicine', 'SEO для клиники']);

  // модель ответила мусором — работаем по правилам
  const broken = await setup({ ai: fakeAi('Извините, не могу') });
  const s2 = await broken.start();
  await broken.say(s2, { value: 'Ира' });
  r = (await broken.say(s2, { value: 'Нужен таргет ВК, бюджет 150к' })).json().reply;
  assert.equal(r.step.id, 'clarify_company');
  assert.match(r.step.text, /Как называется ваша компания/);
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
  assert.match(r.step.text, /— от 105 000 ₽:\n• Реклама в Telegram — от 30 000 ₽\n• SMM ВКонтакте — от 75 000 ₽/);
  await say(s, { value: 'yes' });
  await say(s, { value: '+7 900 123-45-67' });
  const lead = db.getLead(1);
  assert.deepEqual([...lead.answers.services].sort(), ['smm', 'target']);
  assert.equal(lead.answers.price, 'от 105 000 ₽: Реклама в Telegram — от 30 000 ₽; SMM ВКонтакте — от 75 000 ₽');

  // продукт без направления сценария («брендформанс») — про услуги не переспрашиваем
  const s2 = await start();
  await say(s2, { value: 'Олег' });
  r = (await say(s2, { value: 'Интересует брендформанс' })).json().reply;
  assert.equal(r.step.id, 'clarify_company');
  for (const v of ['ИП Олегов', '300 тыс', 'month', 'none', 'нет']) r = (await say(s2, { value: v })).json().reply;
  assert.equal(r.step.id, 'criteria');
  // «Оставить контакт» до конца разговора — цена тоже называется
  r = (await say(s2, { action: 'contact' })).json().reply;
  assert.match(r.step.text, /— от 150 000 ₽ \(Брендформанс\)\./);
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
  let r = (await say(s, { value: 'Нужна реклама в директе для салона' })).json().reply;
  const asked = [r.step.id];
  for (const v of ['ООО Салон', '150 тыс', 'month', 'none', 'нет']) {
    r = (await say(s, { value: v })).json().reply;
    asked.push(r.step.id);
  }
  assert.deepEqual(asked, ['clarify_company', 'clarify_budget', 'clarify_start', 'clarify_agency_experience', 'clarify_site', 'criteria'],
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
  db.raw.prepare("UPDATE sessions SET updated_at = datetime('now', '-2 hours')").run();
  const ab = createAbandoned({ db: db.raw, days: 10 });
  const [d] = ab.list();
  assert.deepEqual([d.found.name, d.found.budget, d.step, d.page], ['Пётр', '100_300k', 'clarify_company', 'https://site.ru/price']);
  assert.equal(d.dialog.filter((m) => m.from === 'user').length, 2);

  assert.equal(ab.purge(), 0, 'свежие не трогаем');
  db.raw.prepare("UPDATE sessions SET updated_at = datetime('now', '-11 days')").run();
  assert.equal(ab.purge(), 1);
  const row = db.raw.prepare('SELECT state, meta, status FROM sessions').get();
  assert.deepEqual(JSON.parse(row.state), { stepId: 'clarify_company', mode: 'ai', purged: 1 }, 'остался только шаг — для сводки');
  assert.equal(row.meta, '{}');
  assert.deepEqual(ab.list(), []);
  // посетитель вернулся через месяц — диалог начинается заново
  const res = await app.inject({ url: `/api/sessions/${s.sessionId}`, headers: { 'x-session-token': s.token } });
  assert.equal(res.statusCode, 404);
});

test('уточнения: кнопки и свой ответ, каждый пункт — один раз, свободный ответ закрывает и соседние пункты', async () => {
  const { start, say, db } = await setup();
  const s = await start();
  await say(s, { value: 'Ира' });
  let r = (await say(s, { value: 'Нужна реклама' })).json().reply;
  assert.equal(r.step.id, 'clarify_company');
  // в ответе про компанию заодно бюджет и сроки — эти вопросы уже не зададим
  r = (await say(s, { value: 'ООО Ромашка, бюджет 500к, запуск срочно' })).json().reply;
  assert.equal(r.step.id, 'clarify_services');
  r = (await say(s, { value: '1' })).json().reply; // номер варианта
  assert.equal(r.step.id, 'clarify_agency_experience');
  r = (await say(s, { value: 'none' })).json().reply;
  assert.equal(r.step.id, 'clarify_site');
  r = (await say(s, { value: 'нет' })).json().reply;
  assert.equal(r.step.id, 'criteria', 'сайта нет — дальше, без повторов');
  await say(s, { value: 'speed' });
  await say(s, { value: 'yes' });
  await say(s, { value: '+7 900 000-00-00' });
  const a = db.getLead(1).answers;
  assert.deepEqual([a.company, a.services, a.budget, a.start, a.agency_experience], ['ООО Ромашка', ['context'], '300k_1m', 'asap', 'none']);
});
