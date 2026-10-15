// Telegram-бот: тот же сценарий квалификации, что и в виджете, плюс кнопка
// «Взять в работу» в карточках лидов для чата менеджеров.

import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { AnswerError } from '../core/qualifier.js';

const CHANNEL = 'telegram';

export function createTelegramBot({ token, managerChatId, privacyPolicyUrl, qualifier, log, botConfig, staffLink = null }) {
  const bot = new Bot(token, botConfig);
  const dm = bot.chatType('private');

  // ---------- диалог с клиентом ----------

  dm.command('start', async (ctx) => {
    const code = ctx.match.trim();
    // Ссылка t.me/бот?start=test из админки — тестовый опрос, лид не уходит менеджерам
    if (code === 'test') return startNew(ctx, { test: true });
    // Сотрудник подключает напоминания о встречах: ссылка из «Учётной записи» в админке
    if (code.startsWith('staff_') && staffLink) {
      const user = staffLink(code.slice(6), ctx.chat.id);
      return ctx.reply(
        user
          ? `Готово, ${user.name}! Сюда будут приходить напоминания о встречах и утренний план на день.`
          : 'Ссылка устарела. Откройте «Учётная запись» в админке и подключите Telegram заново.',
      );
    }
    if (code) {
      const session = qualifier.claimHandoff(code, CHANNEL, ctx.from.id, profileMeta(ctx.from));
      if (session) {
        await ctx.reply('Продолжим с того места, где вы остановились на сайте.');
        return ask(ctx, qualifier.resume(session));
      }
    }
    const active = qualifier.activeSession(CHANNEL, ctx.from.id);
    if (active) {
      await ctx.reply('Продолжим опрос. Начать заново — /restart');
      return ask(ctx, qualifier.resume(active));
    }
    return startNew(ctx);
  });

  dm.command('restart', (ctx) => startNew(ctx));

  dm.callbackQuery(/^a:([a-z0-9_]+):(\d+)$/, async (ctx) => {
    const [, stepId, index] = ctx.match;
    await handleButton(ctx, stepId, (step) => {
      const option = step.options?.[Number(index)];
      return option && { input: { stepId, value: option.value }, label: option.label };
    });
  });

  dm.callbackQuery(/^s:([a-z0-9_]+)$/, async (ctx) => {
    const [, stepId] = ctx.match;
    await handleButton(ctx, stepId, () => ({ input: { stepId, skip: true }, label: 'Пропущено' }));
  });

  // «Оставить контакт» в диалоге с ИИ — с любого шага
  dm.callbackQuery('lc', async (ctx) => {
    const session = qualifier.activeSession(CHANNEL, ctx.from.id);
    if (!session) return ctx.answerCallbackQuery({ text: 'Опрос завершён. Начать заново — /restart' });
    await ctx.answerCallbackQuery();
    return submit(ctx, session, { action: 'contact' });
  });

  dm.on('message:contact', async (ctx) => {
    const session = qualifier.activeSession(CHANNEL, ctx.from.id);
    if (!session) return startNew(ctx);
    const current = qualifier.resume(session);
    // в диалоге с ИИ номер можно оставить в любой момент: сначала согласие, потом контакт
    if (current.canLeaveContact) return submit(ctx, session, { action: 'contact' });
    if (current.type !== 'question' || current.step.type !== 'contact') {
      await ctx.reply('Сейчас нужен ответ на другой вопрос.');
      return ask(ctx, current);
    }
    const { phone_number: phone, first_name: name } = ctx.message.contact;
    return submit(ctx, session, { stepId: current.step.id, value: { phone, name } });
  });

  dm.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return ctx.reply('Команды: /start — продолжить опрос, /restart — начать заново.');
    const session = qualifier.activeSession(CHANNEL, ctx.from.id);
    if (!session) return startNew(ctx);
    const current = qualifier.resume(session);
    return submit(ctx, session, { stepId: current.step?.id, value: text });
  });

  dm.on('message', async (ctx) => {
    const session = qualifier.activeSession(CHANNEL, ctx.from.id);
    if (!session) return startNew(ctx);
    await ctx.reply('Ответьте, пожалуйста, текстом или кнопкой.');
    return ask(ctx, qualifier.resume(session));
  });

  async function startNew(ctx, { test = false } = {}) {
    const { reply } = qualifier.startSession({
      channel: CHANNEL,
      channelUserId: ctx.from.id,
      meta: { ...profileMeta(ctx.from), ...(test ? { test: true } : {}) },
    });
    if (test) await ctx.reply('🧪 Тестовый опрос: заявка не попадёт к менеджерам.');
    // в диалоге с ИИ отдельного вступления нет — приветствие в первом вопросе
    if (reply.intro) await ctx.reply(reply.intro, { reply_markup: { remove_keyboard: true } });
    return ask(ctx, reply);
  }

  /** Нажатие кнопки варианта: отмечаем выбор в исходном сообщении и задаём следующий вопрос. */
  async function handleButton(ctx, stepId, pick) {
    const session = qualifier.activeSession(CHANNEL, ctx.from.id);
    const current = session && qualifier.resume(session);
    if (!current || current.type !== 'question' || current.step.id !== stepId) {
      return ctx.answerCallbackQuery({ text: session ? 'Этот вопрос уже пройден' : 'Опрос завершён. Начать заново — /restart' });
    }
    const choice = pick(current.step);
    if (!choice) return ctx.answerCallbackQuery({ text: 'Вариант устарел, выберите ещё раз' });

    await ctx.answerCallbackQuery();
    await ctx
      .editMessageText(`${questionHtml(current)}\n\n✅ ${esc(choice.label)}`, { parse_mode: 'HTML' })
      .catch((err) => log.warn({ err }, 'Не удалось отметить выбор в сообщении'));
    return submit(ctx, session, choice.input);
  }

  async function submit(ctx, session, input) {
    // разбор ответа ИИ занимает пару секунд — Telegram покажет «печатает…»
    ctx.replyWithChatAction?.('typing').catch(() => {});
    try {
      const reply = await qualifier.answer(session.id, input);
      return ask(ctx, reply);
    } catch (err) {
      if (!(err instanceof AnswerError)) throw err;
      await ctx.reply(err.message);
      const fresh = qualifier.activeSession(CHANNEL, ctx.from.id);
      if (fresh) return ask(ctx, qualifier.resume(fresh));
    }
  }

  async function ask(ctx, reply) {
    if (reply.type === 'done') {
      await ctx.reply(reply.text, { reply_markup: { remove_keyboard: true } });
      if (reply.hint) await ctx.reply(reply.hint);
      return;
    }
    const { step } = reply;
    // сообщения перед вопросом (примерная смета) — отдельно
    for (const t of step.before ?? []) await ctx.reply(t, { link_preview_options: { is_disabled: true } });
    let text = questionHtml(reply);
    let markup;

    if (step.type === 'choice' || step.type === 'consent') {
      const kb = new InlineKeyboard();
      step.options.forEach((o, i) => kb.text(o.label, `a:${step.id}:${i}`).row());
      if (!step.required) kb.text('Пропустить', `s:${step.id}`);
      markup = kb;
      if (step.type === 'consent' && privacyPolicyUrl) {
        text += `\n\n<a href="${esc(privacyPolicyUrl)}">Политика обработки персональных данных</a>`;
      }
    } else if (step.type === 'contact') {
      const kb = new Keyboard().requestContact('📱 Поделиться номером');
      if (ctx.from.username) kb.row().text(`@${ctx.from.username}`);
      markup = kb.resized().oneTime();
      text += '\n\nНажмите кнопку ниже или напишите телефон / e-mail.';
    } else if (!step.required) {
      markup = new InlineKeyboard().text('Пропустить', `s:${step.id}`);
    }
    if (reply.canLeaveContact) {
      markup = markup instanceof InlineKeyboard ? markup.row() : new InlineKeyboard();
      markup.text('📱 Оставить контакт и закончить', 'lc');
    }

    await ctx.reply(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(markup ? { reply_markup: markup } : {}),
    });
  }

  // ---------- чат менеджеров ----------

  bot.callbackQuery(/^take:(\d+)$/, async (ctx) => {
    if (String(ctx.chat?.id) !== String(managerChatId)) return ctx.answerCallbackQuery();
    const who = ctx.from.username ? `@${ctx.from.username}` : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const { ok, lead } = qualifier.takeLead(Number(ctx.match[1]), who);
    if (!lead) return ctx.answerCallbackQuery({ text: 'Лид не найден' });
    if (!ok) return ctx.answerCallbackQuery({ text: `Уже в работе: ${lead.assignee}` });
    await ctx.answerCallbackQuery({ text: 'Лид ваш' });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(`✅ В работе: ${who}`, 'noop') });
  });

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.catch(async ({ ctx, error }) => {
    log.error({ err: error, update: ctx.update.update_id }, 'Ошибка в Telegram-боте');
    if (ctx.chat?.type === 'private') {
      await ctx.reply('Что-то пошло не так. Попробуйте ещё раз или нажмите /start').catch(() => {});
    }
  });

  return bot;
}

/** Кнопка «Взять в работу» под карточкой лида. */
export function takeLeadMarkup(leadId) {
  return new InlineKeyboard().text('🙋 Взять в работу', `take:${leadId}`);
}

export async function setupTelegramCommands(bot) {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Начать или продолжить опрос' },
    { command: 'restart', description: 'Начать заново' },
  ]);
}

function questionHtml(reply) {
  const { step, progress } = reply;
  // в диалоге с ИИ счётчика вопросов нет
  return progress ? `<i>Вопрос ${progress.index} из ${progress.total}</i>\n${esc(step.text)}` : esc(step.text);
}

function profileMeta(user) {
  return {
    telegram: {
      id: user.id,
      ...(user.username ? { username: user.username } : {}),
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    },
  };
}

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
