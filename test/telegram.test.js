import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { createTelegramBot } from '../src/channels/telegram.js';
import { rules, staticSource, silentLog, typicalAnswers, scenario } from './helpers.js';

const MANAGERS = -100500;
const botInfo = {
  id: 1, is_bot: true, first_name: 'Soroka', username: 'soroka_bot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
};
const anna = { id: 100, is_bot: false, first_name: 'Анна', username: 'anna' };

/** Бот с подменённым Telegram API: все вызовы записываются в calls. */
function setup() {
  const db = openDb(':memory:');
  const leads = [];
  const notifier = { async notifyLead(lead) { leads.push(lead); return { delivered: ['fake'], errors: [] }; } };
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog });
  const bot = createTelegramBot({ token: 'test', managerChatId: MANAGERS, privacyPolicyUrl: 'https://example.ru/privacy', qualifier, log: silentLog, botConfig: { botInfo } });
  const calls = [];
  let messageId = 1;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const result = method === 'sendMessage'
      ? { message_id: ++messageId, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text }
      : true;
    return { ok: true, result };
  });

  let updateId = 0;
  const chat = (user) => ({ id: user.id, type: 'private', first_name: user.first_name });
  const send = (update) => bot.handleUpdate({ update_id: ++updateId, ...update });
  const text = (t, user = anna) => send({
    message: {
      message_id: ++messageId, date: 0, chat: chat(user), from: user, text: t,
      ...(t.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] } : {}),
    },
  });
  const press = (data, user = anna, chatObj = chat(user)) => send({
    callback_query: {
      id: String(updateId), from: user, chat_instance: 'x', data,
      message: { message_id: 2, date: 0, chat: chatObj, from: { ...botInfo }, text: '…' },
    },
  });
  const contact = (phone, user = anna) => send({
    message: { message_id: ++messageId, date: 0, chat: chat(user), from: user, contact: { phone_number: phone, first_name: user.first_name, user_id: user.id } },
  });
  const current = (user = anna) => {
    const s = qualifier.activeSession('telegram', user.id);
    return s && qualifier.resume(s);
  };
  const sent = (method = 'sendMessage') => calls.filter((c) => c.method === method);
  const lastText = () => sent().at(-1).payload.text;
  return { bot, db, qualifier, leads, calls, text, press, contact, current, sent, lastText };
}

/** Проходит опрос до конца, отвечая так, как ответил бы клиент. */
async function completeSurvey(t) {
  for (let reply = t.current(); reply?.type === 'question'; reply = t.current()) {
    const { step } = reply;
    const value = typicalAnswers[step.id];
    if (value === undefined) await t.press(`s:${step.id}`);
    else if (step.type === 'contact') await t.contact('+7 999 123-45-67');
    else if (step.options) await t.press(`a:${step.id}:${step.options.findIndex((o) => o.value === value)}`);
    else await t.text(value);
  }
}

test('/start: приветствие и первый вопрос с кнопками', async () => {
  const t = setup();
  await t.text('/start');
  const [intro, question] = t.sent();
  assert.equal(intro.payload.text, scenario.intro);
  assert.match(question.payload.text, /Вопрос 1 из \d+/);
  assert.equal(question.payload.reply_markup.inline_keyboard[0][0].callback_data, 'a:service:0');
});

test('полный опрос в Telegram: лид с профилем и телефоном из кнопки «Поделиться номером»', async () => {
  const t = setup();
  await t.text('/start');
  await completeSurvey(t);

  assert.ok(!t.current());
  assert.equal(t.lastText(), scenario.outro.warm);
  await new Promise((r) => setImmediate(r));
  const [lead] = t.leads;
  assert.equal(lead.channel, 'telegram');
  assert.equal(lead.meta.telegram.username, 'anna');
  assert.equal(lead.answers.contact.phone, '+79991234567');
  assert.equal(lead.answers.service, 'context');
});

test('выбранный вариант отмечается в сообщении, повторное нажатие не ломает опрос', async () => {
  const t = setup();
  await t.text('/start');
  await t.press('a:service:2');
  const edit = t.sent('editMessageText').at(-1);
  assert.match(edit.payload.text, /✅ SEO-продвижение/);

  await t.press('a:service:0');
  const answer = t.sent('answerCallbackQuery').at(-1);
  assert.equal(answer.payload.text, 'Этот вопрос уже пройден');
  assert.equal(t.current().step.id, 'task');
});

test('неверный ответ — объяснение и повтор вопроса', async () => {
  const t = setup();
  await t.text('/start');
  await t.text('кофе');
  const [error, again] = t.sent().slice(-2);
  assert.match(error.payload.text, /Выберите/);
  assert.match(again.payload.text, /Какая услуга/);
});

test('шаг контакта: кнопка «Поделиться номером» и @username', async () => {
  const t = setup();
  await t.text('/start');
  await completeSurveyUntil(t, 'contact');
  const keyboard = t.sent().at(-1).payload.reply_markup.keyboard;
  assert.equal(keyboard[0][0].request_contact, true);
  assert.equal(keyboard[1][0].text, '@anna');
});

test('контакт не на своём шаге не принимается', async () => {
  const t = setup();
  await t.text('/start');
  await t.contact('+79991234567');
  assert.equal(t.current().step.id, 'service');
  assert.match(t.sent().at(-2).payload.text, /другой вопрос/);
});

test('продолжение диалога из виджета по ссылке t.me/бот?start=код', async () => {
  const t = setup();
  const { session } = t.qualifier.startSession({ channel: 'web', meta: { page: 'https://soroka-marketing.ru/' } });
  await t.qualifier.answer(session.id, { value: 'seo' });

  await t.text(`/start ${session.handoff_code}`);
  assert.match(t.sent()[0].payload.text, /на сайте/);
  assert.equal(t.current().step.id, 'task');
  const moved = t.db.getSession(session.id);
  assert.equal(moved.channel, 'telegram');
  assert.equal(moved.meta.page, 'https://soroka-marketing.ru/');
  assert.equal(moved.meta.telegram.username, 'anna');
});

test('/start без кода продолжает начатый опрос, /restart начинает заново', async () => {
  const t = setup();
  await t.text('/start');
  await t.press('a:service:0');
  await t.text('/start');
  assert.equal(t.current().step.id, 'task');
  await t.text('/restart');
  assert.equal(t.current().step.id, 'service');
});

test('менеджер берёт лид в работу, второй — видит, что лид занят', async () => {
  const t = setup();
  await t.text('/start');
  await completeSurvey(t);
  await new Promise((r) => setImmediate(r));
  const leadId = t.leads[0].id;
  const group = { id: MANAGERS, type: 'supergroup', title: 'Менеджеры' };
  const ivan = { id: 200, is_bot: false, first_name: 'Иван', username: 'ivan' };
  const oleg = { id: 300, is_bot: false, first_name: 'Олег' };

  await t.press(`take:${leadId}`, ivan, group);
  const edit = t.sent('editMessageReplyMarkup').at(-1);
  assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].text, '✅ В работе: @ivan');
  assert.equal(t.db.getLead(leadId).assignee, '@ivan');

  await t.press(`take:${leadId}`, oleg, group);
  assert.equal(t.sent('answerCallbackQuery').at(-1).payload.text, 'Уже в работе: @ivan');
});

test('кнопку «Взять в работу» нельзя нажать вне чата менеджеров', async () => {
  const t = setup();
  await t.text('/start');
  await completeSurvey(t);
  await new Promise((r) => setImmediate(r));
  await t.press(`take:${t.leads[0].id}`);
  assert.equal(t.db.getLead(t.leads[0].id).assignee, null);
});

async function completeSurveyUntil(t, stopAt) {
  for (let reply = t.current(); reply?.type === 'question' && reply.step.id !== stopAt; reply = t.current()) {
    const { step } = reply;
    const value = typicalAnswers[step.id];
    if (value === undefined) await t.press(`s:${step.id}`);
    else if (step.options) await t.press(`a:${step.id}:${step.options.findIndex((o) => o.value === value)}`);
    else await t.text(value);
  }
}
