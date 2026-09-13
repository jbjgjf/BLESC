/**
 * 小石（ペブル）の輪郭と表情。
 *
 * 形は絵として描き起こさず、すべて数値から組み立てている。理由は表情を
 * 「別の絵に差し替える」のではなく「同じ形を連続的に動かす」ためで、差し
 * 替えだとどうしてもパラパラ漫画になり、生き物に見えない。輪郭も目も
 * 12 個の数値から決まるので、その数値をばねで引っぱれば途中の姿が全部
 * 埋まる。
 *
 * ここは時刻も DOM も持たない純粋な関数だけに保つ。描画側（Pebble.tsx）が
 * 時間を進め、ここは「この数値のときどんな形か」だけを答える。こうして
 * おくと、形の検証をブラウザなしで書ける。
 *
 * 座標系は 100×100、中心は (50,50)。ロゴの花や五角形と同じ土俵に揃えて
 * あるので、並べても大きさの勘が狂わない。
 */

export const PEBBLE_VIEW = 100;

/**
 * 描画に使う viewBox。
 *
 * 座標は 100×100 で組むが、輪郭が実際に広がるのは中央の 82 角ぶんしかない。
 * そのまま 100×100 で出すと、ボタンの中で小石だけが一回り小さく浮いて
 * 当たり判定と見た目がずれる。余白を落として枠いっぱいに使う。
 * 値は tests/pebble.test.mjs が全表情の実測境界と突き合わせている。
 */
export const PEBBLE_VIEWBOX = "9 9 82 82";

const CX = 50;
const CY = 50;

/** 輪郭を何点で標本化するか。20 点あれば継ぎ目は見えない。 */
const SAMPLES = 20;

/** 呼吸で位相を振る幅（ラジアン）。これ以上は輪郭の性格が変わる。 */
export const PHASE_SWAY = 0.16;

/**
 * 小石らしさ。
 *
 * 楕円のままだと卵で、生き物には見えても石には見えない。低い倍音をわずかに
 * 足して左右を崩すと、角の取れた river stone の座りの悪さが出る。振幅は
 * どれも 5% 以下 — これ以上入れると「ひしゃげた何か」になる。
 */
const HARMONICS: ReadonlyArray<{ n: number; amp: number; phase: number }> = [
  { n: 2, amp: 0.052, phase: 1.15 },
  { n: 3, amp: 0.034, phase: 2.55 },
  { n: 5, amp: 0.013, phase: 0.35 },
];

/** 目の位置。中心より少し上に置くと幼く、下げると老けて見える。 */
const EYE_CY = 48;

/**
 * 表情を決める 12 個の数値。
 *
 * 単位はすべて 100 単位の座標系。up / down は目のふちを上下に張り出す量で、
 * ここが表情のほぼすべてを担う:
 *   up =  down = 6    ふつうに開いた目
 *   up =  down = 0.5  まばたき（細い線）
 *   up > 0, down < 0  下のふちも上に反った三日月 = 笑い
 *   up <  down        伏し目
 */
export type PebbleParams = {
  /** 本体の横半径。 */
  rx: number;
  /** 本体の縦半径。rx との差がつぶれ具合になる。 */
  ry: number;
  /** 傾き（度）。輪郭が左右非対称なので、回すと首をかしげて見える。 */
  lean: number;
  /** 上下の浮き。負が上。 */
  lift: number;
  gazeX: number;
  gazeY: number;
  /** 中心から各目までの距離。 */
  eyeGap: number;
  eyeRx: number;
  upL: number;
  downL: number;
  upR: number;
  downR: number;
};

/**
 * 表情の一覧。
 *
 * 口は作らない。目と体だけにしてあるのは、笑顔の絵文字のような顔が
 * 「いまの気分」を採点しているように見えるのを避けるため（企画書 10-1
 * 生徒を評価・監視する印象を与えない）。抽象的なままのほうが、この製品では
 * 正しい。
 */
export const EXPRESSIONS = {
  /** 待機。 */
  rest: {
    rx: 34, ry: 29, lean: 0, lift: 0,
    gazeX: 0, gazeY: 0,
    eyeGap: 13.4, eyeRx: 6.2,
    upL: 7.2, downL: 7.2, upR: 7.2, downR: 7.2,
  },
  /** 聞いている。少し伸び上がって目を開く。 */
  listening: {
    rx: 33.4, ry: 30.6, lean: -2, lift: -1.4,
    gazeX: 0, gazeY: 0.6,
    eyeGap: 13.6, eyeRx: 6.7,
    upL: 8.5, downL: 8.5, upR: 8.5, downR: 8.5,
  },
  /** 考え中。目線を上げ、片目を細める。 */
  thinking: {
    rx: 34.6, ry: 28.4, lean: -6, lift: -0.6,
    gazeX: 2.2, gazeY: -2.6,
    eyeGap: 13, eyeRx: 6,
    upL: 6.5, downL: 6.5, upR: 4.8, downR: 4.8,
  },
  /** できた。つぶれて浮き、目が三日月になる。 */
  happy: {
    rx: 36.2, ry: 26.6, lean: 0, lift: -2.6,
    gazeX: 0, gazeY: -0.4,
    eyeGap: 14, eyeRx: 7.1,
    upL: 8.4, downL: -3.6, upR: 8.4, downR: -3.6,
  },
  /** うまく分からなかった。縦に縮こまって目を丸くする。 */
  oops: {
    rx: 31.6, ry: 31.2, lean: 7, lift: 0.8,
    gazeX: -1.4, gazeY: 0.8,
    eyeGap: 12.8, eyeRx: 5.8,
    upL: 9.6, downL: 9.6, upR: 9.6, downR: 9.6,
  },
  /**
   * 落ち着いて。伏し目で、跳ねない。
   * つらさが混じった言葉を受け取ったときだけ使う。跳ねる小石が
   * 「死にたい」への返事の横で弾んでいるのは、ただの無神経になる。
   */
  steady: {
    rx: 34.4, ry: 28.8, lean: 0, lift: 0,
    gazeX: 0, gazeY: 0.4,
    eyeGap: 13.4, eyeRx: 6.3,
    upL: 5.4, downL: 6.4, upR: 5.4, downR: 6.4,
  },
} as const satisfies Record<string, PebbleParams>;

export type Expression = keyof typeof EXPRESSIONS;

/** まばたきのときの目のふち。0 にすると線が消えるので少し残す。 */
export const BLINK_EDGE = 0.55;

/** 数値 12 個を配列にして扱うための順序。ばねはこの並びで回す。 */
export const PARAM_KEYS = [
  "rx", "ry", "lean", "lift",
  "gazeX", "gazeY", "eyeGap", "eyeRx",
  "upL", "downL", "upR", "downR",
] as const satisfies ReadonlyArray<keyof PebbleParams>;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * 閉じた曲線を Catmull-Rom で通し、三次ベジェに変換する。
 *
 * 点を直線で結ぶと多角形になり、円弧で結ぶと継ぎ目で折れる。前後の点から
 * 接線を作るこの方式だと、標本点がどこにあっても曲率がつながる。
 */
function closedSpline(points: ReadonlyArray<{ x: number; y: number }>): string {
  const count = points.length;
  const at = (index: number) => points[((index % count) + count) % count];

  let path = `M${round(points[0].x)} ${round(points[0].y)}`;
  for (let index = 0; index < count; index += 1) {
    const previous = at(index - 1);
    const current = at(index);
    const next = at(index + 1);
    const after = at(index + 2);

    const c1x = current.x + (next.x - previous.x) / 6;
    const c1y = current.y + (next.y - previous.y) / 6;
    const c2x = next.x - (after.x - current.x) / 6;
    const c2y = next.y - (after.y - current.y) / 6;

    path += `C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(next.x)} ${round(next.y)}`;
  }
  return `${path}Z`;
}

/**
 * 本体の輪郭。
 *
 * phase は倍音の位相をまとめてずらす値。呼吸のゆらぎに使う。
 *
 * ここは必ず PHASE_SWAY 程度の幅で往復させること。単調に増やすと膨らみが
 * 輪郭をぐるりと一周し、同じ小石が別の形に化けていく（試すと分かるが、
 * 1 ラジアンも進めば丸みが三角がかって別人になる）。生きて見せたいだけで、
 * 姿を変えたいわけではない。
 */
export function bodyPath(params: PebbleParams, phase = 0): string {
  const lean = (params.lean * Math.PI) / 180;
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);

  const points = Array.from({ length: SAMPLES }, (_, index) => {
    const theta = (index / SAMPLES) * Math.PI * 2;

    let radius = 1;
    for (const harmonic of HARMONICS) {
      radius += harmonic.amp * Math.cos(harmonic.n * theta + harmonic.phase + phase);
    }

    // 先に楕円へ写してから傾ける。順序を逆にすると、傾けた分だけ
    // 横長の軸まで回ってしまい、つぶれ具合が表情ごとにぶれる。
    const x = params.rx * radius * Math.cos(theta);
    const y = params.ry * radius * Math.sin(theta);

    return {
      x: CX + x * cos - y * sin,
      y: CY + params.lift + x * sin + y * cos,
    };
  });

  return closedSpline(points);
}

/**
 * 片目の輪郭。
 *
 * 上下 2 本の弧で挟んだ領域として描く。制御点を端点の真上・真下に置くと
 * 弧の頂点がちょうど up / down になるので（三次ベジェの中点は制御点の
 * 3/4）、4/3 倍して渡している。down を負にすると下のふちが上へ反り、
 * 同じ 1 本の式のまま三日月になる。
 */
export function eyePath(cx: number, cy: number, rx: number, up: number, down: number): string {
  const left = round(cx - rx);
  const right = round(cx + rx);
  const top = round(cy - (up * 4) / 3);
  const bottom = round(cy + (down * 4) / 3);
  const line = round(cy);

  return (
    `M${left} ${line}` +
    `C${left} ${top} ${right} ${top} ${right} ${line}` +
    `C${right} ${bottom} ${left} ${bottom} ${left} ${line}Z`
  );
}

/** 左右の目。視線のぶんだけ 2 つまとめて動く。 */
export function eyePaths(params: PebbleParams): { left: string; right: string } {
  const cy = EYE_CY + params.lift + params.gazeY;
  const lean = (params.lean * Math.PI) / 180;

  // 目も体と一緒に傾ける。傾けないと、体だけ回って顔が正面のままになり
  // 首をかしげたようには見えない。
  const offset = (dx: number) => ({
    x: CX + params.gazeX + dx * Math.cos(lean),
    y: cy + dx * Math.sin(lean),
  });

  const leftEye = offset(-params.eyeGap);
  const rightEye = offset(params.eyeGap);

  return {
    left: eyePath(leftEye.x, leftEye.y, params.eyeRx, params.upL, params.downL),
    right: eyePath(rightEye.x, rightEye.y, params.eyeRx, params.upR, params.downR),
  };
}

/** まばたきを 0〜1 で混ぜる。1 で完全に閉じる。 */
export function applyBlink(params: PebbleParams, amount: number): PebbleParams {
  if (amount <= 0) return params;
  const mix = (edge: number) => edge + (BLINK_EDGE - edge) * amount;
  return {
    ...params,
    upL: mix(params.upL),
    downL: mix(params.downL),
    upR: mix(params.upR),
    downR: mix(params.downR),
  };
}
