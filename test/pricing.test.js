import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPricing, createPricing, compileWords } from '../src/core/pricing.js';

const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);
const price = (text) => {
  const { services } = pricing.detect(text);
  const e = pricing.estimate(services, text);
  return e ? `${e.total} | ${e.ids.join(',')}` : null;
};

test('прайс агентства: варианты написания → нужный продукт', () => {
  assert.ok(pricing, 'config/pricing.json читается');
  const cases = {
    'нужен директ': 'от 30 000 ₽ | context',
    'Нужна настройка Яндекс.Директа': 'от 30 000 ₽ | context',
    'Хотим ППС и РСЯ': 'от 30 000 ₽ | context',
    'нужен аудит директа': 'от 20 000 ₽ | context_audit',
    'проверьте наш кабинет в директе, сливаем бюджет': 'от 20 000 ₽ | context_audit',
    'Таргетированная реклама во ВКонтакте': 'от 30 000 ₽ | target_vk',
    'хотим рекламу в телеге': 'от 30 000 ₽ | target_tg',
    'посевы в тг каналах': 'от 30 000 ₽ | target_tg',
    'реклама в тик-токе': 'от 40 000 ₽ | target_tt',
    'реклама в ВК и ведение группы вк': 'от 30 000 ₽ | target_vk,smm_vk',
    'ведение телеграм-канала': 'от 75 000 ₽ | smm_tg',
    'smm для кофейни': 'от 75 000 ₽ | smm',
    'SEO под яндекс и google': 'от 75 000 ₽ | seo',
    'продвижение сайта в гугле': 'от 75 000 ₽ | seo_google',
    'Хотим SEO+GEO': 'от 75 000 ₽ | seo',
    'хотим сделать лендос': 'от 120 000 ₽ | site_lp',
    'сайт с помощью ИИ': 'от 50 000 ₽ | site_ai',
    'нужна техподдержка сайта': 'от 25 000 ₽ | site_support',
    'ASO для приложения в App Store': 'от 70 000 ₽ | aso',
    'сквозная аналитика и коллтрекинг': 'от 60 000 ₽ | analytics',
    'внедрить ИИ-агента в отдел продаж': 'от 30 000 ₽ | ai_implementation',
    'промостраницы в Дзене': 'от 50 000 ₽ | promo_pages',
    'предпроектное исследование рынка': 'от 20 000 ₽ | research',
    'брендформанс': 'от 150 000 ₽ | brandformance',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(price(text), want, text);
});

test('прайс агентства: без ложных срабатываний', () => {
  for (const text of ['я директор компании, хотим больше продаж', 'Иван', 'Важна прозрачная отчётность', 'у нас интернет-магазин одежды', 'в контексте нашей задачи']) {
    assert.equal(price(text), null, text);
  }
  // описание того, что уже есть, — не заказ: «у нас лендинг» не добавляет цену лендинга
  assert.equal(price('у нас лендинг, нужен директ'), 'от 30 000 ₽ | context');
  assert.equal(price('стратегия ставок в директе'), 'от 30 000 ₽ | context');
  assert.equal(price('продвижение в Яндекс Маркете'), null, 'маркетплейсов в прайсе нет — цену не называем');
  assert.deepEqual(pricing.detect('продвижение в Яндекс Маркете').services, ['marketplaces']);
});

test('прайс: итог — самая низкая цена из сметы; медийная — индивидуально; ошибочный вариант не ломает словарь', () => {
  assert.equal(pricing.estimate(['context', 'site'], 'нужен директ и сделать лендинг').total, 'от 30 000 ₽', 'не 150 000 — не сумма');
  const e = pricing.estimate([], 'хотим медийку и стратегию продвижения');
  assert.equal(e.total, 'от 150 000 ₽');
  assert.deepEqual(e.items, ['Медийная реклама — индивидуально, рекламный бюджет от 150 000 ₽', 'Разработка стратегии интернет-маркетинга — от 150 000 ₽']);
  assert.equal(pricing.estimate([], 'нужна медийная реклама'), null, 'только «индивидуально» — суммы нет');

  const warned = [];
  const re = compileWords(['реклам вк', 'плохая(регулярка'], { warn: (m) => warned.push(m) });
  assert.ok(re.test('рекламу во вк'));
  assert.equal(warned.length, 1);

  // старый формат прайса продолжает работать
  const legacy = createPricing({ services: { seo: { from: 60000 } } });
  assert.equal(legacy.estimate(['seo']).total, 'от 60 000 ₽');
});
