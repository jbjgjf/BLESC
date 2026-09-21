/**
 * 案内役が画面の中を移動して、話したい場所まで行くときの道すじ。
 *
 * 「〜はここです」と書いて枠を出すだけでも用は足りる。ただ、画面の隅から
 * 動かない案内役は、説明を読み上げる札であって、案内している誰かには
 * 見えない。滑っていって、その前に立ち、そこで話す — 同じ内容でも、
 * どこの話なのかが目で分かる。
 *
 * 転がる石なので、進みながら回る。回るのは移動のあいだだけで、着いたら
 * ちょうど上を向いて止まる。
 *
 * ここは座標だけを扱う純粋な関数に保つ。DOM も時間も持たないので、
 * 跳ね方と立ち位置をブラウザ無しで確かめられる。座標はすべて viewport
 * （position: fixed と同じ）基準の px。
 */

export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
export type Viewport = { width: number; height: number };

/** 画面のふちに残す余白。小石が半分だけ見えている状態を作らない。 */
export const MARGIN = 12;

/** 立つ場所を、示す相手からどれだけ離すか（小石の大きさに対する割合）。 */
const STANDOFF = 0.42;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * 吹き出しのおよその幅。出す側を決めるときの当たり判定に使う。
 * Guide.module.css の max-width（min(260px, 52vw)）と揃える — ここだけ広く
 * 見積もると、入る吹き出しを下へ追い出す。
 */
const bubbleRoom = (viewport: Viewport) => Math.min(260, viewport.width * 0.52) + 10;

/** 吹き出しのおよその高さ。上に出せるかどうかの当たり判定に使う。 */
const ABOVE_ROOM = 96;

export type Stand = {
  x: number;
  y: number;
  /** 立った先から見て、示す相手がどちらにあるか（目線の向き）。 */
  look: "left" | "right" | "down";
  /** 吹き出しを出す側。示している相手にかぶらない側を選ぶ。 */
  bubble: "left" | "right" | "above" | "below";
};

const intersect = (target: Rect, viewport: Viewport): Rect => {
  const left = clamp(target.left, 0, viewport.width);
  const right = clamp(target.right, 0, viewport.width);
  const top = clamp(target.top, 0, viewport.height);
  const bottom = clamp(target.bottom, 0, viewport.height);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

/**
 * 示す相手の、どこに立つか。
 *
 * 横に立てるなら左が既定。日本語は左から読むので、読む人の視線の手前にいる。
 * 左が詰まっていれば右。
 *
 * カードのように画面幅いっぱいの相手には、横に立つ場所が無い。その場合は
 * 左上の角に腰かける — 中央に立つと説明の上に乗るし、上に浮くと画面の外へ
 * 追い出される（実際、全幅のカードでは画面の天井に張りついた）。角なら、
 * どのカードの話かは分かるし、隠すのは余白だけで済む。
 *
 * 相手が画面から食み出していても、見えている範囲を基準にする。見えていない
 * 所を指して立っても、そこには誰もいない。
 */
export function standingSpot(target: Rect, viewport: Viewport, size: number): Stand {
  const seen = intersect(target, viewport);
  const gap = size * STANDOFF;
  const half = size / 2;
  const withinY = (value: number) => clamp(value, half + MARGIN, viewport.height - half - MARGIN);
  const withinX = (value: number) => clamp(value, half + MARGIN, viewport.width - half - MARGIN);

  const y = withinY(seen.top + Math.min(seen.height / 2, size));

  const left = seen.left - gap - half;
  if (left >= half + MARGIN) {
    return { x: left, y, look: "right", bubble: left - half - bubbleRoom(viewport) >= MARGIN ? "left" : "below" };
  }

  const right = seen.right + gap + half;
  if (right <= viewport.width - half - MARGIN) {
    return { x: right, y, look: "left", bubble: right + half + bubbleRoom(viewport) <= viewport.width - MARGIN ? "right" : "below" };
  }

  // 横に立てない。左上の角へ。
  //
  // 吹き出しは上に出す。横に出すと、いま説明している当のカードの上に
  // かぶる（説明しているものを隠すのでは、指した意味がない）。上が詰まって
  // いるときだけ下へ回す — そこはまだカードの外側。
  const corner = { x: withinX(seen.left + size * 0.45), y: withinY(seen.top) };
  return {
    x: corner.x,
    y: corner.y,
    look: "down",
    bubble: corner.y - half - ABOVE_ROOM >= MARGIN ? "above" : "below",
  };
}

/** 移動にかける時間。近くても間が要る（消えて現れたように見せない）。 */
const GLIDE_MS_MIN = 420;
const GLIDE_MS_PER_PX = 0.55;
const GLIDE_MS_MAX = 1100;

/** 1 回転するのにかかる距離のめやすと、回る回数の上限。 */
const SPIN_PER_PX = 1 / 420;
const SPIN_MAX_TURNS = 3;

/** 移動にかける時間。 */
export function glideMs(from: Point, to: Point): number {
  return clamp(GLIDE_MS_MIN + distanceBetween(from, to) * GLIDE_MS_PER_PX, GLIDE_MS_MIN, GLIDE_MS_MAX);
}

const distanceBetween = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y);

/**
 * 行きと帰りの緩急。
 *
 * 等速だと、動いているのではなく運ばれているように見える。ゆっくり出て、
 * 中ほどで速く、着く手前でまた緩める。
 */
export function easeInOut(t: number): number {
  const progress = clamp(t, 0, 1);
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/** 移動の途中の位置。t は 0〜1（緩急はここで掛ける）。 */
export function glideAt(from: Point, to: Point, t: number): Point {
  const eased = easeInOut(t);
  return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
}

/**
 * 移動のあいだに回る角度（度）。
 *
 * 転がる石なので、進む向きに回る — 右へ行けば時計回り、左へ行けば逆。
 * 回る数は必ず整数にする。半端に終わると、着いた先で傾いたまま話し始める。
 */
export function spinFor(from: Point, to: Point): number {
  const turns = clamp(Math.round(distanceBetween(from, to) * SPIN_PER_PX), 1, SPIN_MAX_TURNS);
  return (to.x >= from.x ? 1 : -1) * turns * 360;
}

/**
 * 話し終わるまで留まる時間。
 *
 * 読む速さは 1 秒に 8 文字ほどを見込む。短い言葉でも 2.4 秒は残す
 * （目を向ける前に消えると、何か言ったことにすら気づけない）。
 */
export function dwellMs(text: string): number {
  return clamp(2400 + text.length * 125, 2400, 11000);
}

/**
 * その場で話すぶんの言葉。
 *
 * 説明がまるごと入った吹き出しは、指している相手より大きくなる。長い話は
 * パネルの会話に残っているので、ここでは最初のひと区切りだけを話す。
 */
export function speechFor(text: string, limit = 84): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const stop = trimmed.slice(0, limit).lastIndexOf("。");
  return stop > 20 ? trimmed.slice(0, stop + 1) : `${trimmed.slice(0, limit).trimEnd()}…`;
}

/**
 * 上下に出した吹き出しを、画面の中へ寄せる量。
 *
 * 小石を中心に置くと、端に立ったとき吹き出しが画面の外へ出る（左上の角に
 * 腰かけたとき、実際に頭が切れた）。はみ出すぶんだけ横へずらす。
 */
export function bubbleShift(centre: number, width: number, viewportWidth: number): number {
  const half = width / 2;
  if (width + MARGIN * 2 >= viewportWidth) return 0;
  return clamp(centre, MARGIN + half, viewportWidth - MARGIN - half) - centre;
}
