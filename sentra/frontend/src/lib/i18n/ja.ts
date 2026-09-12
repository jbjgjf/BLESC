/**
 * Japanese (`ja-JP`) copy for the product UI.
 *
 * Written to `docs/localization/style_guide.md` and the terms in
 * `docs/localization/glossary.csv`: quiet, plain 敬体; nothing that reads as a
 * diagnosis or a verdict; the same word for the same thing as on the marketing
 * site. Sections follow the screens, and each key says where its text appears.
 *
 * Copy that carries a promise about safety or privacy — the non-diagnostic
 * notice, what an educator can and cannot see, what sharing sends — lives in
 * `common` so it is written once and cannot drift between screens.
 */

export const ja = {
  common: {
    /** Shown wherever a derived signal is displayed. Never soften this. */
    nonDiagnosticNotice:
      "本ツールは診断を行いません。表示されるのは観測された記述とその時刻のみで、リスクの判定ではありません。",
    notClinicalService: "blesc は医療的な評価や緊急時の対応を行うものではありません。",
    loading: "読み込んでいます",
    retry: "もう一度読み込む",
    close: "閉じる",
    back: "戻る",
  },

  /** Full-screen voice conversation, opened from the 相談 tab. */
  voice: {
    dialogLabel: "音声での相談",
    close: "音声での相談を閉じる",
    start: "音声で話しはじめる",
    end: "音声での相談を終える",
    mute: "マイクをオフにする",
    unmute: "マイクをオンにする",
    interrupt: "話すのをやめてもらう",
    hint: "ふだんの話し方で大丈夫です。blesc が聞いて、声で返します。",
    speakerYou: "あなた",
    speakerAssistant: "blesc",
    phase: {
      idle: "タップして話しはじめる",
      connecting: "接続しています…",
      listening: "聞いています",
      thinking: "考えています",
      speaking: "話しています",
      interrupted: "止めました",
      error: "うまくつながりませんでした",
    },
    error: {
      signInRequired: "音声で話すには、ログインしてください。",
      unsupportedBrowser: "このブラウザでは音声を使えません。",
      connectionDropped: "音声の接続が切れました。もう一度お試しください。",
      sessionFailed: "音声を始められませんでした。時間をおいて、もう一度お試しください。",
      sessionFailedWithStatus: (status: number) =>
        `音声を始められませんでした（エラー ${status}）。時間をおいて、もう一度お試しください。`,
      connectionFailedWithStatus: (status: number) =>
        `音声の接続に失敗しました（エラー ${status}）。時間をおいて、もう一度お試しください。`,
    },
  },
  /** Educator surfaces. Wording has to support a decision, not describe one. */
  educator: {
    overview: {
      emptyTitle: "クラスの概要",
      emptyBody:
        "まだ生徒から共有されている情報はありません。学校の管理者が担当として登録し、生徒が「共有の設定」から同意すると、ここに表示されます。",
      tileConsented: "共有に同意した生徒",
      tileActive7d: "この7日間に記録あり",
      tileObservations: "要確認の観測",
      tileObservationsHint: "根拠を提示できるもののみ",
      suppressedHint: "少人数のため非表示",
      // Split around the link so the sentence reads in order; a whole sentence
      // with the link appended would end twice.
      suppressedNoteBefore: (minimum: number) =>
        `${minimum}人未満のクラスでは、集計が特定の生徒を指してしまうため内訳を表示しません。個別の状況は`,
      suppressedNoteLink: "名簿",
      suppressedNoteAfter: "でご確認ください。",
      loadFailed: "クラスの概要を読み込めませんでした。",
    },
    roster: {
      filterAll: (count: number) => `すべて（${count}人）`,
      filterFlagged: "要確認",
      filterInactive: "記録が途切れている",
      emptyNoConsent: "まだ生徒から共有されている情報はありません。",
      emptyNoMatch: "この条件に当てはまる生徒はいません。",
      lastEntry: (date: string) => `最後の記録 ${date}`,
      noEntries: "まだ記録がありません",
      loadFailed: "名簿を読み込めませんでした。",
    },
    student: {
      notShared: "この生徒からは共有されていません（担当の登録と本人の同意が必要です）。",
      backToRoster: "名簿に戻る",
      rosterCrumb: "名簿",
      subtitle: "生徒の状況 · 本人が共有した範囲のみ",
      safetyFlags: "安全に関する記録",
      safetyRouting:
        "危機に関する記録は、学校で定められた担当者へつないでください。手順はアラート画面に記載しています。",
      recentSignals: "最近の観測",
      noEntries: "まだ記録がありません。",
      recurringThemes: "繰り返し見られる話題",
      noThemes: "繰り返し見られる話題はまだありません。",
      themesNote:
        "話題のラベルは記録から抽出したもので、本人の書いた文章そのものではありません。より詳しい内容は、生徒本人が「支援サマリー」から共有を選んだ場合にのみ見られます。教員の側から作成することはできません。",
      accessLogged:
        "この画面を開いたことは記録され、生徒本人も確認できます。共有の同意は、生徒がいつでも取り消せます。",
      loadFailed: "生徒の状況を読み込めませんでした。",
    },
    baseline: {
      learning: "基準値の学習中",
      learningRemaining: (days: number) => `（残り ${days} 日）`,
      learningNote: "この期間は比較を表示しません",
      /** Which history the comparison used. Was the raw `baseline_type` value. */
      source: {
        user: "この生徒自身の記録との比較",
        none: "比較できる記録がまだありません",
      } as Record<string, string>,
    },
  },

  /**
   * Wording for what the deterministic safety layer matched. These describe an
   * observation — what the student wrote, and when — never a classification of
   * the student. See docs/educator_display_policy.md.
   */
  safety: {
    reason: {
      self_harm_or_suicide_risk: "自傷・自殺に関する直接的な表現",
      possible_self_harm_or_suicide_risk: "自傷に関連する表現",
      possible_suicide_risk: "生きることへの否定的な表現",
      ambiguous_withdrawal_signal: "「消えたい」など離脱を示唆する曖昧な表現",
      inability_to_stay_safe: "安全を保てないという表現",
      abuse_or_violence_disclosure: "暴力・虐待の開示",
      imminent_violence_risk: "他害の切迫を示す表現",
      possible_violence_risk: "他害に関連する表現",
      concealment_request_related_to_harm: "危害に関する秘匿の依頼",
      distress_without_explicit_danger: "苦痛の表現（危険の明示なし）",
      risk_disclosed_on_another_surface: "別の画面での開示を引き継ぎ",
    } as Record<string, string>,
    surface: {
      journal: "ジャーナル",
      chat: "チャット",
      voice: "音声",
    } as Record<string, string>,
    /** How urgently the deterministic layer asked for a person to look. */
    level: {
      crisis: "すぐに確認",
      elevated: "確認が必要",
      none: "記録なし",
    } as Record<string, string>,
    attentionChip: "要確認",
    observationPrefix: "観測: ",
    observationBasis: "└ 根拠: safety.py の決定的マッチ / 推論なし",
    flagRecorded: "記録あり",
  },

  /** Counsellor view of the summaries a student chose to share. */
  oversight: {
    eyebrow: "支援担当への引き継ぎ · 生徒が選んで共有",
    title: "共有された支援サマリー",
    intro:
      "どのサマリーを見せるかは生徒本人が選びます。日記やチャットの本文が表示されることはありません。生徒が共有または同意を取り消した時点で、閲覧はできなくなります。",
    empty: "まだ支援サマリーを共有している生徒はいません。",
    listTitle: "担当している生徒",
    sharedOn: (date: string, count: number) => `${date} に共有 · 記録 ${count}件`,
    snapshotShared: (dateTime: string) => `${dateTime} 時点のサマリー · 根拠のIDのみで、本文は含みません`,
    safetyFlags: "このサマリーに含まれる安全に関する記録",
    noStructuredData: "整理された情報はありません。",
    lastEntry: (date: string) => `最後の記録 ${date}`,
    accessLogged: "この画面を開いたことは記録され、生徒本人も確認できます。",
    loadFailed: "共有されたサマリーを読み込めませんでした。",
  },

  /** The student's own view: build a summary, then decide whether to share it. */
  supportSummary: {
    eyebrow: "共有するかどうかは、あなたが決めます",
    title: "支援サマリー",
    intro:
      "最近の記録から、要点だけをまとめたものを作ります。日記の本文は含まれません。作っただけでは誰にも共有されません。",
    generate: "サマリーを作る",
    regenerate: "作り直す",
    previewTitle: "共有する前の確認",
    entryCount: (count: number) => `記録 ${count}件から作成`,
    noDateRange: "対象になる記録がありません",
    copy: "コピーする",
    copied: "コピーしました",
    download: "テキストで保存",
    safetyFlags: "この期間の安全に関する記録",
    noStructuredData: "整理された情報はありません。",
    shareTitle: "このサマリーを共有する",
    shareIntro:
      "共有すると、このサマリーだけが選んだ相手に届きます。日記やチャットの本文が送られることはありません。共有はいつでも「共有の設定」から取り消せます。",
    orgLabel: "共有先の学校・団体",
    orgPlaceholder: "共有先を選ぶ",
    counselorLabel: "共有する相手",
    counselorAll: "この学校・団体の担当者全員",
    share: "共有する",
    shareDone: "共有しました",
    shareConfirmation: "共有しました。取り消しは「共有の設定」から行えます",
    generateFailed: "サマリーを作れませんでした。",
    shareFailed: "共有できませんでした。",
    copyFailed: "コピーできませんでした。「テキストで保存」をお使いください。",
  },

  /**
   * Reviewer-only screens for the synthetic-user evaluation. The audience is a
   * named reviewer rather than a school, but the language stays Japanese so a
   * teacher shown the evidence is not handed an English report.
   */
  evaluation: {
    denied: "評価の結果は、指定されたレビュー担当者のみが閲覧できます。",
    eyebrow: "合成ユーザーによる評価 · 実在の生徒は含みません",
    title: "この状態で学校に出せるか",
    intro:
      "毎回の実行では、合成した生徒が実際の製品を同じログイン・同じ画面で操作し、安全・プライバシー・同意の扱いが基準を満たしているかを確認します。",
    latestRun: (label: string) => `最新の実行 · ${label}`,
    fullReport: "詳しい結果",
    allRuns: "実行の一覧",
    previousRuns: "過去の実行",
    empty: "まだ評価の実行がありません。",
    emptyHowToBefore: "実行するには ",
    emptyHowToMiddle: " で ",
    emptyHowToAfter: " を実行してください。",
    totals: (users: number, scenarios: number, conversations: number) =>
      `合成生徒 ${users}人 · シナリオ ${scenarios}件 · 会話 ${conversations}件`,
    outcomes: (passed: number, failed: number, incomplete: number) =>
      `合格 ${passed} / 不合格 ${failed} / 未完了 ${incomplete}`,
    cost: (actual: string) => `概算費用 約${actual} USD`,
    costEstimated: (estimated: string, actual: string) =>
      `見積 ${estimated} USD · 実績 約${actual} USD`,
    openAiEval: "OpenAI 側の評価:",
    gate: {
      critical_safety_violations: "重大な安全上の違反",
      missed_escalations: "見逃したエスカレーション",
      false_escalations: "過剰なエスカレーション",
      unsupported_inferences: "根拠のない推論",
      privacy_consent_violations: "プライバシー・同意の違反",
      false_escalation_rate: "過剰エスカレーション率",
    } as Record<string, string>,
    verdict: {
      ready: "問題なし",
      needs_attention: "要対応",
      incomplete: "未完了",
      running: "実行中",
    } as Record<string, string>,
    findings: "特に重要な3つの所見",
    recommendedActions: "推奨される対応",
    limitations: "合成テストの限界:",
    artifacts: "成果物",
    recordings: (count: number) => `セッションの記録（${count}件）`,
    failures: (count: number) => `不合格（${count}件）`,
    reviewQueue: (count: number) => `人によるレビュー待ち（${count}件）`,
    trace: "トレース",
    notCaptured: "この実行では記録されていません",
    artifactOpenFailed: (kind: string, reason: string) => `${kind} を開けませんでした: ${reason}`,
    noSignedUrl: "一時URLを取得できませんでした",
    runLabel: (label: string, mode: string) => `${label} · ${mode} の実行`,
    download: "ダウンロード",
    queued: "順番待ち",
    loadFailed: "評価の実行を読み込めませんでした。",
    runNotFound: "この実行は見つからないか、閲覧できません。",
    runLoadFailed: "実行の結果を読み込めませんでした。",
  },

  /** The student's own record of what the AI did with their entry. */
  /**
   * AI処理の記録（`/audit`）。生徒が自分の記録に何が起きたかをたどる画面。
   * 出るのはハッシュと構造化された情報だけで、本文は含まれない — 説明文の
   * その一文は、実装の約束そのものなので弱めない。
   */
  audit: {
    title: "AI処理の記録",
    intro: "AIがどう応答を作ったかを、あとから確認できます。",
    scopeTitle: "処理の内訳をたどれます",
    scopeBody:
      "感情の抽出、安全性の判定、根拠の参照、使用したモデルの情報を確認できます。表示されるのはハッシュと構造化された情報だけで、日記の本文や認証情報は含まれません。",
    filterPlaceholder: "記録のIDで絞り込む（任意）",
    filterLabel: "記録のIDで絞り込む",
    search: "検索",
    reload: "再読み込み",
    loading: "処理履歴を読み込んでいます…",
    emptyFiltered: (filter: string) => `「${filter}」に一致する処理履歴はありません。`,
    empty: "まだ処理履歴がありません。日記を提出すると記録されます。",
    status: {
      completed: "完了",
      suppressed: "表示を抑制",
      failed: "失敗",
      error: "エラー",
    },
    providerModel: "提供元 / モデル",
    promptVersion: "プロンプト版",
    pipeline: "パイプライン",
    temperature: "生成のばらつき（temperature）",
    outputHash: "出力ハッシュ",
    /** `提供元 ・ モデル` のような並記に使う。 */
    inlineSeparator: " ・ ",
    listSeparator: "、",
    safetyDecision: "安全性の判定",
    escalationRequired: " ・ エスカレーションが必要",
    safetyReasons: (reasons: string) => `根拠：${reasons}`,
    safetyPolicies: (refs: string) => `ポリシー：${refs}`,
    evidenceRefs: "根拠の参照",
    errorLine: (message: string) => `エラー：${message}`,
    trailEyebrow: "1件の記録の処理履歴",
    trailSummary: (count: number, date: string) => `${count}件の処理 ・ ${date}`,
    hasSafetyFlag: "安全性の記録あり",
    hasFailure: "失敗あり",
    loadFailed: "処理履歴の読み込みに失敗しました。",
  },

  /** Cards for the recurring topics the recall workspace found. */
  memoryObject: {
    seen: (times: number) => `${times}回`,
    importance: (percent: number) => `重要度 ${percent}%`,
  },

  /**
   * 共有の設定（`/sharing`）。ここの文言は同意の説明そのものなので、
   * 「何が共有され、何が共有されないか」を曖昧にする言い換えをしない。
   * `notShared` に挙げたものは、実装でも実際に送っていないこと。
   */
  sharing: {
    title: "共有の設定",
    intro: "決めるのはあなたです。あなたが「はい」と言うまで、何も共有されません。",
    scopeTitle: "共有されるのは、状態のまとめだけです",
    scopeBodyBefore: "ここに表示される学校や団体は、あなたの",
    scopeBodyEmphasis: "状態のまとめ",
    scopeBodyAfter:
      "（状態の区分・傾向・安全に関する記録）を見ることを申請しています。閲覧はすべて記録され、下の一覧で確認できます。共有はいつでも止められます。",
    notShared: [
      "日記の本文",
      "対話型AIとのやりとりの内容",
      "あなたが「話したくない」を選んだ内容",
    ],
    notSharedSuffix: "は共有されません",
    status: {
      inactive: "申請は無効です",
      active: "共有中",
      revoked: "共有を停止しました",
      pending: "あなたの判断待ち",
    },
    loading: "共有設定を読み込んでいます…",
    emptyTitle: "いまのところ、共有を申請している学校・団体はありません。",
    emptyBody: "学校がblescを使いはじめると、ここに申請が表示されます。",
    grantedSince: (date: string) => `${date}から`,
    stop: "共有を止める",
    grant: "共有を許可する",
    sharedSummariesTitle: "共有した支援サマリー",
    counselorNamed: " · 指定したカウンセラー",
    counselorOrg: " · 所属カウンセラー",
    separator: " · ",
    reflectionCount: (count: number) => `${count}件の記録`,
    stopping: "停止中…",
    stopShare: "共有を停止",
    stopped: "停止済み",
    accessLogTitle: "だれが見たか",
    /** `<org>が<これ>` と続くので、動詞で終わる形にしてある。 */
    viewLabel: {
      roster: "一覧であなたの状態を確認しました",
      alerts: "あなたを含むアラートを確認しました",
      student_overview: "あなたの詳細画面を開きました",
      alert_ack: "あなたに関するアラートを確認済みにしました",
    } as Record<string, string>,
    /** 団体名を <strong> で囲むため、助詞だけを別に持つ。 */
    accessedByParticle: "が",
    loadFailed: "共有設定の読み込みに失敗しました。",
    updateFailed: "共有設定の更新に失敗しました。",
    revokeFailed: "共有を取り消せませんでした。",
  },

  account: {
    /** Written into `participants.display_name`, so an educator reads it. */
    defaultParticipantName: "研究参加者 01",
  },

  /** The 30-turn guided interview, reachable from the account menu. */
  recall: {
    title: "30往復のふりかえり",
    intro:
      "決まった順番で質問していく、診断ではないふりかえりです。やりとりはあなたのデータとして記録され、十分な量がたまると、繰り返し出てくる話題をまとめます。",
    progress: (turns: number, max: number) => `あなたの発言 ${turns}/${max}`,
    notEnoughHistory: (minimum: number) =>
      `まとめるにはやりとりが足りません。${minimum}往復以上でまとめられます。`,
    completed:
      "これで30往復です。下のまとめを読み返して、気になることがあれば、信頼できる大人や専門の相談先に話してみてください。",
    privacy:
      "やりとりはあなたのデータとして保存されます。録音した音声は文字にしたあと破棄します。個人の心の状態に関する内容を、OpenAI の Vector Store に保存することはありません。",
  },

  /** Research view of one submission: what was recorded and what was derived. */
  research: {
    processMetadata:
      "blesc は、入力にかかった時間、書き止まった箇所、書き直し、答えた順番といった、書く過程の情報も記録します。分析の根拠を後から確認できるようにするためです。",
    recorded: "記録しました。",
    submit: "記録する",
    sendMessage: "送信",
    signalLabel: "変化の大きさ",
    notEnoughData: "データ不足",
    notEnoughDataNote: "落ち着いた比較ができるだけの記録がまだありません。",
    signalNote: "ふだんとの違いの大きさで、診断ではありません。振り返るきっかけとしてお使いください。",
    confidence: (percent: string) => `· 確からしさ ${percent}`,
    recallTurns: (available: number, required: number) => `やりとり ${available}/${required}（まとめに必要な数）`,
    snapshotSummary: (count: number) => `${count}日分の記録 · 内容のつながりと日ごとの変化`,
    charCount: (count: number) => `${count}文字`,
    /** Kinds of reflection card the backend produces. */
    cardType: {
      emotion_mirror: "気持ちの言い換え",
      possible_trigger_pattern: "きっかけかもしれないこと",
      support_need: "助けがあるとよいこと",
      small_next_step: "小さな次の一歩",
      reflection_question: "考えてみる問い",
      safety_suppression: "安全のため非表示",
    } as Record<string, string>,
    confidenceLevel: {
      low: "低い",
      medium: "中くらい",
      high: "高い",
    } as Record<string, string>,
  },

  /**
   * The world-model research screen (#151, #152). Read by researchers, not by
   * students, but written in the same language as the rest of the product —
   * and the honesty words here are load-bearing: "候補" rather than "原因",
   * "選択割合" rather than "確率", "算出せず" rather than a zero.
   */
  worldModel: {
    title: "研究エンジン v0（世界モデル）",
    subtitle: "合成データでの予測・説明・独立評価の実行結果",
    syntheticOnlyBanner:
      "この画面が表示するのはすべて合成データの結果です。実在の人物についての推定ではなく、臨床的な判断に使えるものでもありません。",
    runIdLabel: "run id（実行の識別子）",
    runIdPlaceholder: "run-から始まるid",
    load: "読み込む",
    start: "新しいrunを開始する",
    reload: "状態を更新する",
    state: {
      idle: "runを指定していません",
      queued: "順番待ち",
      running: "実行中",
      succeeded: "完了",
      failed: "失敗",
      unknown: "不明な状態",
    } as Record<string, string>,
    stateNote: {
      idle: "run idを入力するか、新しいrunを開始してください。",
      queued: "学習はHTTP要求の中では実行しません。順番が来るまでこの状態です。",
      running: "学習と評価を実行しています。完了するとreportが読めます。",
      succeeded: "評価reportと説明バンドルが揃っています。",
      failed: "このrunは完了しませんでした。理由を確認してください。",
      unknown: "サーバーが未知の状態を返しました。reportは表示しません。",
    } as Record<string, string>,
    notConfigured:
      "研究APIが設定されていません。既定では誰にも開かないため、この画面からは実行できません。",
    unauthorized: "研究権限がありません。",
    notFound: "そのrunは見つかりません。",
    stillRunning: "runがまだ完了していないため、reportはまだありません。",
    loadFailed: "読み込みに失敗しました。",
    sections: {
      overall: "全体の成績",
      byScenario: "シナリオ別",
      unsupported: "算出しなかったmetric",
      leakage: "漏洩・健全性の検査",
      capabilities: "この実行でできたこと",
      explanation: "説明グラフ（候補）",
      timeseries: "1名分の時系列（heldout）",
      usage: "実測した利用量",
      limitations: "この結果の制約",
      artifacts: "artifactのhash",
    },
    table: {
      metric: "指標",
      model: "モデル",
      value: "値",
      interval: "区間",
      status: "状態",
      participants: "参加者数",
      predictions: "予測数",
      scenario: "シナリオ",
      reason: "理由",
      check: "検査",
      detail: "内容",
    },
    notComputed: "算出せず",
    noInterval: "区間なし",
    intervalNote:
      "区間は参加者単位のbootstrapで、統計的検出力の保証ではありません。被覆率は区間幅と併せて読んでください。",
    checkPassed: "通過",
    checkFailed: "不通過",
    capability: {
      trained_encoder: "学習済みencoder",
      trained_dynamics: "学習済み動的モデル",
      calibrated_uncertainty: "較正済みの不確実性",
      model_interventions: "モデル内の操作",
      real_world_causal_effects: "現実の因果効果",
      active_questioning: "適応的な質問選択",
    } as Record<string, string>,
    capabilityOn: "あり",
    capabilityOff: "なし",
    capabilityOffNote: "「なし」の機能はこの画面でも操作できません。",
    semanticStatus: {
      synthetic_axis: "合成データの軸",
      anchored_measure: "測定に対応づけた軸",
      unvalidated_latent: "未検証の潜在軸",
    } as Record<string, string>,
    semanticStatusNote:
      "軸の名前は合成データの観測特徴に対応する座標であり、臨床尺度や病名ではありません。",
    evidenceScope: {
      model_candidate: "モデルが出した候補",
      observed_report: "本人の記述",
      curated_literature: "文献の根拠",
    } as Record<string, string>,
    uncertaintyMethod: {
      bootstrap_frequency: "bootstrap再標本での選択割合",
      participant_bootstrap: "参加者単位のbootstrap",
    } as Record<string, string>,
    edgeColumns: {
      source: "元",
      target: "先",
      order: "次数",
      lag: "遅れ（日）",
      coefficient: "係数",
      frequency: "選択割合",
      scope: "根拠の種類",
    },
    edgeOrder: (order: number) => (order === 1 ? "単独" : `${order}項の積`),
    edgeLag: (days: number) => `${days}日`,
    noEdges: "候補となる関係は見つかりませんでした。",
    residual: "説明しきれていない分",
    residualNote:
      "説明モデルは詳細モデルの振る舞いを完全には再現しません。残差を0として扱わないでください。",
    fidelity: "説明の忠実さ",
    fidelityNote:
      "同じモデル内操作を詳細側と説明側の両方に加えたときの、2つの軌道の平均差です。現実の人への介入効果の正しさではありません。",
    explanationUnavailable: "このrunは説明グラフを生成していません。",
    timeseriesNote:
      "実線はcutoffまでの観測、点はcutoff後の実測、破線が予測です。1名分の抜粋であり、成績はreportの数値で読んでください。",
    timeseriesLegend: {
      observed: "観測",
      actual: "cutoff後の実測",
      forecast: "予測（記憶モデル）",
      baseline: "予測（持続値）",
    },
    featureLabel: (name: string) => `特徴 ${name}`,
    noPreview: "時系列の抜粋がありません。",
    usageLabels: {
      provider_calls: "外部API呼び出し",
      input_tokens: "入力トークン",
      output_tokens: "出力トークン",
      elapsed_seconds: "所要秒数",
      compute_environment: "実行環境",
    } as Record<string, string>,
    usageZeroNote: "0は「呼び出さなかった」という実測であり、未計測（—）とは違います。",
    unmeasured: "—",
    reproduce: "再現コマンド",
    seeds: "seed（乱数の種）",
    seedNote: "seedは再現性の初期点検であり、統計的検出力の保証ではありません。",
  },

  /** The 3D relation graph and the panels beside it. */

  /**
   * 変化のタイムライン。値は本人自身のふだんの状態との比較で、他人との比較でも
   * 判定でもない — 見出しから注記まで、その一点を崩さない言い回しにしている。
   */
  timeline: {
    title: "変化のタイムライン",
    intro:
      "その人自身のふだんの状態と比べて、どれくらい変化があったかを日ごとに表しています。",
    empty: "グラフを作るにはまだ記録が足りません。日記を続けると表示されます。",
    /** 直近の値に添える一言。「高い/低い」ではなく、確認を促すかどうかだけを言う。 */
    statusReview: "確認をおすすめします",
    statusUsual: "ふだんの範囲です",
    statusLearning: "ふだんの状態を学習中です",
    latestLabel: "直近の値",
    noValue: "—",
    daysAboveThreshold: (threshold: string) => `目安の ${threshold} を超えた日`,
    dayUnit: "日",
    breakdownLink: "内訳を見る",
    breakdownHint: "何がこの値につながったか",
    chartTitle: "日ごとの変化",
    thresholdLabel: "確認の目安",
    seriesName: "変化の大きさ",
    disclaimer: "この値は日記の書き方の変化をまとめたものです。診断ではありません。",
    loadFailed: "タイムラインの読み込みに失敗しました。",
  },


  /**
   * 保護者の画面。ここに置く文言は、そのまま「保護者に何を見せないか」の
   * 約束になる — 本文・対話・分析結果・支援の検討状況は表示しない。文言を
   * 変えるときは、画面の実装も同じだけ変わっているか確かめること。
   */
  guardian: {
    title: (studentName: string) => `${studentName}さんの記録`,
    submissionTitle: "日記の提出状況",
    statStreak: "連続提出日数",
    statWeek: "今週の提出",
    statMonthRate: "今月の提出率",
    lastSubmitted: (relative: string) => `最終提出：${relative}`,
    moodTitle: "気分の記録",
    moodConsented: "本人が共有に同意",
    moodDisclaimer:
      "これは本人が選んだ「その日の気分」の記録です。心理的な評価や診断ではありません。",
    noticesTitle: "学校からのお知らせ",
    hiddenTitle: "表示していない情報",
    hiddenIntro:
      "お子さまが安心して記録を続けられるよう、次の情報は保護者の方には表示していません。",
    hidden: [
      "日記の本文",
      "対話型AIとのやりとりの内容",
      "AIによる分析結果や状態の判定",
      "学校内での支援の検討状況",
    ],
    hiddenFooter:
      "気になることがあるときは、担任またはスクールカウンセラーにご相談ください。",
  },


  /**
   * 押して話す入力ボタン。全画面の音声モード（`voice`）とは別物で、こちらは
   * 日記やチャットの入力欄に文字を入れるための短い録音。
   *
   * `error.*` は HTTP のステータスから引く。原文の英語をそのまま出すと、生徒が
   * 直せることなのか、こちらの不具合なのかが読み取れないため、原因ごとに
   * 分けている。
   */
  voiceInput: {
    labelIdle: "音声で入力",
    labelRecording: "聞いています",
    labelTranscribing: "文字にしています",
    labelPermission: "マイクを許可してください",
    labelReady: "入力しました",
    labelError: "音声入力に失敗",
    titleStop: "録音を止める",
    ariaStart: "音声入力を始める",
    ariaStop: "音声入力を止める",
    error: {
      generic: "音声入力に失敗しました。",
      notConfigured: "サーバー側で音声の文字起こしが設定されていません。",
      auth: "音声の文字起こしの認証に失敗しました。",
      rateLimited: "音声の文字起こしが混み合っています。少し待ってからお試しください。",
      unsupportedFormat: "このブラウザで録音した形式には対応していません。",
      /** 原文が英語のまま届いたときの頭だけを差し替える。 */
      transcriptionFailed: "文字起こしに失敗",
      noRecorder: "このブラウザは音声の録音に対応していません。",
      recordingFailed: "録音に失敗しました。",
      emptyRecording: "音声が録音されませんでした。",
      permissionDenied: "マイクの使用が許可されませんでした。",
    },
  },


  /**
   * 今日の画面（`/`）。生徒がアプリを開いて最初に読むところなので、催促に
   * ならない言い方を選ぶ — 「まだです」であって「未提出です」ではない。
   *
   * `greeting.*` は端末の時計から引く。サーバー描画とハイドレーションでは
   * 時刻が読めないので `neutral` を出す。
   */
  home: {
    greeting: {
      morning: "おはよう",
      afternoon: "こんにちは",
      evening: "こんばんは",
      /** 時計が読めない間（サーバー描画・ハイドレーション）に出す。 */
      neutral: "こんにちは",
    },
    greetingWithName: (greeting: string, firstName: string) =>
      `${greeting}、${firstName}さん`,
    todayDoneTitle: "今日の日記は提出済みです",
    todayPendingTitle: "今日の日記はまだです",
    todayLoading: "提出状況を読み込んでいます…",
    todayDoneBody: "今日の記録は安全に保存されています。",
    todayDoneBodyDated: (date: string) => `${date}の記録を保存しました。`,
    todayPendingBody: "今日の気分と出来事を、1問ずつ記録できます。",
    todayPendingBodyShort: "今日の気分と出来事を、1分ほどで記録できます。",
    writeAgain: "もう一度記録する",
    write: "日記を書く",
    viewEntry: "内容を見る",
    recentCount: "過去30日の記録",
    noValue: "—",
    timelineLink: "変化のタイムライン",
    chatLink: "blescに相談する",
    chatHint: "気持ちの整理を手伝います。話したくないことは話さなくて大丈夫です。",
    reflectLink: "自分の振り返り",
    reflectHint: "これまでの気分の移り変わりと、よく書いている出来事を見られます。",
    statStreak: "連続提出日数",
    statWeek: "今週の提出",
    statMonthRate: "今月の提出率",
    dayTitle: (date: string, mood: string) => `${date} ${mood}`,
    dayTitleMissing: (date: string) => `${date} 未提出`,
    lastSubmitted: (relative: string) => `最終提出：${relative}`,
    recentTitle: "最近の日記",
    emptyBody: "（本文なし）",
    seeAll: "すべて見る",
    loadFailed: "記録の読み込みに失敗しました。",
  },


  /**
   * 相談（`/chat`）。生徒が自分から書きはじめられないときのために、最初の
   * 一言を3つ置いている。どれも「困っている」と認めなくても押せる言い方に
   * してある。
   */
  chat: {
    starters: [
      "今日あったことを話したい",
      "最近ちょっとしんどい",
      "考えを整理したい",
    ],
    /** 応答が空で返ったときの埋め草。無言よりは何かが返ったほうがよい。 */
    emptyAnswer: "…",
    sendFailed: "うまく送信できませんでした。",
    retry: "もう一度試す",
    thinking: "blescが考えています",
    placeholder: "blescに話す…",
    send: "送信",
  },


  /**
   * 変化の内訳（`/insights`）。タイムラインの1つの値を、何がその値にした
   * のかまで開く画面。`signal.*` がルール名と根拠文を持ち、ここは器の側の
   * 見出しだけを持つ。
   */
  insights: {
    title: "変化の内訳",
    intro: "タイムラインの値が、どんな要素から出てきたのかを分解して見られます。",
    empty: "まだ内訳を出せる記録がありません。日記を提出すると表示されます。",
    scoreLabel: "変化の大きさ",
    noValue: "—",
    scoreNote:
      "ルールの反応、ふだんとの差、日ごとの移り変わりをまとめた値です。診断ではありません。",
    deviationTitle: "ふだんとの差",
    deviationEmpty: "差を出せる項目がありません。",
    rulesTitle: "反応したルール",
    rulesEmpty: "反応したルールはありません。",
    relationChangeTitle: "関係の変化",
    relationChangeEmpty: "関係の変化は検出されていません。",
    supportTitle: "支えの変化と不確かさ",
    relationsTitle: "主な関係",
    relationsEmpty: "表示できる関係がありません。",
    disclaimer:
      "ここに出る値と根拠は、教員や本人が状況を確認するための材料です。診断ではありません。",
    loadFailed: "内訳の読み込みに失敗しました。",
  },


  /**
   * ログイン（`/login`）。生徒も教員も同じ画面から入る。
   *
   * `error.*` は Supabase が返す英語のメッセージを引き当てて置き換えるもの。
   * 原文をそのまま出すと、入力を直せばよいのか、こちらの不具合なのかが
   * 読み取れない。当てはまらないものは原文のまま出す — 訳せないものを
   * 「エラーが発生しました」に潰すと、問い合わせる手がかりまで消える。
   */
  login: {
    signinLead: "ログインしてはじめる",
    signupLead: "アカウントを作成する",
    email: "メールアドレス",
    password: "パスワード",
    passwordHint: "6文字以上",
    signin: "ログイン",
    signup: "アカウントを作成",
    toSignup: "アカウントをお持ちでない方はこちら",
    toSignin: "すでにアカウントをお持ちの方はこちら",
    /** `common.notClinicalService` と同じ約束の、このカードに収まる短い形。 */
    notClinicalService: "blescは診断や緊急対応を行うものではありません。",
    confirmationSent:
      "確認メールを送りました。メール内のリンクを開いたあと、ログインしてください。",
    error: {
      invalidCredentials: "メールアドレスまたはパスワードが正しくありません。",
      emailNotConfirmed:
        "メールアドレスの確認が完了していません。届いたメールのリンクを開いてください。",
      alreadyRegistered:
        "このメールアドレスはすでに登録されています。ログインを選んでください。",
      passwordTooShort: "パスワードは6文字以上で入力してください。",
      rateLimited: "試行回数が多すぎます。しばらく待ってからもう一度お試しください。",
      network: "通信に失敗しました。接続を確認してもう一度お試しください。",
    },
  },


  /**
   * 日記（`/journal`）。入力は1問ずつで、どの設問にも「話したくない」に
   * あたる選択肢がある — 答えないことを選べるのは仕様であって、抜け道では
   * ない。文言を足すときも同じ逃げ道を残すこと。
   *
   * `probe.*` の文面は、回答と一緒に `probe_id` と台本の version を保存して
   * いる（#133）。文面を変えるときは version も上げること。上げないと、
   * 保存済みの回答がどの問いに対するものか後から分からなくなる。
   */
  journal: {
    stepTitle: {
      recall: "まず思い浮かぶこと",
      mood: "今日の気分",
      events: "今日あった出来事",
      note: "今日のこと",
    },
    progressLabel: "入力の進み具合",
    required: "必須",
    optional: "任意",
    recallPrompt: "30秒くらい、考え込まずに最初に浮かんだことをそのまま書いてください。",
    moodHint: "いちばん近いものをひとつ選んでください。",
    moodRequired: "今日の気分を選んでください。",
    recallPlaceholder: "いま頭に浮かんでいること",
    recallHint: "正解はありません。書かずに次へ進んでも大丈夫です。",
    eventsHint: "あてはまるものをすべて選べます。",
    eventsRequired: "出来事を1つ以上選んでください。",
    noteHint:
      "あったこと、印象に残ったこと、悩んでいること — 書きたいことだけ、自由に書いてください。",
    notePlaceholder: "どんな一日でしたか",
    noteHintOptional: "書きたくないことは、書かなくて大丈夫です。",
    privacyNote: "日記は先生に全文が見えるわけではありません。",
    back: "戻る",
    next: "次へ",
    submitting: "保存中…",
    submit: "日記を提出する",
    submitEmpty: "書かずに提出する",
    retrySave: "もう一度保存する",

    /** 保存した本文の組み立て。ラベルは保存先にも残る。 */
    moodUnselected: "未選択",
    categorySeparator: "、",
    lineMood: (label: string) => `気分: ${label}`,
    lineEvents: (labels: string) => `出来事: ${labels}`,
    lineBody: (body: string) => `日記: ${body}`,
    bodyEmpty: "本文なし",

    saveFailed: "日記を保存できませんでした。もう一度お試しください。",
    saveFailedKept:
      "日記を保存できませんでした。書いた内容は画面に残っています。もう一度お試しください。",
    saveFailedWithReason: (reason: string) => `日記を保存できませんでした（${reason}）`,
    saveFailedShort: "日記を保存できませんでした。",

    probe: {
      topic: {
        question: "特に気になった出来事はありましたか。",
        choices: [
          "勉強や課題",
          "友人関係",
          "部活動",
          "家庭",
          "体調や睡眠",
          "まだ整理できない",
          "話したくない",
        ],
      },
      detail: {
        question: "どのようなことがありましたか。話せる範囲で記録してください。",
        placeholder: "書ける範囲で大丈夫です",
      },
      duration: {
        question:
          "そのように感じる出来事は今日だけでしたか。それとも最近も続いていますか。",
        choices: [
          "今日だけ",
          "数日前から続いている",
          "以前から続いている",
          "分からない",
          "答えたくない",
        ],
      },
      /** これ以上聞かずに終える回答。上の選択肢と同じ文字列であること。 */
      stopAnswers: ["話したくない", "まだ整理できない", "答えたくない"],
      acknowledged: "わかりました。話したくなったら、いつでも聞かせてください。",
      decline: "答えたくない",
      send: "送信",
      thinking: "blescが考えています",
      end: "ここで終える",
    },

    doneTitle: "今日の日記を記録しました",
    home: "ホームに戻る",
    talkMore: "もう少し話す",
  },


  /**
   * 自分の振り返り（`/reflect`）。生徒が自分の記録を見返す画面で、教員には
   * 出さない。続けられていないことを責める言い方をしない — 「無理のない
   * ペースで大丈夫です」はその方針そのもの。
   */
  reflect: {
    title: "自分の振り返り",
    intro: (days: number) => `これまでに記録した${days}日分をまとめています。`,
    moodTrendTitle: "気分の移り変わり",
    moodBreakdownTitle: "気分の内訳",
    moodBreakdownNote: "花びらは5つの気分です。多く記録した気分ほど大きく開きます。",
    eventsTitle: "よく書いている出来事",
    streakTitle: (days: number) => `${days}日つづけて記録しています`,
    streakNote: (rate: number) =>
      `今月の提出率は ${rate}% です。無理のないペースで大丈夫です。`,
    pastEntriesTitle: "過去の日記",
    fieldNote: "今日のこと",
    fieldEmpty: "記録なし",
  },


  /**
   * デモ用の教員画面（`/educator/alerts`, `/educator/class`, `/educator/meetings`,
   * `/school`）。企画書の各機能を通しで見せるための固定データ画面で、通常の
   * ナビゲーションには出ない（`AppNav` の `DEMO_ONLY_NAV_PATHS`）。
   *
   * `/educator/class` は生徒ごとのリスクバンドを色で描いていた（#175）。
   * バンドと傾向判定（悪化傾向／改善傾向）は削除し、観測・時刻・入力元・根拠を
   * 出す形に作り直してある。`docs/educator_display_policy.md` の規則1〜3。
   * 生徒の状態を段階や方向で言い表す語を、ここに足さないこと。
   * `tests/educator-display-policy.test.mjs` がその語彙を走査している。
   */
  educatorDemo: {
    alerts: {
      title: "アラート",
      intro: "確認のきっかけとして使ってください。アラートだけで状態を判断しないでください。",
      count: (n: number) => `${n}件`,
      urgentTitle: "優先度の高いアラート",
      urgentEmpty: "優先度の高いアラートはありません。",
      attention: "要確認",
      flowTitle: "対応の流れ",
      flow: [
        "担当教員または指定された支援担当者に通知",
        "学校の定める緊急対応フローに沿って状況を確認",
        "必要に応じて保健室・スクールカウンセラー・管理職・保護者と連携",
      ],
      viewDetail: "詳細を確認",
      acknowledge: "確認しました",
      acknowledged: "確認済み",
      acknowledgeShort: "確認",
      missingTitle: "日記の未提出",
      missingNote:
        "未提出は体調・行事・端末の不調など様々な理由で起こります。声掛けのきっかけとしてお使いください。",
      kind: {
        missing_3d: "3日以上未提出",
        unused_1w: "1週間未利用",
        streak_broken: "連続提出が中断",
        rate_drop: "提出頻度が低下",
      },
      overdueTitle: "フォロー漏れ",
      overdueEmpty: "フォロー漏れはありません。",
      overdueNote: (days: number, next: string) =>
        `前回面談から${days}日、次回は${next}です。`,
      notScheduled: "未設定",
      scheduleMeeting: "面談を設定",
    },
    class: {
      title: "クラス全体",
      subtitle: (className: string, count: number) => `${className} ・ ${count}名`,
      observationsTitle: "観測された記述",
      orderedByTime: "新しい順",
      observationsEmpty: "観測された記述はありません。",
      surface: {
        diary: "日記",
        followup: "対話",
      },
      reasonsLabel: "観測の根拠",
      provenance: "決定的な語句のマッチによる観測です。AIによる状態の推論は含みません。",
      observationsNote:
        "表示されるのは、観測された記述とその時刻・根拠だけです。生徒の状態の判定・ランク付けは行いません。根拠を辿れない観測は表示しません。",
      rosterTitle: "名簿",
      orderedByLastEntry: "最終提出の新しい順",
      lastEntry: (date: string, relative: string) => `${date}（${relative}）`,
      noEntry: "記録なし",
      rosterNote:
        "並びは最終提出の時刻順です。生徒の状態による並び替え・色分けは行いません。",
      missedDays: (days: number) => `${days}日未提出`,
      submittedYesterday: "昨日までに日記を提出",
      withFollowUp: "対話型AIによる補足あり",
      inProgress: "対応が進行中",
      personUnit: "名",
      breakdownTitle: "クラス全体の傾向",
      breakdownIntro:
        "日記と対話の内容から、いま何についての記述が多いかを集計しています。",
      deltaNote: "右端の数値は先週との差（ポイント）です。",
      noChange: "±0",
      hintsTitle: "学級運営のヒント",
      hints: [
        "学業ストレスに関する記述が先週より5ポイント増えています。課題量の偏りを確認してみてください。",
        "睡眠に関する記述が増加傾向です。保健だよりや朝の声掛けと合わせて確認できます。",
        "人間関係に関する記述はやや減少しています。",
      ],
    },
    meetings: {
      title: "面談",
      intro: "面談の記録と、AIによる面談サポートをまとめています。",
      recordTitle: "面談を記録する",
      student: "生徒",
      required: "必須",
      optional: "任意",
      selectPlaceholder: "選択してください",
      studentOption: (name: string, grade: string, className: string) =>
        `${name}（${grade}${className}）`,
      supportTitle: "AIによる面談サポート",
      supportHint: (name: string) =>
        `${name}さんの記録から、面談で確認したい質問案を用意できます。`,
      makeQuestions: "質問案を作る",
      supportHeading: (name: string) => `面談サポート — ${name}`,
      close: "閉じる",
      loadingRecords: "記録を読み込んでいます…",
      questionsLabel: "確認したい質問案",
      contextLabel: "面談前に押さえておきたい背景",
      cautionsLabel: "触れ方に注意したい点",
      notes: "面談メモ",
      notesPlaceholder: "話した内容を記録します",
      impression: "生徒の様子",
      impressionPlaceholder: "表情、話し方、沈黙の有無など",
      nextAction: "次回対応予定",
      nextNote: "次回の内容",
      nextNotePlaceholder: "例：生活リズムの変化を確認",
      summaryTitle: "面談内容の要約",
      summarising: "作成中…",
      summarise: "AIに要約してもらう",
      summaryPending: "要約を作成しています",
      /** 要約は入力から組み立てる定型文。実際のモデル出力ではない。 */
      summaryWithNotes: "面談では、記録された内容をもとに本人の状況を確認しました。",
      summaryWithoutNotes: "面談メモが未入力のため、要約は限定的です。",
      summaryImpression: (impression: string) =>
        `生徒の様子として「${impression}」が記録されています。`,
      summaryNextAction: (date: string) => `次回対応は ${date} に予定されています。`,
      summaryNoNextAction:
        "次回対応は未設定です。フォロー漏れを防ぐため日程の設定をおすすめします。",
      visibility: "面談記録は担当教員と支援担当者が閲覧できます。",
      save: "記録を保存",
      saved: "面談記録を保存しました。（デモのため実際には保存されません）",
      historyTitle: "これまでの面談",
      followUp: {
        overdue: "フォロー未実施",
        done: "対応済み",
        ongoing: "フォロー中",
      },
      nextLine: (date: string, note: string) => `次回 ${date} ｜ ${note}`,
    },
    school: {
      wholeSchool: "学校全体",
      byGrade: "学年別",
      suppressionNote: (minCellSize: number) =>
        `個人を特定しない集計のみを表示しています。集計対象が${minCellSize}名未満になる区分は、個人が推定されうるため値を伏せています。個別の生徒の状態はこの画面からは確認できません。`,
      noChange: "±0",
      theme: {
        academic: "学業",
        relationships: "人間関係",
        health: "睡眠",
      },
      shareTitle: (theme: string, percent: number) => `${theme} ${percent}%`,
      title: "学校全体の傾向",
      studentCount: "対象生徒数",
      submissionRate: "日記の提出率（今月）",
      gradeCount: "集計対象",
      gradeUnit: "学年",
      breakdownTitle: "記述されている内容の内訳",
      trendTitle: "6週間の推移",
      tableGrade: "学年",
      tableSubmissionRate: "提出率",
      tableTopTheme: "最も多い記述",
      studentCountValue: (count: number) => `${count}名`,
      /** 母数が小さい区分は値を伏せる。伏せた理由まで書く。 */
      suppressed: "—（母数が小さいため非表示）",
      suppressedShort: "—",
      disclaimer:
        "この集計は学校全体の傾向把握を目的としたものです。個人の状態を示すものではなく、診断でもありません。",
    },
  },

  graph: {
    /** The five ontology categories, keyed by the stored enum value. */
    category: {
      State: "気持ち",
      Trigger: "きっかけ",
      Behavior: "行動",
      Event: "出来事",
      Protective: "支え",
    } as Record<string, string>,
    view: (title: string) => `表示: ${title}`,
    counts: (nodes: number, links: number) => `内容 ${nodes}件 · 関係 ${links}件`,
    /**
     * 図の配置は見やすさのためのもので、位置や距離に意味はない、という注記。
     * 実機の表示QAで、英語のまま残っているのが見つかった（#116）。
     */
    layoutNotice: "配置は見やすさのためのものです。判定ではありません。",
    clearFocus: "全体に戻す",
    emptyCanvas: "表示できる内容がありません。絞り込みを外すか、日記を書くと表示されます。",
    inspectorTitle: "選んだ内容の詳細",
    inspectorCategory: (category: string) => `種類: ${category}`,
    inspectorIntensity: (value: string) => `強さ: ${value}`,
    inspectorConfidence: (value: string) => `確からしさ: ${value}`,
    inspectorFrequency: (times: number, days: number) => `出てきた回数: ${times}回 / ${days}日`,
    appearanceHistory: (count: number) => `出てきた日（${count}日）`,
    span: (from: string, to: string) => `期間: ${from} → ${to}`,
    snapshots: (count: number) => `記録した日数: ${count}`,
    source: (source: string) => `データの出どころ: ${source}`,
    sourceFallback: "表示確認用のサンプル",
    sourceLive: "実際の記録",
    edgeSemanticsTitle: "矢印と色の意味",
    edgeArrow: "矢印",
    edgeArrowBody: "は、関係の向き（元 → 先）を表します。",
    edgeColor: "色",
    edgeColorBody: "は関係の種類（引き起こす・強める・和らげる・避ける・同時に起きる・先に起きる）を表します。",
    edgeWidth: "太さ",
    edgeWidthBody: "は、日ごとの表示では確からしさ、まとめた表示では出てきた回数を表します。",
    pipelineTitle: "この図のつくり方",
    pipelineStep1: "1. 取り出す",
    pipelineStep1Body: "書かれた文章から、内容と関係の候補を取り出します。",
    pipelineStep2: "2. 確かめる",
    pipelineStep2Body: "BLESC のオントロジーの規則に合っているかを確かめます。",
    pipelineStep3: "3. 保存する",
    pipelineStep3Body: "日付と使ったモデルの情報とともに、その日の記録として保存します。",
    pipelineStep4: "4. 図にする",
    pipelineStep4Body: "つながりの構造を図として並べます。",
    /** Why a node is worth looking at. Phrased as observation, not verdict. */
    role: {
      recurring: (times: number, days: number) => `${days}日のあいだに${times}回出てきています`,
      highSalience: "この日のまとめで中心になっている内容です",
      keyRelation: "説明に使われた関係に関わっています",
      added: "比較のもとになる日にはなかった内容です",
      removed: "比較のもとになる日にはあった内容です",
      relationShifted: "比較のもとになる日から関係が変わっています",
      event: "時間の流れをつくっている出来事です",
      structural: "図の構造をつくっている内容です",
      // The stored value is untyped JSON, so it arrives as whatever was written.
      protectiveDecline: (count: unknown) => `支えになる内容が ${String(count)}件 減っています`,
      noRuleTrigger: "この内容に直接ひもづく判定はありません",
      conceptSummary: (category: string, times: number, lastDay: string) =>
        `${category} · ${times}回 · 最後は ${lastDay}`,
      nodeSummary: (category: string, day: string) => `${category} · ${day} の記録`,
    },
    /** Two nodes shown when there is nothing to draw, for layout checking. */
    fallback: {
      stableState: "落ち着いた気持ち",
      eveningWalk: "夕方の散歩",
    },
  },

  /**
   * The deterministic rules behind the reflection signal, and what to say while
   * there is not yet enough of a student's own history to compare against.
   */
  signal: {
    ruleName: {
      isolation_spike: "人とのつながりの記述が減った",
      protective_decline: "支えになる記述が減った",
      state_trigger_inflation: "気持ち・きっかけの記述が増えた",
      event_sequence_shift: "出来事の並びが変わった",
      relation_reweighting: "関係のつながり方が変わった",
    } as Record<string, string>,
    ruleEvidence: {
      isolation_spike:
        "人とのつながりについての記述が、ふだんより少なくなっています。支えに関するつながりも減っています。",
      protective_decline:
        "支えになる記述が、ふだんより少なくなっています。支えの割合も下がっています。",
      state_trigger_inflation:
        "つらさに関する気持ちや、そのきっかけについての記述が、ふだんより増えています。",
      event_sequence_shift:
        "出来事は書かれていますが、その並び方がふだんと違っています。",
      relation_reweighting:
        "いくつかの主要なつながりについて、確からしさや向きがこれまでと変わっています。",
    } as Record<string, string>,
    rampUp: (remaining: number, rampUpDays: number, observed: number) =>
      `あなたの記録の傾向を学習しています。あと ${remaining} 日分の記録で比較できるようになります。` +
      `比較は、あなた自身の直前 ${rampUpDays} 日分と行うもので、いまは ${observed} 日分が記録されています。` +
      `記録はその間も分析していますが、比べる相手がまだない状態です。`,
    notEnoughDataReason: (requiredDays: number) =>
      `この生徒自身の記録が ${requiredDays} 日分そろうまで、変化の大きさは出しません。`,
    observedDays: (observedDays: number) => `いま記録されているのは ${observedDays} 日分です。`,
    lookupFailed: "履歴の読み込みに失敗したため、上の日数は最低限の数であり、正確な数ではありません。",
    windowTruncated: "履歴が件数の上限で打ち切られたため、上の日数は最低限の数です。",
    noBaselineYet: "比較できるだけの記録がまだないため、変化の大きさは出していません。",
    missingPersonalBaseline: "この生徒自身の記録にもとづく基準",
    coverageAdequate: "その日の記述量は十分です",
    coverageSparse: "その日の記述量が少なめです",
    comparedWithPrevious: "直前の記録と比較しています",
    noPreviousGraph: "比較できる直前の記録がありません",
    degenerateFeatures: (features: string) => `期間を通して変化がなかった項目: ${features}`,
    nodesAdded: (count: number) => `内容が ${count}件 増えました`,
    relationsAdded: (count: number) => `関係が ${count}件 増えました`,
  },

  /**
   * The deterministic extraction used when the model is unavailable, and the
   * structural diff between two days. Both are stored and can be rendered, so
   * they are written for a student rather than for a log.
   */
  extraction: {
    fallbackNode: {
      currentReflection: "いまの気持ち",
      writtenJournal: "日記を書いた",
      firstRecall: "最初に思い出したこと",
      protectiveSignal: "支えになりそうなこと",
      stressSignal: "負担になりそうなこと",
      contextSignal: (index: number) => `そのほかの記述 ${index}`,
    },
    temporalSummary: "1回の記録と、最初に思い出したことから作成",
    summary: (nodeCount: number) => `日記と最初の想起から ${nodeCount}件の内容を取り出しました。`,
    evidence: "日記と、最初に思い出したことの記録が提出されました。",
    firstSnapshot: "この参加者にとって最初の記録のため、比較できる前日がありません",
    shift: (added: number, removed: number, relationsAdded: number, relationsRemoved: number, changed: number) =>
      `内容 +${added} / -${removed}、関係 +${relationsAdded} / -${relationsRemoved}、変化した関係 ${changed}`,
  },

  /**
   * What a failed request says. The technical detail from Supabase or the
   * route handler is appended after these, so the first sentence a teacher
   * reads is in their own language even when the cause is not translatable.
   */
  apiError: {
    notAuthenticated: "ログインが必要です",
    requestFailed: "通信に失敗しました",
    requestTimedOut: (seconds: number) => `応答がありませんでした（${seconds}秒）`,
    transcriptionFailed: "音声を文字にできませんでした",
    unknownOrganization: "名称未設定の学校・団体",
    loadParticipant: "参加者情報を読み込めませんでした",
    loadEntries: "記録を読み込めませんでした",
    loadConversationRecall: "会話のまとめを読み込めませんでした",
    loadTimeline: "タイムラインを読み込めませんでした",
    generateSupportSummary: "支援サマリーを作成できませんでした",
    loadOversightRequests: "共有先の一覧を読み込めませんでした",
    loadOversightConsents: "共有の同意状況を読み込めませんでした",
    loadConsent: "同意の状態を読み込めませんでした",
    grantConsent: "共有に同意できませんでした",
    revokeConsent: "共有の同意を取り消せませんでした",
    loadCohortRoster: "名簿を読み込めませんでした",
    loadCohortInsights: "クラスの記録を読み込めませんでした",
    loadCohortSafety: "安全に関する記録を読み込めませんでした",
    loadAlertAcknowledgements: "確認済みのアラートを読み込めませんでした",
    loadStudentSignals: "生徒の記録を読み込めませんでした",
    loadStudentSafety: "生徒の安全に関する記録を読み込めませんでした",
    loadEducatorAccessLog: "閲覧の記録を読み込めませんでした",
    loadCounselors: "担当者の一覧を読み込めませんでした",
    shareSummary: "サマリーを共有できませんでした",
    loadSummaryShares: "共有の状況を読み込めませんでした",
    revokeSummaryShare: "共有を取り消せませんでした",
    loadSharedSummaries: "共有されたサマリーを読み込めませんでした",
    loadAuditTrails: "AI処理の記録を読み込めませんでした",
    loadExplanation: "分析の内訳を読み込めませんでした",
    loadAnomaly: "変化の大きさを読み込めませんでした",
    loadGraphSnapshots: "関係グラフを読み込めませんでした",
  },

  /** Educator alerts. Each says what was observed, never what it means. */
  alert: {
    safetyCrisis: "直近の記録に、すぐに確認したい表現があります。",
    safetyElevated: "直近の記録に、確認したほうがよい表現があります。",
    anomalySpike: (score: string, threshold: string) =>
      `変化の大きさが ${score} で、確認の目安（${threshold}）を超えています。`,
    noEntriesYet: "まだ記録がありません。",
    noEntriesLast7Days: "この7日間、記録がありません。",
  },

  /**
   * The guided demo (#17). Written for whoever is standing at the front of the
   * room: what to open, in what order, and what each screen is meant to show.
   */
  demo: {
    eyebrow: "デモ",
    title: "5つの画面で一通り見る",
    intro:
      "ログインも API キーも要りません。この画面から順に開くと、生徒が書いてから、教員が気づき、生徒が共有を決めるところまでを5分ほどで通せます。",
    liveWarning:
      "表示されているのはすべて固定のデモデータです。実在の生徒ではありません。画面右下に「デモデータ」の表示が出ている間は、サーバーには何も送られていません。",
    notEnabled: "いまはデモモードではありません。",
    howToEnable:
      "URL の末尾に ?demo=1 を付けると、このタブだけがデモモードになります。開発中（next dev）は既定で有効です。",
    stepLabel: (index: number) => `ステップ ${index}`,
    steps: [
      {
        title: "生徒が記録する",
        body: "今日の記録と、これまでの続き具合。ここから日記を1問ずつ書けます。",
        watchFor: "入力は1画面1問。必須の設問以外は「書かずに提出する」を選べます。",
      },
      {
        title: "繰り返しに気づく",
        body: "21日分の気分の移り変わりと、よく出てくる話題。",
        watchFor: "「ある日の出来事」ではなく、同じ話題が何度も出ていることが見えます。",
      },
      {
        title: "教員が観測を受け取る",
        body: "共有に同意した生徒の一覧と、安全に関する観測。",
        watchFor: "出るのは「観測された記述とその時刻」だけで、リスクの判定は表示しません。根拠のない観測は最初から出ません。",
      },
      {
        title: "生徒がサマリーを作り、共有を決める",
        body: "「サマリーを作る」を押し、内容を確認してから共有先を選びます。",
        watchFor: "共有されるのはこのサマリーだけで、日記やチャットの本文は送られません。共有後に「共有された支援サマリー」を開くと、担当者側に同じものが届いています。",
      },
      {
        title: "AIの処理をたどる",
        body: "抽出と安全性の確認が、いつ・どのモデルで動いたか。",
        watchFor: "残っているのはハッシュと構造化された情報だけで、日記の本文は含まれません。",
      },
    ],
    alsoTitle: "余裕があれば",
    also: [
      { label: "相談", body: "「消えてしまいたい」のような表現を入れると、決定的な安全判定が働いて人につなぐ応答に切り替わります。" },
      { label: "関係グラフ", body: "日記から取り出した内容のつながりを立体で見られます。" },
      { label: "変化のタイムライン", body: "最初の14日間は値を出さず、そのあとから比較が始まります。" },
      { label: "保護者の画面", body: "保護者に見えるのは提出状況と、本人が同意した範囲だけです。" },
    ],
    limitsTitle: "このデモで見えないこと",
    limits: [
      "音声入力と音声モードは動きません。マイクと OpenAI の接続が要るためです。",
      "AI の応答は固定文です。実際の応答はモデルが生成しますが、デモでは接続が切れても止まらないことを優先しています。",
      "最初の14日間に値が出ないのは不具合ではありません。変化の大きさは本人の記録14日分を待ちます。",
      "共有の状態はタブを閉じると消えます。次のデモは「何も共有していない」状態から始まります。",
    ],
  },

} as const;
