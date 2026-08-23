/**
 * blesc の「考えている」波。
 *
 * もともと /chat の下部にあったアニメーションを、他の画面でも同じ動きで
 * 使えるように切り出したもの。3枚の帯が異なる速さで流れ、AIが応答を
 * 組み立てている間だけ現れる。
 */

const WAVE_PATHS = [
  "M0,96 C120,64 240,128 360,96 C480,64 600,128 720,96 C840,64 960,128 1080,96 C1200,64 1320,128 1440,96 L1440,200 L0,200 Z",
  "M0,112 C160,80 320,144 480,112 C640,80 800,144 960,112 C1120,80 1280,144 1440,112 L1440,200 L0,200 Z",
  "M0,128 C180,104 360,152 540,128 C720,104 900,152 1080,128 C1260,104 1440,152 1440,128 L1440,200 L0,200 Z",
];

export function WaveBed({
  active,
  height = 160,
  color = "var(--bl-blue)",
}: {
  active: boolean;
  /** px */
  height?: number;
  color?: string;
}) {
  return (
    <div className="bl-waves" data-active={active} style={{ height }} aria-hidden="true">
      {WAVE_PATHS.map((path, index) => (
        <svg
          key={path}
          className={`bl-wave bl-wave--${index + 1}`}
          viewBox="0 0 2880 200"
          preserveAspectRatio="none"
        >
          <path d={path} style={{ fill: color }} />
          <path d={path} style={{ fill: color }} transform="translate(1440 0)" />
        </svg>
      ))}
    </div>
  );
}
