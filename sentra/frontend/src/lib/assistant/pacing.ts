/**
 * 返事までの間。
 *
 * すぐ返ってくる返事は、速いというより「聞いていない」に見える。読んで、
 * 考えて、答えた形跡が無いからで、中身が同じでも受け取られ方が変わる。
 * かといって長く待たせれば、ただ遅い道具になる。
 *
 * 長い返事ほど少しだけ長く考える。毎回きっかり同じ長さだと、機械が時間を
 * 数えているのが分かるので、わずかに揺らす。
 */

/** 何を答えるにしても、これだけは考える。 */
const FLOOR_MS = 620;

/** 返事 1 文字あたりに足す時間。 */
const PER_CHAR_MS = 9;

/** これ以上は、考えているのではなく待たせている。 */
const CEILING_MS = 1500;

/** 揺らす幅（割合）。 */
const JITTER = 0.15;

/**
 * つらさが混じった言葉への返事は、待たせない。
 *
 * 「死にたい」と打った人の前で、間を取って見せる必要はない。そこで欲しい
 * のは考えている様子ではなく、返事が来ることそのもの。
 */
const CALM_MS = 380;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function beatMs(say: string, { calm = false, random = Math.random }: { calm?: boolean; random?: () => number } = {}): number {
  if (calm) return CALM_MS;
  const considered = clamp(FLOOR_MS + say.length * PER_CHAR_MS, FLOOR_MS, CEILING_MS);
  // 揺らしたあとにも上限をかける。揺らぎで天井を越えると、長い返事のときだけ
  // ときどき「固まった？」と思う長さになる。
  return Math.round(clamp(considered * (1 + (random() * 2 - 1) * JITTER), FLOOR_MS / 2, CEILING_MS));
}
