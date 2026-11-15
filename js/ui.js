// 画面の部品：要素の取得、案内（トースト）、選択肢のダイアログ

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = 0;
export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  placeToast(t);
  // 出した直後に画面を移る場合（顔位置設定の「撮影して完了」等）は、移った先の映像の領域に合わせ直す
  requestAnimationFrame(() => placeToast(t));
  try { t.hidePopover?.(); t.showPopover?.(); } catch { /* popover に対応していない場合は、通常の要素として表示する */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ''; try { t.hidePopover?.(); } catch { /* 何もしない */ } }, ms);
}

/**
 * 映像の領域が見えている画面では、案内を映像の下端（顎・首のあたり）に出す。
 * 上端だと、撮影した直後に確かめたい眉・額と、右上の倍率の表示を覆うため。
 * 映像の下端に案内のバナーが出ていれば、その上に出す。映像の領域が無い画面（設定等）では、CSS の位置（ヘッダーのすぐ下）のまま
 */
function placeToast(t) {
  const stage = $('#stage')?.getBoundingClientRect();
  if (!stage || stage.height <= 0) { t.style.top = ''; t.style.transform = ''; return; }
  const banner = $('#banner');
  const bottom = banner && !banner.hidden ? banner.getBoundingClientRect().top - 8 : stage.bottom - 12;
  t.style.top = `${Math.round(bottom)}px`;
  t.style.transform = 'translate(-50%, -100%)';
}

/**
 * 選択肢のダイアログ
 * @param opt { title, html（説明。HTML）, choices: [{ value, label, desc, danger }], cancel（下のボタンの文字。省略で「キャンセル」、false で無し）, select: { options: [[value, label]], value } }
 * @returns {Promise<string|null>} 選んだ value（キャンセルは null）。select を指定した場合は { value, selected }
 */
export function choose(opt) {
  const dlg = $('#dlg'), form = $('#dlg-form');
  form.innerHTML = `
    <div class="dlg-body">
      <h2>${esc(opt.title)}</h2>
      ${opt.html || ''}
      ${opt.select ? `<select id="dlg-select">${opt.select.options.map(([v, l, dis]) => `<option value="${esc(v)}" ${v === opt.select.value ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
      ${(opt.choices || []).map((c) => `<button class="choice ${c.danger ? 'danger' : ''}" value="${esc(c.value)}"><b>${esc(c.label)}</b>${c.desc ? `<span>${esc(c.desc)}</span>` : ''}</button>`).join('')}
    </div>
    <div class="dlg-foot">
      <span class="grow"></span>
      ${opt.cancel === false ? '' : `<button class="btn btn-ghost" value="">${esc(opt.cancel || 'キャンセル')}</button>`}
      ${opt.ok ? `<button class="btn btn-primary" value="ok">${esc(opt.ok)}</button>` : ''}
    </div>`;
  return new Promise((resolve) => {
    const done = () => {
      const v = dlg.returnValue || null;
      dlg.removeEventListener('close', done);
      resolve(opt.select ? (v ? { value: v, selected: $('#dlg-select', form).value } : null) : v);
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', done);
    dlg.showModal();
    // 前に開いたときのスクロール位置に関わらず、先頭から表示する（横向き等で高さが足りない場合）
    $('.dlg-body', form).scrollTop = 0;
  });
}
