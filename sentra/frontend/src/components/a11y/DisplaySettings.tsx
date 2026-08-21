"use client";

import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui/Icon";
import {
  A11Y_DEFAULTS,
  resetA11y,
  setA11y,
  useA11y,
  type A11ySettings,
} from "@/lib/a11y";
import styles from "./DisplaySettings.module.css";

/**
 * 表示設定のダイアログ。
 *
 * 素の <dialog> を showModal() で開いている。フォーカスの閉じ込め、Esc で
 * 閉じる、閉じたときに元のボタンへ戻る — この 3 つをブラウザ側が正しく
 * やってくれるので、自前で実装するより確実。
 *
 * 選択肢は素の radio。見た目だけ差し替え、キーボード操作（矢印キーでの
 * 移動）と読み上げは標準の挙動をそのまま使う。
 */

type Group<K extends keyof A11ySettings> = {
  key: K;
  title: string;
  hint: string;
  options: Array<{ value: A11ySettings[K]; label: string }>;
};

const GROUPS: Array<Group<keyof A11ySettings>> = [
  {
    key: "text",
    title: "文字の大きさ",
    hint: "画面全体の文字を大きくします。",
    options: [
      { value: "s", label: "小" },
      { value: "m", label: "標準" },
      { value: "l", label: "大" },
      { value: "xl", label: "特大" },
    ],
  } as Group<keyof A11ySettings>,
  {
    key: "line",
    title: "行の間隔",
    hint: "行が詰まって読みにくいときに広げられます。",
    options: [
      { value: "normal", label: "標準" },
      { value: "relaxed", label: "広め" },
    ],
  } as Group<keyof A11ySettings>,
  {
    key: "face",
    title: "書体",
    hint: "端末に入っていれば、読みやすさに配慮したUDフォントを使います。",
    options: [
      { value: "default", label: "標準" },
      { value: "ud", label: "UDフォント" },
    ],
  } as Group<keyof A11ySettings>,
  {
    key: "contrast",
    title: "色の濃さ",
    hint: "文字と背景の差を強くします。",
    options: [
      { value: "normal", label: "標準" },
      { value: "high", label: "高コントラスト" },
    ],
  } as Group<keyof A11ySettings>,
  {
    key: "motion",
    title: "画面の動き",
    hint: "端末側で「視差効果を減らす」を設定している場合は、そちらが優先されます。",
    options: [
      { value: "system", label: "端末の設定にあわせる" },
      { value: "reduced", label: "動きを減らす" },
    ],
  } as Group<keyof A11ySettings>,
];

export function DisplaySettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const settings = useA11y();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /**
   * Esc や背景クリックでブラウザが勝手に閉じたときに、親の open を false へ
   * 戻す。これを怠ると状態が true のまま残り、二度と開かなくなる — Esc で
   * 閉じる人だけが踏む不具合になるので、素のリスナで確実に受ける。
   * （close は bubbling しないイベント。React の onClose でも拾えるが、
   * 委譲に依存しないこちらの形にしている。）
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const syncClosed = () => onClose();
    dialog.addEventListener("close", syncClosed);
    return () => dialog.removeEventListener("close", syncClosed);
  }, [onClose]);

  const isDefault = (Object.keys(A11Y_DEFAULTS) as Array<keyof A11ySettings>).every(
    (key) => settings[key] === A11Y_DEFAULTS[key],
  );

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="bl-display-settings-title"
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className={styles.inner}>
        <div className={styles.head}>
          <h2 id="bl-display-settings-title" className="bl-h2">
            表示設定
          </h2>
          <button type="button" className="bl-icon-btn" onClick={onClose} aria-label="表示設定を閉じる">
            <Icon name="close" size={22} />
          </button>
        </div>

        <p className="bl-meta">
          見えかたを自分に合わせて変えられます。設定はこの端末に保存され、次に開いたときも続きます。
        </p>

        <div className={styles.groups}>
          {GROUPS.map((group) => (
            <fieldset key={group.key} className={styles.group}>
              <legend className={styles.legend}>{group.title}</legend>
              <p className="bl-micro">{group.hint}</p>

              <div className={styles.options}>
                {group.options.map((option) => (
                  <label key={String(option.value)} className={styles.option}>
                    <input
                      type="radio"
                      name={`bl-a11y-${group.key}`}
                      className={styles.radio}
                      value={String(option.value)}
                      checked={settings[group.key] === option.value}
                      onChange={() => setA11y({ [group.key]: option.value } as Partial<A11ySettings>)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>

        <div className={styles.preview} aria-hidden="true">
          <span className="bl-micro">見本</span>
          <p className="bl-body">
            今日は部活の試合でスタメンに出られた。思ったよりうまく動けた一日でした。
          </p>
        </div>

        <div className={styles.foot}>
          <button
            type="button"
            className="bl-btn bl-btn--ghost"
            onClick={resetA11y}
            disabled={isDefault}
          >
            <Icon name="history" size={18} />
            既定に戻す
          </button>
          <button type="button" className="bl-btn bl-btn--primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </dialog>
  );
}
