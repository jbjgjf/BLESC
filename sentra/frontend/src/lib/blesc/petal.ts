/**
 * ロゴの花から取り出した幾何。
 *
 * 生徒側のテーマは、飾りを足していったものではなく、この花びら 1 枚と
 * 72 度からすべてを組み立てている。花・五角形・角の丸みはどれも同じ形の
 * 言い換えなので、大きさや色が変わっても仲間に見える。
 *
 * 座標系は 100×100、中心は (50,50)、花びらは上（12 時）を向く。
 */

/** ロゴの花びらを写した輪郭。先はとがり、根元にかけて細くなる。 */
export const PETAL_PATH = "M50 50 C 37 34, 33 17, 50 3 C 67 17, 63 34, 50 50 Z";

export const PETAL_COUNT = 5;

/** 360 / 5。テーマ内の角度はすべてこの倍数か、その半分。 */
export const PETAL_ANGLE = 360 / PETAL_COUNT;

export const BLOOM_CENTER = 50;

/**
 * i 枚目の花びらの配置。scale は中心を動かさずに大きさだけ変える。
 */
export function petalTransform(index: number, scale = 1): string {
  const rotation = index * PETAL_ANGLE;
  if (scale === 1) return `rotate(${rotation} ${BLOOM_CENTER} ${BLOOM_CENTER})`;
  return (
    `rotate(${rotation} ${BLOOM_CENTER} ${BLOOM_CENTER}) ` +
    `translate(${BLOOM_CENTER} ${BLOOM_CENTER}) scale(${scale}) ` +
    `translate(-${BLOOM_CENTER} -${BLOOM_CENTER})`
  );
}

/** 花びらの先端を結ぶ五角形。枠や台紙に使う。 */
export function pentagonPoints(radius = 46, cx = BLOOM_CENTER, cy = BLOOM_CENTER): string {
  return Array.from({ length: PETAL_COUNT }, (_, index) => {
    const radians = ((index * PETAL_ANGLE - 90) * Math.PI) / 180;
    return `${(cx + radius * Math.cos(radians)).toFixed(2)},${(cy + radius * Math.sin(radians)).toFixed(2)}`;
  }).join(" ");
}
