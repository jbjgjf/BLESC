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
/**
 * 体の中心。viewBox の中心（50）より下に置く。
 *
 * 芽が上へ伸びるぶん、composition の重心は上がる。石を枠の真ん中に置くと
 * 頭がつかえ、芽を小さくするしかなくなる — 小さい芽は黒く塗ったときに
 * 消えてしまい、輪郭で見分けられるようにした意味がなくなる。石を下げ、
 * 空いた上を芽に使う。下は影のぶんだけ空けてある。
 */
const CY = 54;

/** 体の中心。テストと、並べて置くときの位置合わせに使う。 */
export const BODY_CENTER = { x: CX, y: CY } as const;

type Point = { x: number; y: number };

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

/**
 * 底をわずかに平らにする量。
 *
 * まん丸のままだと、置いてあるのではなく浮いている風船に見える。下側だけ
 * sin² のぶん詰めると、接地したところが平たくなって「座っている石」になる。
 * 影と合わせて読ませるので、これ以上強くしなくていい（0.2 を超えると
 * 底が直線になって、削った石のように見える）。
 */
const BASE_FLATTEN = 0.13;

/**
 * 輪郭が、半径に対して横（x）と縦（y）へ張り出す最大の割合。倍音と、呼吸で
 * 揺らす位相の幅を含めて読み込み時に一度だけ測る。
 *
 * 横と縦は別に測る。半径がいちばん大きくなる向きは真横でも真上でもないので、
 * 1 つの値で済ませると張り出しを大きく見積もり、笑った顔の横幅まで削って
 * しまう（倍音の振幅をただ足した 1.099 では、止まっているだけで削れた）。
 */
const BULGE = (() => {
  let x = 0;
  let y = 0;
  for (let step = 0; step < 720; step += 1) {
    const theta = (step / 720) * Math.PI * 2;
    for (const sway of [-PHASE_SWAY, -PHASE_SWAY / 2, 0, PHASE_SWAY / 2, PHASE_SWAY]) {
      let radius = 1;
      for (const harmonic of HARMONICS) radius += harmonic.amp * Math.cos(harmonic.n * theta + harmonic.phase + sway);
      x = Math.max(x, radius * Math.abs(Math.cos(theta)));
      y = Math.max(y, radius * Math.abs(Math.sin(theta)));
    }
  }
  // 標本点のあいだを通る曲線と、傾けたときに縦横が混ざるぶんを見込む。
  return { x: x * 1.03, y: y * 1.03 };
})();

/**
 * 伸び縮みしても viewBox に収まる半径の上限。
 *
 * 浮いているぶん（lift）上下の余白が減り、線の太さの半分（strokeHalf）だけ
 * 内側に下がる。固定の上限にすると、跳ねて伸びる瞬間に頭打ちになる — 縦
 * 半径を 32 で止めていたときは、聞いている顔の伸びが 3% で止まり、ほとんど
 * 見えなかった。伸びが最大になるのは飛び上がった直後で、まだ高く浮いて
 * いないので、そのときの浮きで測れば余白は十分にある。
 */
export function shapeRoom(lift: number, strokeHalf: number): { rx: number; ry: number } {
  const [vx, vy, vw, vh] = PEBBLE_VIEWBOX.split(" ").map(Number);
  const halfWidth = Math.min(CX - vx, vx + vw - CX);
  const halfHeight = Math.min(CY - vy, vy + vh - CY);
  return {
    rx: (halfWidth - strokeHalf) / BULGE.x,
    ry: (halfHeight - strokeHalf - Math.abs(lift)) / BULGE.y,
  };
}

/** 目の位置。中心より少し上に置くと幼く、下げると老けて見える。 */
const EYE_CY = 52;

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
    rx: 30.94, ry: 24.94, lean: 0, lift: 0,
    gazeX: 0, gazeY: 0,
    eyeGap: 12.19, eyeRx: 5.58,
    upL: 6.48, downL: 6.48, upR: 6.48, downR: 6.48,
  },
  /** 聞いている。少し伸び上がって目を開く。 */
  listening: {
    rx: 30.39, ry: 26.32, lean: -2, lift: -1.4,
    gazeX: 0, gazeY: 0.6,
    eyeGap: 12.38, eyeRx: 6.03,
    upL: 7.65, downL: 7.65, upR: 7.65, downR: 7.65,
  },
  /** 考え中。目線を上げ、片目を細める。 */
  thinking: {
    rx: 31.49, ry: 24.42, lean: -6, lift: -0.6,
    gazeX: 2.2, gazeY: -2.6,
    eyeGap: 11.83, eyeRx: 5.4,
    upL: 5.85, downL: 5.85, upR: 4.32, downR: 4.32,
  },
  /** できた。つぶれて浮き、目が三日月になる。 */
  happy: {
    rx: 32.94, ry: 22.88, lean: 0, lift: -2.6,
    gazeX: 0, gazeY: -0.4,
    eyeGap: 12.74, eyeRx: 6.39,
    upL: 7.56, downL: -3.24, upR: 7.56, downR: -3.24,
  },
  /** うまく分からなかった。縦に縮こまって目を丸くする。 */
  oops: {
    rx: 28.76, ry: 26.83, lean: 7, lift: 0.8,
    gazeX: -1.4, gazeY: 0.8,
    eyeGap: 11.65, eyeRx: 5.22,
    upL: 8.64, downL: 8.64, upR: 8.64, downR: 8.64,
  },
  /**
   * 落ち着いて。伏し目で、跳ねない。
   * つらさが混じった言葉を受け取ったときだけ使う。跳ねる小石が
   * 「死にたい」への返事の横で弾んでいるのは、ただの無神経になる。
   */
  steady: {
    rx: 31.3, ry: 24.77, lean: 0, lift: 0,
    gazeX: 0, gazeY: 0.4,
    eyeGap: 12.19, eyeRx: 5.67,
    upL: 4.86, downL: 5.76, upR: 4.86, downR: 5.76,
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
function closedSpline(points: ReadonlyArray<Point>): string {
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

    const shape = contour(theta, phase);

    // 先に楕円へ写してから傾ける。順序を逆にすると、傾けた分だけ
    // 横長の軸まで回ってしまい、つぶれ具合が表情ごとにぶれる。
    const x = params.rx * shape.rx * Math.cos(theta);
    const y = params.ry * shape.ry * Math.sin(theta);

    return {
      x: CX + x * cos - y * sin,
      y: CY + params.lift + x * sin + y * cos,
    };
  });

  return closedSpline(points);
}

/**
 * 芽。ロゴの花びらを 1 枚、石の肩から伸ばす。
 *
 * 丸い体に丸い目だけだと、どこかで見たスライムになる。黒く塗りつぶした
 * ときに何者か分かるかどうかが、そのまま「うちの子かどうか」なので、
 * 輪郭そのものに製品の形を入れる。使うのは petal.ts の花びら —
 * ロゴ・気分の花・五角形と同じ 1 枚で、拡大しても仲間に見える。
 *
 * 意味のほうも合っている。小さな記録がたまって、やがて花になる。石から
 * 出た芽は、その途中を指している。
 */
export const SPROUT = {
  /** 付け根を置く角度。真上（-π/2）から左へ。 */
  angle: -Math.PI / 2 - 0.63,
  /** 花びら（長さ 47）に掛ける倍率。 */
  scale: 0.47,
  /** 付け根での、外向きからの傾き（度）。まっすぐ立てると造花に見える。 */
  tilt: -9,
  /** 石へ沈める深さ。継ぎ目が出ないぶんだけ埋める。 */
  sink: 4.2,
} as const;

/**
 * 花びらの制御点（M 1 点 + C 3 点 × 2）。blesc/petal.ts の PETAL_PATH と同じ形。
 *
 * import せずに書き写しているのは、この module をブラウザ無しで（node の
 * 単体テストから）そのまま読めるようにしておくため。型以外の import を足すと、
 * 拡張子の要る node と、要らない tsc のどちらかが通らなくなる。写し間違いと
 * 将来のずれは tests/assistant.test.mjs が PETAL_PATH と突き合わせて止める。
 */
/** 花びらの座標系の中心（petal.ts の BLOOM_CENTER）。 */
const PETAL_ORIGIN = 50;

const PETAL_POINTS: ReadonlyArray<Point> = [
  { x: 50, y: 50 },
  { x: 37, y: 34 },
  { x: 33, y: 17 },
  { x: 50, y: 3 },
  { x: 67, y: 17 },
  { x: 63, y: 34 },
  { x: 50, y: 50 },
];

/** 輪郭の、その角度での半径（倍音と底の平らさを含む）。 */
function contour(theta: number, phase: number): { rx: number; ry: number } {
  let radius = 1;
  for (const harmonic of HARMONICS) radius += harmonic.amp * Math.cos(harmonic.n * theta + harmonic.phase + phase);
  const down = Math.max(0, Math.sin(theta));
  return { rx: radius, ry: radius * (1 - BASE_FLATTEN * down * down) };
}

/**
 * 芽の輪郭。付け根は輪郭の上に乗るので、体がつぶれても伸びても離れない。
 *
 * wag は付け根での余分な振り（度）。体が動いたあとに遅れてついてくる分を
 * 描画側から渡す。葉が遅れて揺れると、石のほうが重く見える。
 */
export function sproutPath(params: PebbleParams, phase = 0, wag = 0): string {
  const lean = (params.lean * Math.PI) / 180;
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);

  const shape = contour(SPROUT.angle, phase);
  const ex = params.rx * shape.rx * Math.cos(SPROUT.angle);
  const ey = params.ry * shape.ry * Math.sin(SPROUT.angle);

  // 傾けたあとの、体の中心から付け根へ向かう向き。芽はこの向きへ伸びる。
  const ax = ex * cos - ey * sin;
  const ay = ex * sin + ey * cos;
  const length = Math.hypot(ax, ay) || 1;
  const outward = { x: ax / length, y: ay / length };

  const baseX = CX + ax - outward.x * SPROUT.sink;
  const baseY = CY + params.lift + ay - outward.y * SPROUT.sink;

  // 花びらは上（-y）を向いているので、外向きの角度に 90 度足す。
  const angle = Math.atan2(outward.y, outward.x) + Math.PI / 2 + ((SPROUT.tilt + wag) * Math.PI) / 180;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);

  const place = (point: Point) => {
    // 花びらは自分の座標系（中心 50,50、上向き）で書かれている。体の中心
    // （CY）とは別物なので、ここで混ぜると芽だけが体からずれる。
    const px = (point.x - PETAL_ORIGIN) * SPROUT.scale;
    const py = (point.y - PETAL_ORIGIN) * SPROUT.scale;
    return { x: round(baseX + px * ca - py * sa), y: round(baseY + px * sa + py * ca) };
  };

  const [start, c1, c2, mid, c3, c4, end] = PETAL_POINTS.map(place);
  return (
    `M${start.x} ${start.y}` +
    `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${mid.x} ${mid.y}` +
    `C${c3.x} ${c3.y} ${c4.x} ${c4.y} ${end.x} ${end.y}Z`
  );
}

/**
 * 接地の影。浮くほど小さく薄くなる — 3D に見えるかどうかは、ほぼこれで決まる。
 * 返すのは楕円の中心と半径、そして濃さ（0〜1）。
 */
export function contactShadow(params: PebbleParams): { cx: number; cy: number; rx: number; ry: number; alpha: number } {
  const height = Math.max(0, -params.lift);
  const shrink = 1 - Math.min(height / 9, 0.42);
  return {
    cx: CX + params.lean * 0.16,
    cy: CY + params.ry * (1 - BASE_FLATTEN) + 3.4,
    rx: params.rx * 0.74 * shrink,
    ry: params.ry * 0.13 * shrink,
    alpha: 0.3 * shrink,
  };
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

/**
 * 左右の目の中心。
 *
 * 目も体と一緒に傾ける。傾けないと、体だけ回って顔が正面のままになり、
 * 首をかしげたようには見えない。目の艶もここから位置を取る。
 */
export function eyeCenters(params: PebbleParams): { left: Point; right: Point } {
  const cy = EYE_CY + params.lift + params.gazeY;
  const lean = (params.lean * Math.PI) / 180;
  const offset = (dx: number) => ({
    x: CX + params.gazeX + dx * Math.cos(lean),
    y: cy + dx * Math.sin(lean),
  });
  return { left: offset(-params.eyeGap), right: offset(params.eyeGap) };
}

/** 左右の目。視線のぶんだけ 2 つまとめて動く。 */
export function eyePaths(params: PebbleParams): { left: string; right: string } {
  const { left, right } = eyeCenters(params);
  return {
    left: eyePath(left.x, left.y, params.eyeRx, params.upL, params.downL),
    right: eyePath(right.x, right.y, params.eyeRx, params.upR, params.downR),
  };
}

/**
 * 艶（ハイライト）。左上から当たる光。
 *
 * 位置は半径に対する割合なので、つぶれても伸びても同じ面に残る。目線の
 * ぶんだけずらすと、平らな円ではなく丸い面が回っているように見える。
 */
export function sheenEllipse(params: PebbleParams): { cx: number; cy: number; rx: number; ry: number } {
  const lean = (params.lean * Math.PI) / 180;
  const ox = params.rx * SHEEN.x - params.gazeX * SHEEN.parallax;
  const oy = params.ry * SHEEN.y - params.gazeY * SHEEN.parallax;
  return {
    cx: CX + ox * Math.cos(lean) - oy * Math.sin(lean),
    cy: CY + params.lift + ox * Math.sin(lean) + oy * Math.cos(lean),
    rx: params.rx * SHEEN.rx,
    ry: params.ry * SHEEN.ry,
  };
}

/** 光の向きと、艶の大きさ。半径に対する割合で持つ。 */
export const SHEEN = { x: -0.34, y: -0.46, rx: 0.34, ry: 0.26, parallax: 0.5 } as const;

/**
 * 目の艶。まぶたが閉じるぶんだけ消える — 閉じた目の上に点が残ると、
 * 光だけが顔から浮く。
 */
export function eyeGlints(params: PebbleParams): ReadonlyArray<{ cx: number; cy: number; opacity: number }> {
  const centers = eyeCenters(params);
  const rise = params.eyeRx * 0.3;
  const fade = (open: number) => Math.max(0, Math.min(1, (open - 2) / 6));
  return [
    { cx: centers.left.x - rise, cy: centers.left.y - rise, opacity: fade(params.upL + params.downL) },
    { cx: centers.right.x - rise, cy: centers.right.y - rise, opacity: fade(params.upR + params.downR) },
  ];
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
