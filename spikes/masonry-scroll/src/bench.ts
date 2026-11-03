// 自動でスクロールし、フレーム時間と「読み込みが間に合っていない画像」の割合を測る。

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 画面内にある画像のうち、まだ描画できていないものの割合 */
function blankRatio(el: HTMLElement): number {
  const view = el.getBoundingClientRect();
  const imgs = [...el.querySelectorAll("img")].filter((img) => {
    const r = img.getBoundingClientRect();
    return r.bottom > view.top && r.top < view.bottom;
  });
  // 読み込みに失敗した画像も complete になるので、naturalWidth が0なら空白として数える
  return imgs.length ? imgs.filter((img) => !img.complete || img.naturalWidth === 0).length / imgs.length : 0;
}

function stats(deltas: number[]) {
  const s = [...deltas].sort((a, b) => a - b);
  const p = (q: number) => +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1);
  return {
    frames: s.length,
    p50_ms: p(0.5),
    p95_ms: p(0.95),
    p99_ms: p(0.99),
    max_ms: +s[s.length - 1].toFixed(1),
    over_33ms: s.filter((d) => d > 33.4).length, // 1フレーム以上落ちたフレーム（60Hz基準）
  };
}

async function steady(el: HTMLElement, pxPerSec: number, seconds: number) {
  const deltas: number[] = [];
  const blanks: number[] = [];
  let last = await frame();
  const end = last + seconds * 1000;
  let nextSample = last + 100;
  while (last < end) {
    const now = await frame();
    deltas.push(now - last);
    el.scrollTop += (pxPerSec * (now - last)) / 1000;
    if (now >= nextSample) {
      blanks.push(blankRatio(el));
      nextSample = now + 100;
    }
    last = now;
  }
  return { px_per_sec: pxPerSec, ...stats(deltas), blank_avg: +(blanks.reduce((a, b) => a + b, 0) / blanks.length).toFixed(3) };
}

/** スクロールバーを掴んで遠くへ飛ぶ操作の代わり。飛んだ直後と0.5秒後に空白の割合を見る */
async function jumps(el: HTMLElement, height: number, count: number) {
  const rnd = mulberry32(1);
  const immediately: number[] = [];
  const after500: number[] = [];
  for (let k = 0; k < count; k++) {
    el.scrollTop = rnd() * (height - el.clientHeight);
    await frame();
    await frame();
    immediately.push(blankRatio(el));
    await sleep(500);
    after500.push(blankRatio(el));
  }
  const avg = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3);
  return { count, blank_after_2_frames: avg(immediately), blank_after_500ms: avg(after500) };
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function runBench(el: HTMLElement, height: number) {
  await sleep(1500);
  const visibleImgs = el.querySelectorAll("img").length;
  const slow = await steady(el, 1500, 6);
  const fast = await steady(el, 6000, 6);
  const jump = await jumps(el, height, 20);
  return { viewport: [el.clientWidth, el.clientHeight], content_height: Math.round(height), rendered_imgs: visibleImgs, slow, fast, jump };
}
