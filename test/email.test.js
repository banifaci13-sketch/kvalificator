// Уведомления на почту: карточка нового лида и письмо о брошенном диалоге (без настоящей отправки).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { createAbandoned } from '../src/core/abandoned.js';
import { createEmailNotifier } from '../src/notify/email.js';
import { createNotifier } from '../src/notify/index.js';
import { loadConfig } from '../src/config.js';
import { scenario, rules, staticSource, silentLog } from './helpers.js';

const fakeTransport = () => {
  const sent = [];
  return { sent, async sendMail(m) { sent.push(m); return { messageId: String(sent.length) }; } };
};
const SMTP = { host: 'smtp.example.ru', port: 465, secure: true, user: 'robot@soroka-marketing.ru', pass: 'x', from: 'robot@soroka-marketing.ru' };

function setup(transport) {
  const db = openDb(':memory:');
  const email = createEmailNotifier({ smtp: SMTP, to: ['info@soroka-marketing.ru'], publicUrl: 'https://qual.soroka-marketing.ru', transport });
  const notifier = { email, async notifyLead(lead, sc, delivered = []) { await email.notifyLead(lead, sc); return { delivered: [...delivered, 'email'], errors: [] }; } };
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog, aiMode: 'on' });
  return { db, qualifier, email };
}

test('почта включается, когда заданы NOTIFY_EMAIL и SMTP_HOST', () => {
  const on = createNotifier(loadConfig({ NOTIFY_EMAIL: 'info@soroka-marketing.ru', SMTP_HOST: 'smtp.example.ru', SMTP_USER: 'robot@soroka-marketing.ru', SMTP_PASSWORD: 'x' }));
  assert.deepEqual(on.targets, ['email']);
  assert.ok(on.email);
  assert.equal(createNotifier(loadConfig({ NOTIFY_EMAIL: 'info@soroka-marketing.ru' })), null, 'без SMTP — не включается');
  const cfg = loadConfig({ SMTP_PORT: '587' });
  assert.equal(cfg.mail.smtp.secure, false, '587 — STARTTLS');
  assert.equal(loadConfig({}).mail.smtp.secure, true, '465 по умолчанию — TLS');
});

test('новый лид — письмо с карточкой, диалогом и ссылкой на заявку', async () => {
  const transport = fakeTransport();
  const { qualifier } = setup(transport);
  const { session } = qualifier.startSession({ channel: 'web', meta: { page: 'https://soroka-marketing.ru/' } });
  for (const value of ['Анна', 'Нужна контекстная реклама для автосервиса, бюджет 200к, срочно, раньше не работали, сайт avto.ru', 'результат']) {
    await qualifier.answer(session.id, { value });
  }
  await qualifier.answer(session.id, { value: '+7 900 123-45-67', consent: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(transport.sent.length, 1);
  const m = transport.sent[0];
  assert.equal(m.to, 'info@soroka-marketing.ru');
  assert.equal(m.from, 'robot@soroka-marketing.ru');
  assert.match(m.subject, /^Новый лид #1 — уровень [A-E]/);
  assert.match(m.html, /Диалог с клиентом/);
  assert.match(m.html, /<b>Клиент:<\/b> Нужна контекстная реклама/);
  assert.match(m.html, /https:\/\/qual\.soroka-marketing\.ru\/admin\/#\/leads\?lead=1/);
  assert.match(m.text, /\+7 900 123-45-67/, 'в письме о лиде контакт есть — клиент дал согласие');
  assert.doesNotMatch(m.text, /<b>/, 'текстовая версия без разметки');
});

test('брошенный диалог — одно письмо, без телефонов и почты; старые диалоги не рассылаются', async () => {
  const transport = fakeTransport();
  const { db, qualifier, email } = setup(transport);
  const abandoned = createAbandoned({ db: db.raw });
  const { session } = qualifier.startSession({ channel: 'web', meta: { page: 'https://soroka-marketing.ru/uslugi' } });
  await qualifier.answer(session.id, { value: 'Олег' });
  await qualifier.answer(session.id, { value: 'Нужен таргет вк для салона красоты, мой телефон 8 900 111-22-33, почта oleg@mail.ru' });
  // ещё не брошен: прошло меньше 5 минут
  assert.equal(await abandoned.notifyNew((d) => email.notifyAbandoned(d, scenario)), 0);
  db.raw.prepare("UPDATE sessions SET updated_at = datetime('now', '-10 minutes') WHERE id = ?").run(session.id);

  assert.equal(await abandoned.notifyNew((d) => email.notifyAbandoned(d, scenario)), 1);
  assert.equal(transport.sent.length, 1);
  const m = transport.sent[0];
  assert.match(m.subject, /^Брошенный диалог — Таргетированная реклама/);
  assert.match(m.html, /Нужен таргет вк для салона красоты/);
  assert.match(m.html, /\[телефон скрыт\]/);
  assert.match(m.html, /\[почта скрыта\]/);
  assert.doesNotMatch(m.text, /111-22-33|oleg@mail\.ru/);
  assert.match(m.html, /\/admin\/#\/abandoned/);

  assert.equal(await abandoned.notifyNew((d) => email.notifyAbandoned(d, scenario)), 0, 'второй раз не пишем');

  // письмо не ушло (почта недоступна) — попробуем в следующий раз
  const s2 = qualifier.startSession({ channel: 'web' }).session;
  await qualifier.answer(s2.id, { value: 'Ирина' });
  db.raw.prepare("UPDATE sessions SET updated_at = datetime('now', '-10 minutes') WHERE id = ?").run(s2.id);
  await assert.rejects(abandoned.notifyNew(async () => { throw new Error('SMTP недоступен'); }));
  assert.equal(await abandoned.notifyNew((d) => email.notifyAbandoned(d, scenario)), 1);
});
