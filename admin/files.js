// Загрузка файлов сотрудников (фото, видео, документы) — для «Новостей» и вложений к задачам.
// Фото браузер заранее разворачивает по EXIF и уменьшает; видео и документы уходят как есть,
// с полосой прогресса. Сервер сам проверяет формат и размер.

import { h, icon, api, toast, confirmDialog } from './admin.js';
import { fill } from './docs.js';
import { prepareImage } from './docs.js';

export const ACCEPT_MEDIA = 'image/jpeg,image/png,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm';
export const ACCEPT_ANY = `${ACCEPT_MEDIA},application/pdf,.docx,.xlsx,.pptx,.zip,.txt,.csv`;

// расширение → тип, если браузер не определил его сам (часто с .docx/.xlsx/.mov)
const BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', txt: 'text/plain', csv: 'text/csv', pdf: 'application/pdf',
  mov: 'video/quicktime', mp4: 'video/mp4', webm: 'video/webm',
};

/** Загрузить файл; onProgress(0…1). Возвращает { id, mime, kind, name, bytes }. */
export async function uploadFile(file, { onProgress = () => {} } = {}) {
  let body = file;
  let type = file.type || BY_EXT[file.name.split('.').pop().toLowerCase()] || 'application/octet-stream';
  if (/^image\/(jpeg|png|webp|heic|heif)$/.test(type) || /\.(heic|heif)$/i.test(file.name)) {
    body = await prepareImage(file);
    type = body.type || 'image/jpeg';
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/admin/api/files');
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', type);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 413 && !data.error) data.error = 'Файл слишком большой для сервера';
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
      else reject(new Error(data.error || 'Не удалось загрузить файл'));
    };
    xhr.onerror = () => reject(new Error('Нет связи с сервером — файл не загрузился'));
    xhr.send(body);
  });
}

export const fileUrl = (f) => `/admin/api/files/${f.id}`;
export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
}

/** Картинки и видео — сеткой; документы — строками со ссылкой на скачивание. */
export function filesView(files, { onOpenImage = null } = {}) {
  const media = files.filter((f) => f.kind !== 'doc');
  const docs = files.filter((f) => f.kind === 'doc');
  return [
    media.length
      ? h(
          'div',
          { class: `media-grid n${Math.min(media.length, 4)}` },
          media.slice(0, media.length > 4 ? 4 : media.length).map((f, i) =>
            f.kind === 'video'
              ? h('video', { class: 'media-item', src: fileUrl(f), controls: true, preload: 'metadata', playsinline: true })
              : h(
                  'button',
                  { type: 'button', class: 'media-item media-img', 'aria-label': `Открыть фото ${f.name}`, onclick: () => (onOpenImage ? onOpenImage(media.filter((x) => x.kind === 'image'), f) : window.open(fileUrl(f), '_blank')) },
                  h('img', { src: fileUrl(f), alt: '', loading: 'lazy' }),
                  i === 3 && media.length > 4 ? h('span', { class: 'media-more' }, `+${media.length - 4}`) : null,
                ),
          ),
        )
      : null,
    docs.length
      ? h('ul', { class: 'file-list' }, docs.map((f) => h('li', {}, icon('docs'), h('a', { href: fileUrl(f), target: '_blank', rel: 'noopener' }, f.name), h('span', { class: 'muted small' }, fileSize(f.bytes)))))
      : null,
  ];
}

/** Просмотр фото во весь экран: стрелки, Esc. */
export function lightbox(images, start) {
  let i = Math.max(0, images.findIndex((x) => x.id === start.id));
  const img = h('img', { alt: '' });
  const counter = h('span', { class: 'lb-count' });
  const show = () => {
    img.src = fileUrl(images[i]);
    counter.textContent = images.length > 1 ? `${i + 1} из ${images.length}` : '';
  };
  const go = (d) => {
    i = (i + d + images.length) % images.length;
    show();
  };
  const dlg = h(
    'dialog',
    { class: 'lightbox', 'aria-label': 'Фото', onclick: (e) => e.target === dlg && dlg.close() },
    img,
    images.length > 1 ? [h('button', { type: 'button', class: 'lb-nav lb-prev', 'aria-label': 'Предыдущее', onclick: () => go(-1) }, '‹'), h('button', { type: 'button', class: 'lb-nav lb-next', 'aria-label': 'Следующее', onclick: () => go(1) }, '›')] : null,
    h('button', { type: 'button', class: 'lb-close', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, '×'),
    counter,
  );
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  show();
  dlg.showModal();
}

/**
 * Блок «Файлы» (задача, клиент): список с превью, прикрепить кнопкой, перетаскиванием или Ctrl+V.
 * attach(ids) и detach(file) возвращают свежий список файлов.
 */
export function filesBox({ files: initial = [], attach, detach, onChanged = () => {}, title = 'Файлы', hint = '' }) {
  let files = initial;
  const box = h('section', { class: 'task-files' });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, accept: ACCEPT_ANY, onchange: (e) => add(e.target.files) });
  const progress = h('div', { class: 'news-attach' });
  async function add(list) {
    const ids = [];
    for (const file of [...(list ?? [])]) {
      const bar = h('i');
      const chip = h('div', { class: 'attach-chip uploading' }, h('span', { class: 'attach-name' }, file.name), h('span', { class: 'attach-bar' }, bar));
      progress.append(chip);
      try {
        ids.push((await uploadFile(file, { onProgress: (x) => (bar.style.width = `${Math.round(x * 100)}%`) })).id);
      } catch (err) {
        toast(err.message);
      } finally {
        chip.remove();
      }
    }
    picker.value = '';
    if (!ids.length) return;
    try {
      files = await attach(ids);
      onChanged();
      draw();
    } catch (err) {
      toast(err.message);
    }
  }
  async function remove(f) {
    if (!(await confirmDialog(`Удалить файл «${f.name}»?`))) return;
    try {
      files = await detach(f);
      onChanged();
      draw();
    } catch (err) {
      toast(err.message);
    }
  }
  function draw() {
    const images = files.filter((f) => f.kind === 'image');
    fill(
      box,
      h('div', { class: 'checklist-head' }, h('h3', {}, title), files.length ? h('span', { class: 'muted small num' }, files.length) : null, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-s', onclick: () => picker.click() }, icon('clip'), 'Прикрепить')),
      files.length
        ? h(
            'ul',
            { class: 'task-file-list' },
            files.map((f) =>
              h(
                'li',
                {},
                f.kind === 'image'
                  ? h('button', { type: 'button', class: 'task-file-thumb', 'aria-label': `Открыть ${f.name}`, onclick: () => lightbox(images, f) }, h('img', { src: fileUrl(f), alt: '', loading: 'lazy' }))
                  : h('span', { class: 'task-file-thumb' }, f.kind === 'video' ? '▶' : icon('docs')),
                h('div', { class: 'task-file-main' }, h('a', { href: fileUrl(f), target: '_blank', rel: 'noopener' }, f.name), h('span', { class: 'muted small' }, `${fileSize(f.bytes)}${f.added_by ? ` · ${f.added_by}` : ''}`)),
                h('button', { type: 'button', class: 'icon-btn checklist-del', title: 'Удалить файл', 'aria-label': `Удалить файл ${f.name}`, onclick: () => remove(f) }, icon('trash')),
              ),
            ),
          )
        : hint ? h('p', { class: 'muted small task-files-empty' }, hint) : null,
      progress,
      picker,
    );
  }
  box.addEventListener('dragover', (e) => (e.preventDefault(), box.classList.add('drag')));
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag');
    add(e.dataTransfer.files);
  });
  // скриншот из буфера, пока блок на экране (и курсор не в поле ввода)
  const paste = (e) => {
    if (!box.isConnected) return document.removeEventListener('paste', paste);
    const list = [...(e.clipboardData?.files ?? [])];
    if (list.length && !e.target.closest?.('textarea, input')) {
      e.preventDefault();
      add(list);
    }
  };
  document.addEventListener('paste', paste);
  draw();
  return box;
}
