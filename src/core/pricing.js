// Предварительная стоимость «от … ₽» для квалификатора — по продуктовой матрице агентства.
// Сумму считает код по прайсу (config/pricing.json), а не ИИ: модель только определяет, какие
// услуги нужны клиенту. Нет файла или нет цены у услуги — шаг с ценой пропускается.
//
// config/pricing.json: { "services": { "<значение услуги из сценария>": { "from": 50000, "unit": "в месяц" } } }

import { existsSync, readFileSync } from 'node:fs';

const rub = (v) => `${Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;

export function loadPricing(file, log = console) {
  if (!existsSync(file)) return null;
  try {
    return createPricing(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    log.error?.({ err }, `Прайс квалификатора не прочитан: ${file}`);
    return null;
  }
}

export function createPricing(matrix) {
  const services = matrix?.services ?? {};
  return {
    /** «от 90 000 ₽ в месяц» по выбранным услугам или null, если цен нет. */
    estimate(list) {
      const items = [...new Set(list ?? [])].map((s) => services[s]).filter((x) => x && typeof x.from === 'number' && x.from > 0);
      if (!items.length) return null;
      const total = items.reduce((n, x) => n + x.from, 0);
      const units = [...new Set(items.map((x) => x.unit).filter(Boolean))];
      return `от ${rub(total)}${units.length === 1 ? ` ${units[0]}` : ''}`;
    },
  };
}
