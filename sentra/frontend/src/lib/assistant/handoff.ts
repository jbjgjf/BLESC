/**
 * 案内役から相談ページへ言葉を渡すための置き場。
 *
 * URL に載せない。移動の履歴やサーバーのログに、生徒が打った悩みが
 * そのまま残ってしまう。sessionStorage なら同じタブの中だけで済み、
 * 受け取った側が消す。
 */
export const HANDOFF_KEY = "blesc:assistant:handoff";

/**
 * 預かっている言葉を読む。消さない。
 *
 * 読むと同時に消す作りにしないのは、開発時の StrictMode が state の
 * 初期化関数を 2 回呼ぶため。1 回目で消えると、2 回目は空を返す。
 * 消すのは描画後に clearHandoff で行う。
 */
export function readHandoff(): string {
  try {
    return window.sessionStorage.getItem(HANDOFF_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 受け取ったら消す。相談ページに戻ってきたとき、また現れないように。 */
export function clearHandoff(): void {
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    // 消せなくても害はない。次に案内役が渡すときに上書きされる。
  }
}
